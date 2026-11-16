import type { Protocol } from 'devtools-protocol';
import init, { compact_snapshot } from '../rust/pkg/maimai_snapshot';
import wasmUrl from '../rust/pkg/maimai_snapshot_bg.wasm?url';
import type { PageSnapshot } from '../shared/protocol';
import { send, withPageFrames } from './cdp';
import type { Target, PageFrame } from './cdp';
import { saveReferences } from './references';
import type { PageReference } from './references';

interface DomMetadata {
  excluded: Set<number>;
  protected: Set<number>;
  excludedFrames: Set<string>;
  frameOwners: Map<string, number>;
}

interface CapturedFrame {
  frameId: string;
  parentFrameId?: string;
  ownerBackendNodeId?: number;
  name: string;
  url: string;
  nodes: Protocol.Accessibility.AXNode[];
  excludedBackendNodeIds: number[];
  protectedBackendNodeIds: number[];
}

interface CompactSnapshot {
  tree: string;
  nodeCount: number;
  truncated: boolean;
}

let wasmReady: Promise<unknown> | undefined;

/** 每个 CDP target 批量读取一次 DOM 元数据，再本地定位助手子树及密码控件。 */
function collectDomMetadata(root: Protocol.DOM.Node): DomMetadata {
  const result: DomMetadata = {
    excluded: new Set(), protected: new Set(), excludedFrames: new Set(), frameOwners: new Map(),
  };
  const pending = [{ node: root, excluded: false, protected: false }];
  while (pending.length) {
    const entry = pending.pop()!;
    const { node } = entry;
    const attributes = new Map<string, string>();
    const values = node.attributes ?? [];
    for (let index = 0; index + 1 < values.length; index += 2) {
      attributes.set(values[index]!, values[index + 1]!);
    }
    const excluded = entry.excluded || attributes.has('data-maimai-assistant') || attributes.has('data-slate-command-menu');
    const protectedInput = entry.protected || (node.nodeName === 'INPUT' && attributes.get('type')?.toLowerCase() === 'password');
    if (excluded) result.excluded.add(node.backendNodeId);
    if (protectedInput) result.protected.add(node.backendNodeId);
    if (node.frameId && (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME')) {
      result.frameOwners.set(node.frameId, node.backendNodeId);
      if (excluded) result.excludedFrames.add(node.frameId);
    }
    const children = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
    if (node.contentDocument) children.push(node.contentDocument);
    for (const child of children) pending.push({ node: child, excluded, protected: protectedInput });
  }
  return result;
}

/** 批量取得各 frame 的 AX 数据；网页版快照额外提供可操作元素引用。 */
export async function capturePage(tabId: number, includeReferences = false): Promise<PageSnapshot> {
  return withPageFrames(tabId, async (frames) => {
    const snapshotId = crypto.randomUUID();
    const references: Record<string, PageReference> = {};
    const metadata = new Map<Target, DomMetadata>();
    const owners = new Map<string, number>();
    const rootFrame = [...frames.values()].find((frame) => !frame.parentId);
    if (!rootFrame) throw new Error('无法读取页面主 frame');
    const targets = new Set([...frames.values()].map((frame) => frame.target));
    for (const target of targets) {
      const dom = await send(target, 'DOM.getDocument', { depth: -1, pierce: true }).catch((error: unknown) => {
        if (!target.sessionId) throw error;
        return undefined;
      });
      if (!dom) continue;
      const data = collectDomMetadata(dom.root);
      metadata.set(target, data);
      data.frameOwners.forEach((id, frameId) => owners.set(frameId, id));
    }
    const excludedFrames = new Set([...metadata.values()].flatMap((data) => [...data.excludedFrames]));
    const isExcluded = (frame: PageFrame): boolean => {
      let current: PageFrame | undefined = frame;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        if (excludedFrames.has(current.id)) return true;
        seen.add(current.id);
        current = current.parentId ? frames.get(current.parentId) : undefined;
      }
      return false;
    };
    let inaccessibleFrames = 0;
    let nextRef = 1;
    const captured = await Promise.all([...frames.values()].filter((frame) => !isExcluded(frame)).map(async (frame): Promise<CapturedFrame | undefined> => {
      try {
        const data = metadata.get(frame.target);
        if (!data) throw new Error('无法读取 frame 元数据');
        const { nodes } = await send(frame.target, 'Accessibility.getFullAXTree',
          frame.target.sessionId && frame.sessionRoot ? {} : { frameId: frame.id });
        const referencedNodes = nodes.map((node) => {
          const role: unknown = node.role?.value;
          const backendId = node.backendDOMNodeId;
          if (!includeReferences || !backendId || node.ignored || data.excluded.has(backendId) || data.protected.has(backendId) ||
            typeof role !== 'string' || ['RootWebArea', 'WebArea', 'generic', 'none', 'presentation', 'StaticText', 'InlineTextBox'].includes(role)) return node;
          const ref = `e${nextRef++}`;
          references[ref] = {
            frameId: frame.id, backendNodeId: backendId, loaderId: frame.loaderId,
            role, name: typeof node.name?.value === 'string' ? node.name.value : '',
          };
          return { ...node, ref };
        });
        return {
          frameId: frame.id, parentFrameId: frame.parentId, ownerBackendNodeId: owners.get(frame.id),
          name: frame.name ?? '', url: frame.url, nodes: referencedNodes,
          excludedBackendNodeIds: [...data.excluded], protectedBackendNodeIds: [...data.protected],
        };
      } catch (error) {
        if (frame.id === rootFrame.id) throw error;
        inaccessibleFrames += 1;
        return undefined;
      }
    }));
    const available = captured.filter((frame): frame is CapturedFrame => Boolean(frame));
    const availableIds = new Set(available.map((frame) => frame.frameId));
    available.forEach((frame) => {
      if (frame.parentFrameId && !availableIds.has(frame.parentFrameId)) frame.parentFrameId = undefined;
    });
    if (!wasmReady) wasmReady = init({ module_or_path: wasmUrl }).catch((error: unknown) => {
      wasmReady = undefined;
      throw error;
    });
    await wasmReady;
    const compact = JSON.parse(compact_snapshot(JSON.stringify({ frames: available }))) as CompactSnapshot;
    if (!compact.nodeCount) throw new Error('此页面没有可读取的业务内容；若当前是麦麦会话页，请选择要读取的业务页面');
    await saveReferences(tabId, { id: snapshotId, url: rootFrame.url, refs: references });
    const mainFrame = available.find((frame) => frame.frameId === rootFrame.id);
    const title: unknown = mainFrame?.nodes[0]?.name?.value;
    return {
      source: 'cdp-accessibility', tabId, snapshotId,
      title: typeof title === 'string' ? title : '当前页面',
      url: rootFrame.url, capturedAt: Date.now(), ...compact, inaccessibleFrames,
    };
  });
}
