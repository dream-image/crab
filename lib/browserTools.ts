import { PAGE_CONTEXT_MATCHES } from '../shared/protocol';
import type { BrowserToolCall, BrowserToolResult } from '../shared/protocol';
import { capturePage } from './capture';
import { send, withPageFrames } from './cdp';
import { loadReferences } from './references';

const CLICK_ELEMENT = `function() {
  if (!this.isConnected) throw new Error('元素已离开页面，请重新读取');
  if (!(this instanceof HTMLElement) || this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true') throw new Error('该元素无法点击');
  this.scrollIntoView({block:'center', inline:'nearest'});
  this.click();
  return {performed:true};
}`;
const FILL_ELEMENT = `function(text) {
  if (!this.isConnected) throw new Error('元素已离开页面，请重新读取');
  if (this instanceof HTMLInputElement && ['password','file','hidden'].includes(this.type)) throw new Error('不支持填写此类型的控件');
  if (this.matches(':disabled') || this.readOnly || this.getAttribute('aria-disabled') === 'true') throw new Error('该控件不可编辑');
  this.focus();
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    const prototype = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(this, text);
  } else if (this.isContentEditable) {
    this.textContent = text;
  } else throw new Error('该元素不是输入控件');
  this.dispatchEvent(new Event('input', {bubbles:true}));
  this.dispatchEvent(new Event('change', {bubbles:true}));
  return {performed:true};
}`;

async function performTool(call: BrowserToolCall, source: chrome.tabs.Tab): Promise<unknown> {
  const tabs = (await chrome.tabs.query({ windowId: source.windowId, url: PAGE_CONTEXT_MATCHES }))
    .filter((tab) => tab.id !== undefined);
  if (call.name === 'browser.tabs') {
    return {
      currentTabId: source.id,
      activeTabId: tabs.find((tab) => tab.active)?.id ?? null,
      tabs: tabs.map((tab) => ({ tabId: tab.id, title: tab.title || '', url: tab.url || '', active: tab.active })),
    };
  }
  // “当前页面”绑定会话发起页，不受工具调用期间用户切换标签页影响。
  const tabId = call.name === 'browser.snapshot' && call.params.tabId === undefined ? source.id : call.params.tabId;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || !tabs.some((tab) => tab.id === tabId)) {
    throw new Error('请先查看可读取页面，并使用当前窗口中的业务标签页 ID');
  }
  if (call.name === 'browser.snapshot') return capturePage(tabId, true);
  const { deltaY, text, ref, snapshotId } = call.params;
  if (call.name === 'browser.scroll' && (typeof deltaY !== 'number' || !Number.isFinite(deltaY) || Math.abs(deltaY) > 10000)) {
    throw new Error('deltaY 必须是 -10000 到 10000 之间的像素数');
  }
  if (call.name === 'browser.fill' && (typeof text !== 'string' || text.length > 20000)) {
    throw new Error('text 必须是最多 20000 字符的字符串');
  }
  const stored = ref === undefined && call.name === 'browser.scroll' ? undefined : await loadReferences(tabId, snapshotId);
  const reference = typeof ref === 'string' ? stored?.refs[ref] : undefined;
  if (stored && !reference) throw new Error('ref 不存在，请使用最新页面快照中的引用');
  return withPageFrames(tabId, async (frames) => {
    const root = [...frames.values()].find((frame) => !frame.parentId);
    if (!root) throw new Error('无法定位页面');
    if (!reference) {
      const response = await send(root.target, 'Runtime.evaluate', {
        expression: `window.scrollBy(0, ${deltaY}); ({performed:true})`, returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return { tabId, performed: true };
    }
    const frame = frames.get(reference.frameId);
    if (!frame || root.url !== stored?.url || frame.loaderId !== reference.loaderId) {
      throw new Error('页面已变化，请重新读取页面后再操作');
    }
    const resolved = await send(frame.target, 'DOM.resolveNode', { backendNodeId: reference.backendNodeId });
    const { objectId } = resolved.object;
    if (!objectId) throw new Error('元素已失效，请重新读取页面');
    try {
      const response = await send(frame.target, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: call.name === 'browser.click' ? CLICK_ELEMENT : call.name === 'browser.fill'
          ? FILL_ELEMENT : "function(deltaY) { if (!this.isConnected) throw new Error('元素已离开页面，请重新读取'); this.scrollBy(0, deltaY); return {performed:true}; }",
        arguments: call.name === 'browser.fill' ? [{ value: text }] : call.name === 'browser.scroll' ? [{ value: deltaY }] : [],
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return { tabId, ref, role: reference.role, name: reference.name, performed: true };
    } finally {
      await send(frame.target, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  });
}

/** 只提供具名能力，不接受由模型传入的任意 CDP 方法或 JavaScript。 */
export async function executeExtensionTool(call: BrowserToolCall, source: chrome.tabs.Tab): Promise<BrowserToolResult> {
  try {
    return { v: 1, id: call.id, name: call.name, ok: true, data: await performTool(call, source) };
  } catch (error) {
    return { v: 1, id: call.id, name: call.name, ok: false, error: error instanceof Error ? error.message : '页面工具调用失败' };
  }
}
