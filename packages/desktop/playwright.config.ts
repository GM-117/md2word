import { defineConfig } from '@playwright/test';

// M4 桌面 E2E：Playwright _electron 启动已构建的 main（dev 形态 + renderer dist 静态加载）
// 环境隔离：MD2WORD_USER_DATA 指向临时目录；MD2WORD_RENDERER_DIST 指向 renderer 构建产物
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1, // Electron 应用级测试：串行启动，避免单实例锁/GUI 资源竞争
  use: {
    locale: 'zh-CN',
  },
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
});
