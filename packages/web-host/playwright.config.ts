import { defineConfig } from '@playwright/test';

// M2 Web 冒烟：web-host 静态托管 renderer dist（生产形态），单进程启动
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5199',
    locale: 'zh-CN',
  },
  webServer: {
    command: 'pnpm --filter @md2word/renderer build && pnpm exec tsx scripts/serve-e2e.ts',
    url: 'http://127.0.0.1:5199/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  reporter: [['list']],
});
