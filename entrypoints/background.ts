import { capturePage } from '../lib/capture';
import { executeExtensionTool } from '../lib/browserTools';
import { isPageContextRequest } from '../shared/protocol';
import type { PageContextResponse } from '../shared/protocol';

/** 只信任浏览器提供的发起 frame URL，不使用消息参数或顶层标签页 URL。 */
function isAllowedPageUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === 'https:' || protocol === 'http:') &&
      (hostname === 'kuaishou.com' || hostname.endsWith('.kuaishou.com'));
  } catch {
    return false;
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isPageContextRequest(message)) return false;
    // popup 的本地预览不属于网页请求；其他来源必须是快手域名页面。
    const isPopup = !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
    if (!isPopup && (!sender.tab || !isAllowedPageUrl(sender.url))) return false;
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
    const tabId = sender.tab?.id ?? (isPopup && typeof popupTabId === 'number' ? popupTabId : undefined);
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
