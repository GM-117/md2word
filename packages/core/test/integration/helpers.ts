import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { convertMarkdown } from '../../src/convert.js';
import { openDocx } from '../../src/validate.js';
import type { ConvertOptions, ConvertResult, ConvertStats } from '../../src/types.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const SAMPLES_DIR = join(REPO_ROOT, 'samples');

export interface SampleExpectation {
  description?: string;
  ok: boolean;
  /** 部分键断言：仅校验列出的统计项 */
  stats?: Record<string, number>;
  /** 这些 warning code 必须出现 */
  warningsIncludeCodes?: string[];
  /** 这些 warning code 不得出现 */
  warningsExcludeCodes?: string[];
  /** docx 核心属性断言（dc:title / dc:creator） */
  metadata?: { title?: string; author?: string };
}

export function readExpected(sampleName: string): SampleExpectation {
  const stem = sampleName.replace(/\.md$/i, '');
  return JSON.parse(readFileSync(join(SAMPLES_DIR, `${stem}.expected.json`), 'utf8')) as SampleExpectation;
}

/** 转换样例到临时输出目录（避免污染 samples/），返回结果与 docx 内容 */
export async function convertSample(
  sampleRelPath: string,
  opts: Omit<ConvertOptions, 'outputDir' | 'overwrite'> & { overwrite?: boolean } = {},
): Promise<{ result: ConvertResult; docx: ReturnType<typeof openDocx> }> {
  const srcPath = join(SAMPLES_DIR, sampleRelPath);
  const result = await convertMarkdown(srcPath, { overwrite: true, ...opts });
  if (!result.ok || !result.outputPath) {
    return { result, docx: { ok: false, reason: '转换失败，无产物可校验' } };
  }
  const buf = readFileSync(result.outputPath);
  return { result, docx: openDocx(buf) };
}

/** 断言转换结果符合 expected.json 口径 */
export function assertExpectation(
  expected: SampleExpectation,
  result: ConvertResult,
  docx: ReturnType<typeof openDocx>,
): void {
  expect(result.ok, `转换应成功：${result.error?.message ?? ''}`).toBe(expected.ok);
  if (!expected.ok) return;

  const doc = docx.ok ? docx.contents! : undefined;
  expect(doc, '产物应为合法 docx（zip 完整 + document.xml）').toBeTruthy();

  if (expected.stats) {
    for (const [key, want] of Object.entries(expected.stats)) {
      expect(result.stats?.[key as keyof ConvertStats], `${key} 统计`).toBe(want);
    }
  }
  const codes = result.warnings.map((w) => w.code);
  for (const c of expected.warningsIncludeCodes ?? []) {
    expect(codes, `应包含 warning ${c}`).toContain(c);
  }
  for (const c of expected.warningsExcludeCodes ?? []) {
    expect(codes, `不应包含 warning ${c}`).not.toContain(c);
  }
  if (expected.metadata?.title !== undefined) {
    const coreXml = doc!.coreXml ?? '';
    expect(coreXml).toContain(`<dc:title>${expected.metadata.title}</dc:title>`);
  }
  if (expected.metadata?.author !== undefined) {
    const coreXml = doc!.coreXml ?? '';
    expect(coreXml).toContain(expected.metadata.author);
  }
}
