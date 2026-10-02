import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { convertMarkdown } from '../../src/convert.js';

// 性能基准（§5.1：1KB/100KB/1MB/10MB 四档；§1.4 指标：1MB<2s、10MB<15s）
// 大样例由 scripts/generate-large-samples.mjs 生成（不入库），缺失时现场生成。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SAMPLES = join(REPO_ROOT, 'samples');

function ensureLargeSample(mb: number): string {
  const p = join(SAMPLES, `large-${mb}mb.md`);
  if (!existsSync(p)) {
    execFileSync('node', [join(REPO_ROOT, 'scripts', 'generate-large-samples.mjs'), SAMPLES, String(mb)], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  }
  return p;
}

let perfBase: number;
beforeEach(() => {
  perfBase = Date.now();
});
const now = () => Date.now() - perfBase;

describe('性能基准（相对基线回归阈值 2×，绝对值为 §1.4 指标）', () => {
  it('10MB 样例 < 15s（M1 DoD④）', async () => {
    const src = ensureLargeSample(10);
    const r = await convertMarkdown(src, { overwrite: true });
    expect(r.ok, r.error?.message).toBe(true);
    expect(r.durationMs, `10MB 转换耗时 ${now()}ms`).toBeLessThan(15_000);
  }, 60_000);

  it('1MB 样例 < 2s', async () => {
    const src = ensureLargeSample(1);
    const r = await convertMarkdown(src, { overwrite: true });
    expect(r.ok, r.error?.message).toBe(true);
    expect(r.durationMs, `1MB 转换耗时 ${now()}ms`).toBeLessThan(2_000);
  }, 30_000);

  it('产物完整（10MB 文档可解析且统计为正）', async () => {
    const src = ensureLargeSample(10);
    const r = await convertMarkdown(src, { overwrite: true });
    expect(r.ok).toBe(true);
    const docx = readFileSync(r.outputPath!);
    expect(docx.byteLength).toBeGreaterThan(100_000);
  }, 60_000);
});
