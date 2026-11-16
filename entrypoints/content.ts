import { isPageContextRequest, PAGE_CONTEXT_MATCHES } from '../shared/protocol';
import type { PageContextResponse } from '../shared/protocol';

export default defineContentScript({
  matches: PAGE_CONTEXT_MATCHES,
  allFrames: true,
  runAt: 'document_start',
  main(ctx) {
    ctx.addEventListener(window, 'message', (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== location.origin || !isPageContextRequest(event.data)) return;
      const request = event.data;
      void chrome.runtime.sendMessage(request).then(
        (response: PageContextResponse) => window.postMessage(response, location.origin),
        (error: unknown) => window.postMessage({
          channel: request.channel, direction: 'response', requestId: request.requestId,
          ok: false, error: error instanceof Error ? error.message : '扩展连接失败，请刷新页面',
        } satisfies PageContextResponse, location.origin),
      );
    });
  },
});
