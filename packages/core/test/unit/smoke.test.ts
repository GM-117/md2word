import { describe, expect, it } from 'vitest';

// M0 冒烟：验证 vitest 基础设施可用。M1 起由模块级单测取代。
describe('M0 测试基建冒烟', () => {
  it('vitest 正常运行', () => {
    expect(1 + 1).toBe(2);
  });
});
