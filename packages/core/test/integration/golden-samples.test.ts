import { describe, expect, it } from 'vitest';
import { assertExpectation, convertSample, readExpected } from './helpers.js';

// M1 DoD②：黄金样例集（§5.2）全量转换 + document.xml 元素断言 100% 通过
const GOLDEN_SAMPLES = [
  'basic-zh.md',
  'tables-complex.md',
  'math-heavy.md',
  'images-local.md',
  'images-remote.md',
  'code-lang-missing.md',
  'yaml-metadata.md',
  'no-heading.md',
  'empty.md',
] as const;

describe.each(GOLDEN_SAMPLES)('黄金样例 %s', (sample) => {
  it('转换成功且符合 expected.json 断言', async () => {
    const expected = readExpected(sample);
    const { result, docx } = await convertSample(sample);
    assertExpectation(expected, result, docx);
    expect(result.durationMs, '单文件耗时应记录').toBeGreaterThan(0);
  });
});

describe('黄金样例 cjk-path（中文+空格+emoji 路径，M1 DoD③）', () => {
  it('文件路径/图片路径全链路转换', async () => {
    const rel = 'cjk-path/中文 目录 🎬/中文 文件名 🇨🇳.md';
    const expected = readExpected(rel.replace(/\.md$/, ''));
    const { result, docx } = await convertSample(rel);
    assertExpectation(expected, result, docx);
    // 输出文件名与源同名（.docx），保留全部特殊字符
    expect(result.outputPath!).toContain('中文 文件名 🇨🇳.docx');
  });
});

describe('TOC 域与目录指令（§4.5）', () => {
  it('--toc 生成 instrText TOC 域 + W_TOC_FIELD 提示', async () => {
    const { result, docx } = await convertSample('basic-zh.md', { toc: true, tocDepth: 2 });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('W_TOC_FIELD');
    const instr = docx.contents!.documentXml.match(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g)?.join('\n') ?? '';
    expect(instr).toContain('TOC');
    // tocDepth=2 → TOC \o "1-2"
    expect(instr).toContain('1-2');
  });

  it('未启用 toc 时不得出现 TOC 域', async () => {
    const { result, docx } = await convertSample('basic-zh.md');
    expect(result.ok).toBe(true);
    const instr = docx.contents!.documentXml.match(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g)?.join('\n') ?? '';
    expect(instr).not.toContain('TOC');
  });
});
