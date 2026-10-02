import { defineConfig } from 'vitest/config';

// 覆盖率统计：单元 + 集成合并（门禁：core src ≥ 85%，§5.1）
export default defineConfig({
  test: {
    name: 'core-coverage',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: 'default',
    fileParallelism: false,
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 85,
        functions: 80,
        statements: 85,
        branches: 70,
      },
    },
  },
});
