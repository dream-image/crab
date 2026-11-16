import { capturePage } from '../lib/capture';
import { executeExtensionTool } from '../lib/browserTools';
import { isPageContextRequest } from '../shared/protocol';
import type { PageContextResponse } from '../shared/protocol';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isPageContextRequest(message)) return false;
    const envelope = {
      channel: message.channel, direction: 'response' as const, requestId: message.requestId,
    };
    const respond = (response: PageContextResponse) => sendResponse(response);
    if (message.action === 'ping') {
      respond({ ...envelope, ok: true, result: { ready: true } });
      return false;
    }
    if (message.action === 'browser-tool') {
      if (!message.call || !sender.tab) {
        respond({ ...envelope, ok: false, error: '浏览器工具需要从会话页面发起' });
        return false;
      }
      void executeExtensionTool(message.call, sender.tab).then((result) => respond({ ...envelope, ok: true, result }));
      return true;
    }
    // 网页只能读取发起请求的标签页；popup 由用户选择当前活动标签页。
    const popupTabId = (message as { tabId?: unknown }).tabId;
    const tabId = sender.tab?.id ?? (sender.url === chrome.runtime.getURL('popup.html') && typeof popupTabId === 'number' ? popupTabId : undefined);
    if (tabId === undefined) {
      respond({ ...envelope, ok: false, error: '无法确定当前标签页' });
      return false;
    }
    void capturePage(tabId).then(
      (result) => respond({ ...envelope, ok: true, result }),
      (error: unknown) => respond({ ...envelope, ok: false, error: error instanceof Error ? error.message : '读取页面失败' }),
    );
    return true;
  });
});
