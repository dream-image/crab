export interface PageReference {
  frameId: string;
  backendNodeId: number;
  loaderId: string;
  role: string;
  name: string;
}

export interface SnapshotReferences {
  id: string;
  url: string;
  refs: Record<string, PageReference>;
}

const key = (tabId: number) => `maimai-page-refs:${tabId}`;

export async function saveReferences(tabId: number, snapshot: SnapshotReferences): Promise<void> {
  await chrome.storage.session.set({ [key(tabId)]: snapshot });
}

/** 会话存储跨 service worker 休眠保留；仅接受该标签页最近快照的引用。 */
export async function loadReferences(tabId: number, snapshotId: unknown): Promise<SnapshotReferences> {
  const stored = await chrome.storage.session.get(key(tabId));
  const snapshot = stored[key(tabId)] as SnapshotReferences | undefined;
  if (!snapshot || snapshot.id !== snapshotId) throw new Error('页面引用已过期，请重新读取页面');
  return snapshot;
}
