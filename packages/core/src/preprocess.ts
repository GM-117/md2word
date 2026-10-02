import { createHash } from 'node:crypto';
import { readFileSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { MAX_SOURCE_BYTES } from './types.js';

/** 输入问题按 §5.3 以错误码表达；此处用带 code 的异常承载，convert 层转结果对象 */
export class SourceError extends Error {
  constructor(
    public readonly code: 'E_SOURCE_NOT_FOUND' | 'E_SOURCE_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

/** 校验源文件存在且 ≤20MB（§5.3 E_SOURCE_TOO_LARGE） */
export function assertSourceUsable(srcPath: string): void {
  let st: Stats;
  try {
    st = statSync(srcPath);
  } catch {
    throw new SourceError('E_SOURCE_NOT_FOUND', `找不到源文件：${srcPath}`);
  }
  if (!st.isFile()) {
    throw new SourceError('E_SOURCE_NOT_FOUND', `路径不是文件：${srcPath}`);
  }
  if (st.size > MAX_SOURCE_BYTES) {
    throw new SourceError(
      'E_SOURCE_TOO_LARGE',
      `文件超过 20MB 上限（实际 ${Math.ceil(st.size / 1024 / 1024)}MB）：${basename(srcPath)}`,
    );
  }
}

function isRemote(ref: string): boolean {
  return /^(https?|ftp):\/\//i.test(ref) || ref.startsWith('data:');
}

/**
 * 归一化单个引用路径：
 * - 远程（http/https/ftp/data）原样保留（默认允许 pandoc 抓取，§4.3）
 * - 相对路径解析为绝对路径；含空格/中文/括号等特殊字符时用 <…> 包裹（pandoc 尖括号目标语法）
 * - 百分号编码先解码再解析，避免文件系统层二次解码失败
 */
export function normalizeImageRef(ref: string, sourceDir: string): string {
  if (isRemote(ref)) return ref;
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    // 非法编码序列：保留原样
  }
  return isAbsolute(decoded) ? decoded : resolve(sourceDir, decoded);
}

function wrapTarget(abs: string): string {
  // 仅当路径只含“绝对安全”字符（字母/数字/._-/:/@/+）时才裸写；
  // 空格、中文、括号等一律 <> 包裹，避免 pandoc 目标解析截断
  return /^[\w./:@+-]+$/.test(abs) ? abs : `<${abs}>`;
}

// 链接/图片目标：尖括号包裹（任意字符），或无空格、括号平衡的裸串（CommonMark 规则）
const TARGET_SRC = String.raw`(<[^<>]*>|(?:[^()\s]|\([^()]*\))+)`;
const TITLE_SRC = String.raw`(?:\s+"([^"]*)")?`;
const MD_IMAGE_INLINE = new RegExp(
  String.raw`(!\[[^\]]*\])\( ?${TARGET_SRC}${TITLE_SRC} ?\)`,
  'g',
);
const MD_REFERENCE_DEF = new RegExp(
  String.raw`^ {0,3}\[([^\]]+)\]: ?${TARGET_SRC}${TITLE_SRC} ?$`,
  'gm',
);

/**
 * 对 fenced code block（``` / ~~~）之外的文本做变换，避免改写代码示例中的 Markdown 语法。
 * 变换函数收到的是若干连续非代码行组成的片段。
 */
export function mapOutsideCode(text: string, fn: (chunk: string) => string): string {
  // 快速路径：无 fence 起始符时整段一次变换（大文件省去逐行扫描开销）
  const firstFence = /(^|\n) {0,3}(`{3,}|~{3,})/.exec(text);
  if (!firstFence) {
    return fn(text);
  }
  const lines = text.split(/\r?\n/);
  let fenceChar: string | null = null;
  let fenceLength = 0;
  const out: string[] = [];
  let pending: string[] = [];

  const flush = () => {
    if (pending.length > 0) {
      out.push(fn(pending.join('\n')));
      pending = [];
    }
  };

  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceChar === null && m) {
      const marker = m[1] as string;
      const info = (m[2] ?? '').trim();
      // 反引号 fence 的 info string 不允许包含反引号（CommonMark）
      if (!(marker[0] === '`' && info.includes('`'))) {
        flush();
        fenceChar = marker[0] as string;
        fenceLength = marker.length;
        out.push(line);
        continue;
      }
    } else if (
      fenceChar !== null &&
      m &&
      (m[1] as string)[0] === fenceChar &&
      (m[1] as string).length >= fenceLength &&
      (m[2] ?? '').trim() === ''
    ) {
      fenceChar = null;
      fenceLength = 0;
      out.push(line);
      continue;
    }
    if (fenceChar !== null) {
      out.push(line);
    } else {
      pending.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** 行内代码 span 之外才做替换（片段级） */
function mapOutsideInlineCode(chunk: string, fn: (s: string) => string): string {
  return chunk
    .split(/(`[^`\n]*`)/g)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length >= 2 ? part : fn(part)))
    .join('');
}

