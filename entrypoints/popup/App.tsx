import { useState } from 'react';
import { PAGE_CONTEXT_CHANNEL, isPageSnapshot } from '../../shared/protocol';
import type { PageContextResponse, PageSnapshot } from '../../shared/protocol';
import './App.css';

function App() {
  const [pending, setPending] = useState(false);
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [error, setError] = useState('');

  const handleReadPage = async () => {
    setPending(true);
    setError('');
    setSnapshot(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('无法确定当前标签页');
      const response: PageContextResponse = await chrome.runtime.sendMessage({
        channel: PAGE_CONTEXT_CHANNEL, direction: 'request', requestId: crypto.randomUUID(),
        action: 'snapshot', tabId: tab.id,
      });
      if (!response.ok) throw new Error(response.error);
      if (!isPageSnapshot(response.result)) throw new Error('未能获取页面快照');
      setSnapshot(response.result);
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取页面失败');
    } finally {
      setPending(false);
    }
  };

  return (
    <main>
      <header>
        <img src="/icon/48.png" width="28" height="28" alt="" />
        <h1>麦麦助手</h1>
      </header>
      <p>让麦麦结合页面内容，为你解答业务问题。</p>
      <p className="hint">在对话框输入 /，选择“开启页面读取”；侧边栏可直接选择“读取当前页面”。</p>
      <button type="button" disabled={pending} onClick={() => void handleReadPage()}>
        {pending ? '正在读取页面…' : '预览页面内容'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {snapshot && <section aria-label="页面快照">
        <h2>{snapshot.title}</h2>
        <p className="url">{snapshot.url}</p>
        <p>{snapshot.nodeCount} 个节点{snapshot.truncated ? ' · 内容已截取' : ''}
          {snapshot.inaccessibleFrames ? ` · ${snapshot.inaccessibleFrames} 个内嵌页未采集` : ''}</p>
        <pre>{snapshot.tree}</pre>
      </section>}
    </main>
  );
}

export default App;
