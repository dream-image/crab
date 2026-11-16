import { defineConfig } from 'wxt';
import { PAGE_CONTEXT_MATCHES } from './shared/protocol';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: { disabled: true },
  manifest: {
    name: '麦麦助手',
    short_name: 'crab',
    description: '连接麦麦助手，读取页面内容，让业务问答更有依据',
    action: {
      default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    },
    minimum_chrome_version: '125',
    permissions: ['debugger', 'activeTab', 'storage'],
    host_permissions: PAGE_CONTEXT_MATCHES,
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
