import { readFileSync } from 'node:fs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocx } from './validate.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 包根目录（assets 定位：dist/ 与 src/ 运行形态均指向包根） */
export { CORE_ROOT };

/**
 * reference.docx 必需样式（§5.3：模板缺样式要逐项提示）。
 * id 为 OOXML styleId，name 为 Word 显示名；二者任一命中即认为存在。
 */
export interface RequiredStyle {
  id: string;
  name: string;
}

export const REQUIRED_STYLES: readonly RequiredStyle[] = [
  { id: 'SourceCode', name: 'Source Code' }, // 代码块段落
  { id: 'VerbatimChar', name: 'Verbatim Char' }, // 行内代码
  { id: 'BlockText', name: 'Block Text' }, // 引用块
  { id: 'FootnoteText', name: 'Footnote Text' },
  { id: 'Hyperlink', name: 'Hyperlink' },
  { id: 'Table', name: 'Table' },
  { id: 'Heading1', name: 'Heading 1' },
  { id: 'FirstParagraph', name: 'First Paragraph' },
  { id: 'BodyText', name: 'Body Text' },
  { id: 'Compact', name: 'Compact' }, // 紧凑列表段落
  { id: 'ImageCaption', name: 'Image Caption' },
  { id: 'TableCaption', name: 'Table Caption' },
];

export interface TemplateValidation {
  ok: boolean;
  /** 缺失样式的显示名列表（ok=false 时非空，除非 zip 本身损坏） */
  missingStyles: string[];
  /** zip 损坏 / styles.xml 缺失等结构性问题 */
  error?: string;
}

/** 模板校验：zip 合法性 + 必需样式存在性（M3 DoD：无效模板被拒并提示缺哪些样式） */
export function validateTemplate(templatePath: string): TemplateValidation {
  let buf: Buffer;
  try {
    buf = readFileSync(templatePath);
  } catch (err) {
    return { ok: false, missingStyles: [], error: `无法读取模板文件：${err instanceof Error ? err.message : String(err)}` };
  }
  const opened = openDocx(buf);
  if (!opened.ok) {
    return { ok: false, missingStyles: [], error: `不是合法的 .docx 模板：${opened.reason}` };
  }
  const stylesXml = opened.contents?.stylesXml;
  if (!stylesXml) {
    return { ok: false, missingStyles: [], error: '模板缺少 word/styles.xml' };
  }
  const missing: string[] = [];
  // 归一化匹配（D32）：Word 保存后会把内置样式名写成小写规范名（heading 1）、
  // styleId 重写为数字、自定义样式名可能去空格（SourceCode）。
  // 因此以「name 去空格 + 小写」归一化比对为主，styleId 精确匹配为辅。
  const styleIds = new Set<string>();
  for (const m of stylesXml.matchAll(/w:styleId="([^"]+)"/g)) {
    const id = m[1];
    if (id) styleIds.add(id);
  }
  const normNames = new Set<string>();
  for (const m of stylesXml.matchAll(/<w:name w:val="([^"]+)"/g)) {
    const name = m[1];
    if (name) normNames.add(name.toLowerCase().replace(/\s+/g, ''));
  }
  for (const s of REQUIRED_STYLES) {
    if (styleIds.has(s.id)) continue;
    if (normNames.has(s.name.toLowerCase().replace(/\s+/g, ''))) continue;
    missing.push(s.name);
  }
  return { ok: missing.length === 0, missingStyles: missing };
}

/**
 * 补齐 docx 模板缺失的必需样式：从 donor 模板提取对应 <w:style> 块注入 styles.xml。
 * 用途（D32）：pandoc 原生默认模板不含 Source Code 样式（转换时动态创建），
 * 作为「可下载→可再导入」的模板导出时必须补齐，否则会被 validateTemplate 拒绝。
 * 无缺失或 donor 不可用时原样返回。
 */
export function augmentTemplateStyles(
  docxBytes: Uint8Array,
  donorDocxPath: string,
  required: readonly { id: string; name: string }[] = REQUIRED_STYLES,
): Uint8Array {
  try {
    const files = unzipSync(docxBytes);
    const stylesXml = files['word/styles.xml'] ? new TextDecoder().decode(files['word/styles.xml']) : '';
    if (!stylesXml) return docxBytes;
    const donorBytes = readFileSync(donorDocxPath);
    const donorXml = new TextDecoder().decode(unzipSync(new Uint8Array(donorBytes))['word/styles.xml'] ?? new Uint8Array());
    if (!donorXml) return docxBytes;

    const ids = new Set<string>();
    for (const m of stylesXml.matchAll(/w:styleId="([^"]+)"/g)) {
      const id = m[1];
      if (id) ids.add(id);
    }
    const normNames = new Set<string>();
    for (const m of stylesXml.matchAll(/<w:name w:val="([^"]+)"/g)) {
      const name = m[1];
      if (name) normNames.add(name.toLowerCase().replace(/\s+/g, ''));
    }

    const targetHasSimSun = stylesXml.includes('SimSun');
    let next = stylesXml;
    for (const s of required) {
      if (ids.has(s.id) || normNames.has(s.name.toLowerCase().replace(/\s+/g, ''))) continue;
      let block = new RegExp(`<w:style [^>]*w:styleId="${s.id}"[\\s\\S]*?</w:style>`).exec(donorXml)?.[0];
      if (!block) continue;
      if (!targetHasSimSun) {
        block = block.replace(/\s*w:eastAsia="SimSun"/g, '');
      }
      next = next.replace('</w:styles>', `${block}\n</w:styles>`);
      ids.add(s.id);
    }
    if (next === stylesXml) return docxBytes;
    return zipSync({ ...files, 'word/styles.xml': strToU8(next) }, { level: 6 });
  } catch {
    return docxBytes;
  }
}

/** 内置中文模板路径（M3 生成）；不存在返回 null（回退 pandoc 默认样式） */
export function getBundledReferenceDocx(): string | null {
  const p = join(CORE_ROOT, 'assets', 'reference-zh.docx');
  try {
    readFileSync(p); // 存在性探测
    return p;
  } catch {
    return null;
  }
}
