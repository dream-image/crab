import { isPageContextRequest, PAGE_CONTEXT_MATCHES, PAGE_CONTEXT_PROTOCOL_VERSION } from '../shared/protocol';
import type { PageContextResponse } from '../shared/protocol';

export default defineContentScript({
  matches: PAGE_CONTEXT_MATCHES,
  allFrames: true,
  runAt: 'document_start',
  main(ctx) {
    // 保留当前内容脚本的版本，扩展更新使旧上下文失效时仍能引导用户更新、刷新。
    const extensionInfo = {
      extensionVersion: chrome.runtime.getManifest().version,
      protocolVersion: PAGE_CONTEXT_PROTOCOL_VERSION,
    };
    ctx.addEventListener(window, 'message', async (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== location.origin || !isPageContextRequest(event.data)) return;
      const request = event.data;
      try {
        const response: PageContextResponse | undefined = await chrome.runtime.sendMessage(request);
        if (!response) throw new Error('插件未响应，请检查当前站点的访问权限并刷新页面');
        window.postMessage({ ...response, ...extensionInfo }, location.origin);
      } catch (error) {
        window.postMessage({
          channel: request.channel, direction: 'response', requestId: request.requestId,
          ...extensionInfo,
          ok: false, error: error instanceof Error ? error.message : '扩展连接失败，请刷新页面',
        } satisfies PageContextResponse, location.origin);
      }
    });
  },
});
