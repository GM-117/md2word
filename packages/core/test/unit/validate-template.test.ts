import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { augmentTemplateStyles, getBundledReferenceDocx, validateTemplate } from '../../src/template.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'word-resaved-template.docx');
const BUILTIN = getBundledReferenceDocx()!;

// D32 回归：用户用 Word 修改「内置中文模板」导出件后导入被拒（实际 12 项样式全部存在）。
// Word 保存会重写样式标识：内置样式名转小写规范名（heading 1）、styleId 改数字（Heading1→2）、
// 自定义样式名可能去空格（Source Code→SourceCode）。校验必须归一化匹配。

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'md2word-tpl-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeAsFile(bytes: Uint8Array): string {
  const p = join(tmp, `synth-${Math.random().toString(36).slice(2, 8)}.docx`);
  writeFileSync(p, bytes);
  return p;
}

describe('validateTemplate 归一化匹配（D32）', () => {
  it('真实 Word 回存模板（用户实测被误拒的文件）应通过校验', () => {
    expect(validateTemplate(FIXTURE)).toEqual({ ok: true, missingStyles: [] });
  });

  it('合成用例：小写规范名 + 数字 styleId + 无空格样式名均可识别，未提供的项仍报缺', () => {
    const stylesXml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="17"><w:name w:val="footnote text"/></w:style>
      <w:style w:type="paragraph" w:styleId="51"><w:name w:val="SourceCode"/></w:style>
      <w:style w:type="character" w:styleId="52"><w:name w:val="VerbatimChar"/></w:style>
    </w:styles>`;
    const docx = writeAsFile(zipSync({
      'word/styles.xml': strToU8(stylesXml),
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'),
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    }));
    const r = validateTemplate(docx);
    expect(r.ok).toBe(false);
    expect(r.missingStyles).toEqual([
      'Block Text', 'Hyperlink', 'Table', 'First Paragraph', 'Body Text', 'Compact', 'Image Caption', 'Table Caption',
    ]);
  });

  it('完全缺失样式 → 报缺全部 12 项（不放水）', () => {
    const docx = writeAsFile(zipSync({
      'word/styles.xml': strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'),
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'),
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    }));
    const r = validateTemplate(docx);
    expect(r.ok).toBe(false);
    expect(r.missingStyles).toHaveLength(12);
  });
});

describe('augmentTemplateStyles（pandoc 默认模板导出补齐，D32）', () => {
  it('从内置模板注入缺失样式后可通过校验', () => {
    // 构造缺 Source Code 的模板（取内置模板并删除其 SourceCode 样式块）
    const files = unzipSync(new Uint8Array(readFileSync(BUILTIN)));
    const stylesXml = new TextDecoder().decode(files['word/styles.xml']);
    const stripped = stylesXml.replace(/<w:style [^>]*w:styleId="SourceCode"[\s\S]*?<\/w:style>/, '');
    const strippedPath = writeAsFile(zipSync({ ...files, 'word/styles.xml': strToU8(stripped) }));
    expect(validateTemplate(strippedPath).ok).toBe(false); // 前置：确实缺

    const augmented = augmentTemplateStyles(new Uint8Array(readFileSync(strippedPath)), BUILTIN);
    const augmentedPath = writeAsFile(augmented);
    expect(validateTemplate(augmentedPath)).toEqual({ ok: true, missingStyles: [] });
  });

  it('无缺失时原样返回（不重写文件）', () => {
    const bytes = new Uint8Array(readFileSync(BUILTIN));
    const out = augmentTemplateStyles(bytes, BUILTIN);
    expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
  });
});
