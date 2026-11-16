export const PAGE_CONTEXT_CHANNEL = 'maimai-page-context/v1';

export const PAGE_CONTEXT_MATCHES = [
  'https://*.kuaishou.com/*',
  'http://*.prt.kuaishou.com/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
];

export interface PageSnapshot {
  source: 'cdp-accessibility';
  tabId: number;
  snapshotId: string;
  title: string;
  url: string;
  /** 快照采集完成时间，Unix 毫秒时间戳。 */
  capturedAt: number;
  /** 精简后的原生 AX 树，最多 20,000 UTF-8 字节，语义深度不超过 10。 */
  tree: string;
  nodeCount: number;
  truncated: boolean;
  inaccessibleFrames: number;
}

export const BROWSER_TOOL_NAMES = [
  'browser.tabs', 'browser.snapshot', 'browser.click', 'browser.fill', 'browser.scroll',
] as const;
export type BrowserToolName = typeof BROWSER_TOOL_NAMES[number];

export interface BrowserToolCall {
  v: 1;
  id: string;
  name: BrowserToolName;
  params: Record<string, unknown>;
}

export interface BrowserToolResult {
  v: 1;
  id: string;
  name: BrowserToolName;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function isBrowserToolCall(value: unknown): value is BrowserToolCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<BrowserToolCall>;
  return call.v === 1 && typeof call.id === 'string' && /^[\w-]{1,80}$/.test(call.id) &&
    BROWSER_TOOL_NAMES.some((name) => name === call.name) && Boolean(call.params) &&
    typeof call.params === 'object' && !Array.isArray(call.params);
}

export interface PageContextRequest {
  channel: typeof PAGE_CONTEXT_CHANNEL;
  direction: 'request';
  requestId: string;
  action: 'ping' | 'snapshot' | 'browser-tool';
  call?: BrowserToolCall;
}

export type PageContextResult = { ready: true } | PageSnapshot | BrowserToolResult;

export type PageContextResponse = {
  channel: typeof PAGE_CONTEXT_CHANNEL;
  direction: 'response';
  requestId: string;
} & ({ ok: true; result: PageContextResult } | { ok: false; error: string });

export function isPageContextRequest(value: unknown): value is PageContextRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<PageContextRequest>;
  return request.channel === PAGE_CONTEXT_CHANNEL && request.direction === 'request' &&
    typeof request.requestId === 'string' && request.requestId.length <= 100 &&
    (request.action === 'ping' || request.action === 'snapshot' ||
      (request.action === 'browser-tool' && isBrowserToolCall(request.call)));
}

export function isPageSnapshot(value: unknown): value is PageSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<PageSnapshot>;
  return snapshot.source === 'cdp-accessibility' && typeof snapshot.tree === 'string' &&
    typeof snapshot.tabId === 'number' && typeof snapshot.snapshotId === 'string' &&
    typeof snapshot.title === 'string' && typeof snapshot.url === 'string' &&
    typeof snapshot.capturedAt === 'number' && typeof snapshot.nodeCount === 'number' &&
    typeof snapshot.truncated === 'boolean' && typeof snapshot.inaccessibleFrames === 'number';
}
