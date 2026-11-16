import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping';

export type Target = chrome.debugger.DebuggerSession;
export type PageFrame = Protocol.Page.Frame & { target: Target; sessionRoot: boolean };
type Command = keyof ProtocolMapping.Commands;
const activeTabs = new Set<number>();

export function send<K extends Command>(
  target: Target, method: K, params?: ProtocolMapping.Commands[K]['paramsType'][0],
): Promise<ProtocolMapping.Commands[K]['returnType']> {
  return chrome.debugger.sendCommand(target, method, params as Record<string, unknown> | undefined) as Promise<ProtocolMapping.Commands[K]['returnType']>;
}

/** 读取和操作共用连接生命周期；每次重新定位 frame，所有终止路径均释放调试连接。 */
export async function withPageFrames<T>(tabId: number, operation: (frames: Map<string, PageFrame>) => Promise<T>): Promise<T> {
  if (activeTabs.has(tabId)) throw new Error('当前页面正在处理，请稍候');
  activeTabs.add(tabId);
  let attached = false;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const root: Target = { tabId };
  const targets = new Map<string, Target>([['main', root]]);
  const setup: Promise<unknown>[] = [];
  const configure = (target: Target) => send(target, 'Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    filter: [{ type: 'iframe', exclude: false }],
  });
  const handleEvent = (source: Target, method: string, params?: object) => {
    if (source.tabId !== tabId || method !== 'Target.attachedToTarget') return;
    const event = params as Protocol.Target.AttachedToTargetEvent;
    if (event.targetInfo.type !== 'iframe') return;
    const target = { tabId, sessionId: event.sessionId };
    targets.set(event.sessionId, target);
    setup.push(configure(target).catch(() => undefined));
  };
  const run = async () => {
    await chrome.debugger.attach(root, '1.3');
    if (ended) {
      await chrome.debugger.detach(root).catch(() => undefined);
      throw new Error('页面连接已取消');
    }
    attached = true;
    chrome.debugger.onEvent.addListener(handleEvent);
    await configure(root);
    for (let index = 0; index < setup.length; index += 1) await setup[index];
    const frames = new Map<string, PageFrame>();
    for (const target of targets.values()) {
      const page = await send(target, 'Page.getFrameTree').catch((error: unknown) => {
        if (!target.sessionId) throw error;
        return undefined;
      });
      if (!page) continue;
      const visit = (tree: Protocol.Page.FrameTree) => {
        const existing = frames.get(tree.frame.id);
        if (!existing || tree === page.frameTree) {
          frames.set(tree.frame.id, { ...tree.frame, parentId: tree.frame.parentId ?? existing?.parentId, target, sessionRoot: tree === page.frameTree });
        }
        tree.childFrames?.forEach(visit);
      };
      visit(page.frameTree);
    }
    if (ended) throw new Error('页面连接已取消');
    return operation(frames);
  };
  try {
    return await Promise.race([
      run(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('页面处理超时，请重试')), 25000);
      }),
    ]);
  } finally {
    ended = true;
    clearTimeout(timer);
    chrome.debugger.onEvent.removeListener(handleEvent);
    if (attached) await chrome.debugger.detach(root).catch(() => undefined);
    activeTabs.delete(tabId);
  }
}
