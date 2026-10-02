import { readFileSync } from 'node:fs';
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
  for (const s of REQUIRED_STYLES) {
    const byId = new RegExp(`w:styleId="${s.id}"`).test(stylesXml);
    const byName = new RegExp(`<w:name w:val="${s.name}"`).test(stylesXml);
    if (!byId && !byName) missing.push(s.name);
  }
  return { ok: missing.length === 0, missingStyles: missing };
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
