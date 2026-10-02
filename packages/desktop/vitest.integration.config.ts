import { defineConfig } from 'vitest/config';

// 集成测试：真实 pandoc，直驱 services 层（不经 Electron / IPC）
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
