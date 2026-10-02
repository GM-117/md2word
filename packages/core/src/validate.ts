import { unzipSync } from 'fflate';
import type { ConvertStats } from './types.js';

export interface DocxContents {
  documentXml: string;
  stylesXml?: string;
  footnotesXml?: string;
  coreXml?: string;
}

export interface DocxValidation {
  ok: boolean;
  /** zip 损坏 / 缺少关键部件时的原因 */
  reason?: string;
  contents?: DocxContents;
}

/**
 * 解包 .docx（zip 容器）并校验关键部件在位：
 * [Content_Types].xml、word/document.xml（§5 测试基线：zip 完整性 + document.xml 元素断言）。
 * zip CRC 错误由 fflate 解包时抛出，捕获后视为校验失败。
 */
export function openDocx(buf: Uint8Array | Buffer): DocxValidation {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch (err) {
    return { ok: false, reason: `zip 容器无法解析：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!files['[Content_Types].xml']) {
    return { ok: false, reason: '缺少 [Content_Types].xml（不是合法的 OOXML 包）' };
  }
  const documentXml = files['word/document.xml'];
  if (!documentXml) {
    return { ok: false, reason: '缺少 word/document.xml' };
  }
  const dec = (u: Uint8Array | undefined): string | undefined =>
    u === undefined ? undefined : new TextDecoder('utf-8').decode(u);
  return {
    ok: true,
    contents: {
      documentXml: dec(documentXml)!,
      stylesXml: dec(files['word/styles.xml']),
      footnotesXml: dec(files['word/footnotes.xml']),
      coreXml: dec(files['docProps/core.xml']),
    },
  };
}

// ---------------------------------------------------------------------------
// document.xml 元素断言与统计（黄金样例断言基线，见调研报告测试方法）
// ---------------------------------------------------------------------------

function countMatches(xml: string, re: RegExp): number {
  const m = xml.match(re);
  return m === null ? 0 : m.length;
}

/** 命名样式命中：styleId 或样式名（如 "SourceCode" / "Source Code"） */
export function countStyleUsage(documentXml: string, styleId: string): number {
  return countMatches(documentXml, new RegExp(`w:pStyle w:val="${styleId}"`, 'g'));
}

export function hasNamedStyle(stylesXml: string | undefined, styleIdOrName: string): boolean {
  if (!stylesXml) return false;
  const byId = new RegExp(`w:styleId="${styleIdOrName}"`).test(stylesXml);
  if (byId) return true;
  // 样式名匹配：<w:name w:val="Source Code"/>
  return new RegExp(`<w:name w:val="${styleIdOrName}"`).test(stylesXml);
}

/** 从 document.xml（及 footnotes.xml）统计元素命中数 */
export function computeStats(documentXml: string, footnotesXml?: string): ConvertStats {
  return {
    // pandoc 标题段落样式：Heading1..Heading6（TOC 域段落用 TOC1/TOC 样式，不会误计）
    headings: countMatches(documentXml, /w:pStyle w:val="Heading[1-6]"/g),
    tables: countMatches(documentXml, /<w:tbl>/g),
    // 注意：pandoc 对每张图输出 mc:AlternateContent（Choice 内 <w:drawing><wp:inline|anchor>，
    // Fallback 内 <w:pict>），按 drawing/pict 计数会翻倍；以现代表示 wp:inline/wp:anchor 计数
    images:
      countMatches(documentXml, /<wp:inline[ >/]/g) + countMatches(documentXml, /<wp:anchor[ >/]/g),
    // <m:oMathPara> 含前缀 <m:oMath，需负向断言防重复计数
    math: countMatches(documentXml, /<m:oMath(?!Para)[ >/]/g),
    // 脚注引用计数（footnotes.xml 里的分隔符脚注不算）
    footnotes: countMatches(documentXml, /<w:footnoteReference /g),
    codeBlocks: countMatches(documentXml, /w:pStyle w:val="SourceCode"/g),
    // plainCodeBlocks 由源文本统计（见 preprocess），此处置 0 占位
    plainCodeBlocks: 0,
  };
}
