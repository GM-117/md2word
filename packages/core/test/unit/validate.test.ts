import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { computeStats, openDocx, hasNamedStyle } from '../../src/validate.js';
import { REQUIRED_STYLES, validateTemplate } from '../../src/template.js';

const SAMPLE_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="SourceCode"/></w:pPr><w:r><w:t>code</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>
<w:p><m:oMathPara><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></m:oMathPara></w:p>
<w:p><w:r><wp:inline/></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>
</body></w:document>`;

const SAMPLE_FOOTNOTES = `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote>
<w:footnote w:id="2"><w:p><w:r><w:t>脚注内容</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

function zipDocx(entries: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));
}

function buildStylesXml(styleIds: string[]): string {
  return `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${styleIds.map((id) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/></w:style>`).join('\n')}
</w:styles>`;
}

function writeTempDocx(buf: Uint8Array, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

describe('openDocx zip 完整性与部件校验', () => {
  it('合法 docx：解析出 document/styles/footnotes', () => {
    const r = openDocx(zipDocx({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': SAMPLE_DOCUMENT,
      'word/styles.xml': buildStylesXml(['Heading1']),
      'word/footnotes.xml': SAMPLE_FOOTNOTES,
    }));
    expect(r.ok).toBe(true);
    expect(r.contents!.documentXml).toContain('Heading1');
    expect(r.contents!.footnotesXml).toContain('脚注内容');
  });

  it('非 zip 数据 → 拒绝', () => {
    const r = openDocx(new TextEncoder().encode('not a zip at all........'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('zip');
  });

  it('缺 document.xml → 拒绝', () => {
    const r = openDocx(zipDocx({ '[Content_Types].xml': '<Types/>' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('document.xml');
  });
});

describe('computeStats document.xml 元素断言', () => {
  const stats = computeStats(SAMPLE_DOCUMENT, SAMPLE_FOOTNOTES);

  it('headings=1 tables=1 codeBlocks=1', () => {
    expect(stats.headings).toBe(1);
    expect(stats.tables).toBe(1);
    expect(stats.codeBlocks).toBe(1);
  });

  it('math=2（oMath 与 oMathPara 内的 oMath，不因 oMathPara 前缀重复计数）', () => {
    expect(stats.math).toBe(2);
  });

  it('images=1（wp:inline 现代表示，与 pandoc 兼容 fallback 无关）', () => {
    expect(stats.images).toBe(1);
  });

  it('footnotes=1（separator 脚注不计）', () => {
    expect(stats.footnotes).toBe(1);
  });
});

describe('validateTemplate 模板校验（M3 前置单测）', () => {
  const allIds = REQUIRED_STYLES.map((s) => s.id);

  it('全样式命中 → ok', () => {
    const p = writeTempDocx(zipDocx({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document/>',
      'word/styles.xml': buildStylesXml(allIds),
    }), 'tpl-full.docx');
    expect(validateTemplate(p)).toEqual({ ok: true, missingStyles: [] });
  });

  it('缺 SourceCode → 提示缺失样式名', () => {
    const p = writeTempDocx(zipDocx({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document/>',
      'word/styles.xml': buildStylesXml(allIds.filter((id) => id !== 'SourceCode')),
    }), 'tpl-missing.docx');
    const r = validateTemplate(p);
    expect(r.ok).toBe(false);
    expect(r.missingStyles).toEqual(['Source Code']);
  });

  it('非 zip → 结构性错误', () => {
    const p = writeTempDocx(new TextEncoder().encode('garbage'), 'bad.docx');
    const r = validateTemplate(p);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('样式名（w:name）命中也算存在', () => {
    expect(hasNamedStyle(
      buildStylesXml(['X']) + '<w:style w:styleId="Y"><w:name w:val="Source Code"/></w:style>',
      'Source Code',
    )).toBe(true);
  });
});
