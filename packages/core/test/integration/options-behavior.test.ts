import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertMarkdown } from '../../src/convert.js';
import { openDocx } from '../../src/validate.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'md2word-opt-'));
});

afterEach(() => {
  // 保留目录以供失败排查由 CI 产物上传；本地测试产物体积小
});

function makeMd(name: string, text: string): string {
  const p = join(workDir, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

const SIMPLE = '# 标题\n\n正文段落。\n';

describe('P0 选项行为（集成）', () => {
  it('numberSections：标题段落注入 SectionNumber 字符样式运行', async () => {
    const src = makeMd('num.md', SIMPLE);
    const on = await convertMarkdown(src, { overwrite: true, numberSections: true });
    const off = await convertMarkdown(src, { overwrite: true, numberSections: false, outputDir: join(workDir, 'off') });
    expect(on.ok && off.ok).toBe(true);
    const onXml = openDocx(readFileSync(on.outputPath!)).contents!.documentXml;
    const offXml = openDocx(readFileSync(off.outputPath!)).contents!.documentXml;
    expect(onXml).toContain('w:rStyle w:val="SectionNumber"');
    expect(offXml).not.toContain('SectionNumber');
  });

  it('highlightStyle：指定 zenburn 时 styles.xml 含该高亮样式定义', async () => {
    const src = makeMd('hl.md', '# H\n\n```python\nx = 1\n```\n');
    const r = await convertMarkdown(src, { overwrite: true, highlightStyle: 'zenburn' });
    expect(r.ok).toBe(true);
    const styles = openDocx(readFileSync(r.outputPath!)).contents!.stylesXml ?? '';
    // zenburn 专属配色：背景 303030、关键字 f0dfaf（小写十六进制）
    expect(styles).toContain('303030');
    expect(styles).toContain('f0dfaf');
  });

  it('metadata 透传 → dc:title / dc:creator（值含冒号，已实证安全）', async () => {
    const src = makeMd('meta.md', SIMPLE);
    const r = await convertMarkdown(src, {
      overwrite: true,
      metadata: { title: '标题: 冒号版', author: '张三' },
    });
    expect(r.ok).toBe(true);
    const core = openDocx(readFileSync(r.outputPath!)).contents!.coreXml ?? '';
    expect(core).toContain('<dc:title>标题: 冒号版</dc:title>');
    expect(core).toContain('张三');
  });

  it('outputDir：输出落到指定目录（不存在时自动创建）', async () => {
    const src = makeMd('od.md', SIMPLE);
    const outDir = join(workDir, '新 输出 目录');
    const r = await convertMarkdown(src, { outputDir: outDir });
    expect(r.ok).toBe(true);
    expect(r.outputPath).toBe(join(outDir, 'od.docx'));
    expect(statSync(r.outputPath!).isFile()).toBe(true);
  });

  it('overwrite 默认 false → E_OUTPUT_EXISTS；true → 覆盖成功', async () => {
    const src = makeMd('ow.md', SIMPLE);
    const first = await convertMarkdown(src);
    expect(first.ok).toBe(true);
    const second = await convertMarkdown(src);
    expect(second.ok).toBe(false);
    expect(second.error!.code).toBe('E_OUTPUT_EXISTS');
    expect(second.durationMs).toBeLessThan(first.durationMs + 60_000);
    const third = await convertMarkdown(src, { overwrite: true });
    expect(third.ok).toBe(true);
  });

  it('离线模式：远程图被跳过并产生 W_IMAGE_OFFLINE（不联网、不静默）', async () => {
    const src = makeMd('offline.md', '# H\n\n![远程图](https://127.0.0.1:9/offline.png)\n');
    const r = await convertMarkdown(src, { overwrite: true, offline: true });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('W_IMAGE_OFFLINE');
    expect(r.stats!.images).toBe(0);
  });
});

describe('输入错误链路（§5.3 人话错误）', () => {
  it('E_SOURCE_NOT_FOUND', async () => {
    const r = await convertMarkdown(join(workDir, '不存在.md'));
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('E_SOURCE_NOT_FOUND');
    expect(r.error!.message).toContain('找不到源文件');
  });

  it('E_SOURCE_TOO_LARGE（>20MB）', async () => {
    const big = makeMd('big.md', 'x');
    writeFileSync(big, Buffer.alloc(21 * 1024 * 1024, 97));
    const r = await convertMarkdown(big);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('E_SOURCE_TOO_LARGE');
    expect(r.error!.message).toContain('20MB');
  });

  it('E_TEMPLATE_INVALID（垃圾文件当模板，pandoc 拒绝并归类）', async () => {
    const badTpl = join(workDir, 'bad-tpl.docx');
    writeFileSync(badTpl, 'not a zip');
    const src = makeMd('tpl.md', SIMPLE);
    const r = await convertMarkdown(src, { overwrite: true, referenceDocx: badTpl });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('E_TEMPLATE_INVALID');
    expect(r.error!.stderrTail).toContain('reference-doc');
  });

  it('E_TIMEOUT（1ms 超时 → 进程树被杀，不产生半成品）', async () => {
    const src = makeMd('slow.md', SIMPLE);
    const r = await convertMarkdown(src, { overwrite: true, timeoutMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('E_TIMEOUT');
    // 不留半成品：目标路径不存在
    expect(() => statSync(join(workDir, 'slow.docx'))).toThrow();
  });
});
