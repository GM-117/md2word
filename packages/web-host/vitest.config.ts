import { defineConfig } from 'vitest/config';

// web-host API 集成测试；Playwright e2e 独立由 playwright.config.ts 管理
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    reporters: 'default',
  },
});
