import { defineConfig } from 'vitest/config';

// 单元测试：纯逻辑（services / resourceUrl），无 Electron 运行时、无 pandoc 依赖
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
