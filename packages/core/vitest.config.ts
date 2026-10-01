import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core-unit',
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // 快照测试锁定参数构建器输出；CI 与本地一致
    reporters: 'default',
  },
});
