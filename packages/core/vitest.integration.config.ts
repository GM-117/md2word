import { defineConfig } from 'vitest/config';

// 集成测试：真实 pandoc sidecar + 黄金样例集。前置：pnpm fetch:pandoc 已就位二进制。
export default defineConfig({
  test: {
    name: 'core-integration',
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: 'default',
    // 集成测试串行执行，避免并发 pandoc 干扰计时断言
    fileParallelism: false,
  },
});
