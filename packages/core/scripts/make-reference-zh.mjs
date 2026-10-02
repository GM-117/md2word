#!/usr/bin/env node
// 生成内置中文模板 reference-zh.docx（开发计划 §3 M3：pandoc 默认模板改样式生成）。
// 仅修改模板文件的样式定义（rFonts/sz 等），不改 pandoc 本体 —— 符合 §2.4 GPL 边界。
// 用法：node scripts/make-reference-zh.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(CORE_ROOT, 'assets');
const OUT = join(ASSETS, 'reference-zh.docx');

// 定位 sidecar（与 core 运行时同序：MD2WORD_PANDOC_BIN > 缓存 > PATH）
function findPandoc() {
  if (process.env.MD2WORD_PANDOC_BIN && existsSync(process.env.MD2WORD_PANDOC_BIN)) return process.env.MD2WORD_PANDOC_BIN;
  const lock = JSON.parse(readFileSync(join(ASSETS, 'pandoc.lock.json'), 'utf8'));
  const plat = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  const cached = join(ASSETS, 'bin', lock.version, plat, exe);
  if (existsSync(cached)) return cached;
  return 'pandoc';
}

// ---- 中文样式规格（个人中文文档常用搭配） ----
// 正文：宋体 + Times New Roman 西文，小四(12pt=24 half-points)，1.5 倍行距由 spacing line 控制
// 标题：黑体（SimHei），保持 pandoc 原字号层级
// 代码：Consolas 等宽，中文回退宋体
const FONT_BODY = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'SimSun', cs: 'Times New Roman' };
const FONT_HEAD = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'SimHei', cs: 'Arial' };
const FONT_CODE = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'SimSun', cs: 'Consolas' };

function rFontsXml(f) {
  return `<w:rFonts w:ascii="${f.ascii}" w:hAnsi="${f.hAnsi}" w:eastAsia="${f.eastAsia}" w:cs="${f.cs}" />`;
}

// 目标样式 → 字体方案（id 优先，name 兜底匹配）
const BODY_STYLES = ['Normal', 'BodyText', 'FirstParagraph', 'Compact', 'BlockText', 'FootnoteText', 'Caption', 'ImageCaption', 'TableCaption', 'Table'];
const HEAD_STYLES = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', 'Title', 'Subtitle', 'TOCHeading'];
const CODE_STYLES = ['SourceCode', 'VerbatimChar'];

function patchStyle(stylesXml, styleId, font, opts = {}) {
  // 找到 <w:style ... w:styleId="ID"> ... </w:style> 块
  const re = new RegExp(`(<w:style [^>]*w:styleId="${styleId}"[^>]*>)([\\s\\S]*?)(</w:style>)`);
  const m = re.exec(stylesXml);
  if (!m) return stylesXml.replace('</w:styles>', `  <w:style w:type="paragraph" w:customStyle="1" w:styleId="${styleId}"><w:name w:val="${styleId}" />${opts.paragraph ? `<w:pPr>${opts.paragraph}</w:pPr>` : ''}<w:rPr>${rFontsXml(font)}${opts.run ?? ''}</w:rPr></w:style>\n</w:styles>`);
  let inner = m[2];
  const fonts = rFontsXml(font);
  if (/<w:rPr>/.test(inner)) {
    if (/<w:rFonts /.test(inner)) {
      inner = inner.replace(/<w:rFonts [^/]*\/>/, fonts);
    } else {
      inner = inner.replace('<w:rPr>', `<w:rPr>${fonts}`);
    }
  } else {
    inner = `${inner}<w:rPr>${fonts}</w:rPr>`;
  }
  if (opts.paragraph && !new RegExp(`w:styleId="${styleId}"[\\s\\S]*?<w:pPr>`).test(stylesXml.slice(0, m.index))) {
    // 不深改段落属性：仅在明确要求时插入行距（Normal）
    if (!/<w:pPr>/.test(inner)) inner = `<w:pPr>${opts.paragraph}</w:pPr>${inner}`;
  }
  return stylesXml.slice(0, m.index) + m[1] + inner + m[3] + stylesXml.slice(m.index + m[0].length);
}

// ---- 生成 ----
mkdirSync(ASSETS, { recursive: true });
const pandoc = findPandoc();
const { spawnSync } = await import('node:child_process');
const def = spawnSync(pandoc, ['--print-default-data-file', 'reference.docx'], { maxBuffer: 64 * 1024 * 1024 });
if (def.status !== 0 || def.stdout.length < 1000) {
  console.error('[make-ref] 提取 pandoc 默认模板失败：', def.stderr?.toString());
  process.exit(1);
}

const files = unzipSync(def.stdout);
let stylesXml = new TextDecoder().decode(files['word/styles.xml']);
if (!stylesXml) {
  console.error('[make-ref] 默认模板无 styles.xml');
  process.exit(1);
}

for (const id of BODY_STYLES) stylesXml = patchStyle(stylesXml, id, FONT_BODY);
for (const id of HEAD_STYLES) stylesXml = patchStyle(stylesXml, id, FONT_HEAD);
for (const id of CODE_STYLES) stylesXml = patchStyle(stylesXml, id, FONT_CODE);

// 正文默认字号 12pt（小四）+ 1.5 倍行距（仅 Normal，其余继承）
stylesXml = stylesXml.replace(
  /(<w:style [^>]*w:styleId="Normal"[^>]*>)([\s\S]*?)(<\/w:style>)/,
  (_w, open, inner, close) => {
    let next = inner;
    const pPr = '<w:pPr><w:spacing w:before="0" w:after="120" w:line="360" w:lineRule="auto" /></w:pPr>';
    const sz = '<w:sz w:val="24" /><w:szCs w:val="24" />';
    if (/<w:pPr>/.test(next)) {
      if (!/w:line=/.test(next)) next = next.replace('<w:pPr>', '<w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto" />');
    } else {
      next = pPr + next;
    }
    if (/<w:rPr>/.test(next)) {
      if (!/<w:sz /.test(next)) next = next.replace('</w:rPr>', `${sz}</w:rPr>`);
    } else {
      next = `${next}<w:rPr>${sz}</w:rPr>`;
    }
    return open + next + close;
  },
);

files['word/styles.xml'] = strToU8(stylesXml);
writeFileSync(OUT, zipSync(files));
console.log(`[make-ref] 已生成 ${OUT}（基于 pandoc 默认模板 + 中文字体样式）`);

// ---- 自检：必需样式在位 ----
const required = ['SourceCode', 'VerbatimChar', 'BlockText', 'FootnoteText', 'Hyperlink', 'Table', 'Heading1', 'FirstParagraph', 'BodyText', 'Compact', 'ImageCaption', 'TableCaption'];
const missing = required.filter((id) => !new RegExp(`w:styleId="${id}"`).test(stylesXml) && !new RegExp(`<w:name w:val="${id}"`).test(stylesXml));
if (missing.length > 0) {
  console.error('[make-ref] 生成后缺失必需样式：', missing);
  process.exit(1);
}
console.log('[make-ref] 必需样式自检通过');
