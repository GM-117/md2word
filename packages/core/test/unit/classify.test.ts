import { describe, expect, it } from 'vitest';
import { classifyFailure, classifyStderr } from '../../src/convert.js';

// §5.3 错误分类表——stderr → 人话 warnings
describe('classifyStderr', () => {
  it('Could not fetch resource → W_IMAGE_FETCH（捕获资源 URL）', () => {
    const stderr = '[WARNING] Could not fetch resource http://127.0.0.1:9/x.png, skipping:\nCould not fetch resource http://127.0.0.1:9/x.png';
    const ws = classifyStderr(stderr);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.code).toBe('W_IMAGE_FETCH');
    expect(ws[0]!.detail).toBe('http://127.0.0.1:9/x.png');
    expect(ws[0]!.message).toContain('http://127.0.0.1:9/x.png');
  });

  it('Could not convert TeX math → W_MATH', () => {
    const stderr = '[WARNING] Could not convert TeX math \\notacommand{x}, rendering as TeX:\n  \\notacommand{x}';
    const ws = classifyStderr(stderr);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.code).toBe('W_MATH');
    expect(ws[0]!.detail).toBe('\\notacommand{x}');
  });

  it('离线过滤器标记 → W_IMAGE_OFFLINE', () => {
    const stderr = '[MD2WORD] OFFLINE-IMAGE-SKIPPED: https://example.com/a.png\n[MD2WORD] OFFLINE-IMAGE-SKIPPED: https://example.com/b.png';
    const ws = classifyStderr(stderr);
    expect(ws).toHaveLength(2);
    expect(ws.map((w) => w.code)).toEqual(['W_IMAGE_OFFLINE', 'W_IMAGE_OFFLINE']);
  });

  it('同类重复资源去重', () => {
    const stderr = 'Could not fetch resource http://x/a.png\nCould not fetch resource http://x/a.png';
    expect(classifyStderr(stderr)).toHaveLength(1);
  });

  it('空 stderr → 无 warnings', () => {
    expect(classifyStderr('')).toHaveLength(0);
  });

  it('无关 stderr 不产生 warnings', () => {
    expect(classifyStderr('[WARNING] Deprecated: --latexmath')).toHaveLength(0);
  });
});

describe('classifyFailure 失败细分', () => {
  it('reference-doc 相关 → E_TEMPLATE_INVALID', () => {
    expect(classifyFailure('Error: could not read reference-doc /bad.docx')).toBe('E_TEMPLATE_INVALID');
    expect(classifyFailure('template file is corrupt')).toBe('E_TEMPLATE_INVALID');
  });

  it('其他 → E_PANDOC_FAILED', () => {
    expect(classifyFailure('Error at source position')).toBe('E_PANDOC_FAILED');
    expect(classifyFailure('')).toBe('E_PANDOC_FAILED');
  });
});