function unwrap(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

export interface PreprocessResult {
  /** 归一化后的 markdown 文本（相对图片路径已绝对化） */
  text: string;
  /** 源目录（--resource-path 兜底用） */
  sourceDir: string;
  /** 重写过的本地图片引用（绝对路径），供测试与日志 */
  rewrittenImages: string[];
}

/** 图片路径绝对化（§4.3 输入规范化）：行内 `![](...)` 与引用定义 `[id]: ...` */
export function absolutizeImagePaths(markdownText: string, srcPath: string): PreprocessResult {
  const sourceDir = dirname(resolve(srcPath));
  const rewritten: string[] = [];

  // 快速路径：文本不含任何链接目标语法时跳过逐行扫描（10MB 级样例节省数秒）
  const maybeImages = markdownText.includes('](') || /\n\s{0,3}\[[^\]]+\]:/.test(markdownText);

  const rewriteSegment = (segment: string): string => {
    if (!maybeImages) return segment;
    let t = segment.replace(MD_IMAGE_INLINE, (whole, label: string, rawTarget: string, title?: string) => {
      const target = unwrap(rawTarget);
      if (isRemote(target)) return whole;
      const abs = normalizeImageRef(target, sourceDir);
      if (abs === target) return whole;
      rewritten.push(abs);
      return `${label}(${wrapTarget(abs)}${title !== undefined ? ` "${title}"` : ''})`;
    });
    t = t.replace(MD_REFERENCE_DEF, (whole, _id: string, rawTarget: string, title?: string) => {
      const target = unwrap(rawTarget);
      if (isRemote(target)) return whole;
      const abs = normalizeImageRef(target, sourceDir);
      if (abs === target) return whole;
      rewritten.push(abs);
      return whole.replace(rawTarget, wrapTarget(abs) + (title !== undefined ? ` "${title}"` : ''));
    });
    return t;
  };

  const text = mapOutsideCode(markdownText, (chunk) => mapOutsideInlineCode(chunk, rewriteSegment));
  return { text, sourceDir, rewrittenImages: rewritten };
}

export interface FenceStats {
  total: number;
  /** 有语言标注（info string 非空）的数量 */
  withLanguage: number;
}

/** 统计 fenced code block（``` 与 ~~~），用于 plainCodeBlocks 警告（§4.4） */
export function countFencedCodeBlocks(markdownText: string): FenceStats {
  let total = 0;
  let withLanguage = 0;
  let fenceChar: string | null = null;
  let fenceLength = 0;

  for (const line of markdownText.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const marker = m[1] as string;
    const info = (m[2] ?? '').trim();
    if (fenceChar === null) {
      if (marker[0] === '`' && info.includes('`')) continue;
      fenceChar = marker[0] as string;
      fenceLength = marker.length;
      total += 1;
      if (info.length > 0) withLanguage += 1;
    } else if (marker[0] === fenceChar && marker.length >= fenceLength && info === '') {
      fenceChar = null;
      fenceLength = 0;
    }
  }
  return { total, withLanguage };
}

/** 规范化文本落临时文件（§4.2：文本来源走临时文件，不经 stdin 管道） */
export function writeTempMarkdown(text: string, srcPath: string, tmpDir: string): string {
  const digest = createHash('sha1').update(`${srcPath}\0${process.pid}`).digest('hex').slice(0, 12);
  return join(tmpDir, `md2word-${digest}-${Date.now()}.md`);
}

/** 读取源文件文本（UTF-8） */
export function readSourceText(srcPath: string): string {
  return readFileSync(srcPath, 'utf8');
}
