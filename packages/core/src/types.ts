// 公共类型定义——M1 冻结接口（开发计划 §2.6）。
// 宿主（web-host / desktop / mcp-server）只依赖本模块导出的类型与函数。

export type HighlightStyle =
  | 'pygments'
  | 'tango'
  | 'espresso'
  | 'zenburn'
  | 'kate'
  | 'monochrome';

export interface ConvertOptions {
  /** 生成目录（pandoc 域指令，Word 中需 F9 更新域显示页码） */
  toc?: boolean;
  /** 目录层级，默认 3（仅 toc 开启时生效） */
  tocDepth?: 1 | 2 | 3 | 4 | 5 | 6;
  /** 章节编号 → --number-sections */
  numberSections?: boolean;
  /** 代码高亮风格，缺省为 pandoc 默认（pygments） */
  highlightStyle?: HighlightStyle;
  /** reference.docx 模板绝对路径；缺省用内置中文模板（若无则用 pandoc 默认样式） */
  referenceDocx?: string;
  /** 输出目录，缺省与源文件同目录 */
  outputDir?: string;
  /** 默认 false：目标 .docx 已存在时报 E_OUTPUT_EXISTS */
  overwrite?: boolean;
  /** 元数据透传（→ --metadata） */
  metadata?: { title?: string; author?: string };
  /** pandoc 进程超时毫秒数，默认 60_000，超时 kill 进程树 */
  timeoutMs?: number;
  /** 离线模式：不抓取远程图片，跳过并计入 warnings（开发计划 §4.3） */
  offline?: boolean;
  /** 取消信号：用于批量队列/宿主中断在途转换 */
  signal?: AbortSignal;
}

export interface ConvertStats {
  headings: number;
  tables: number;
  images: number;
  math: number;
  footnotes: number;
  codeBlocks: number;
  /** 无语言标注的 fenced code block 数（§4.4：提示用户补语言） */
  plainCodeBlocks: number;
}

export type ErrorCode =
  | 'E_SOURCE_NOT_FOUND'
  | 'E_SOURCE_TOO_LARGE'
  | 'E_OUTPUT_EXISTS'
  | 'E_TEMPLATE_INVALID'
  | 'E_PANDOC_FAILED'
  | 'E_TIMEOUT'
  | 'E_PANDOC_NOT_FOUND'
  | 'E_CANCELLED';

export type WarningCode =
  /** pandoc 报 Could not fetch resource：远程/本地图片未取到 */
  | 'W_IMAGE_FETCH'
  /** 离线模式下跳过的远程图片 */
  | 'W_IMAGE_OFFLINE'
  /** Could not convert TeX math：公式按原文输出 */
  | 'W_MATH'
  /** 存在无语言标注的代码块，无高亮 */
  | 'W_PLAIN_CODE_BLOCK'
  /** TOC 为域指令，Word 中需更新域（F9）才显示页码 */
  | 'W_TOC_FIELD';

export interface Warning {
  code: WarningCode;
  /** 已人话化的中文提示（§5.3 文案口径） */
  message: string;
  /** 原始细节（资源 URL / 公式片段 / 数量等） */
  detail?: string;
}

export interface ConvertResult {
  ok: boolean;
  outputPath?: string;
  durationMs: number;
  stats?: ConvertStats;
  warnings: Warning[];
  error?: {
    code: ErrorCode;
    /** 人话化中文消息 */
    message: string;
    /** pandoc stderr 末尾原文（日志导出用） */
    stderrTail?: string;
  };
}

/** pandoc sidecar 定位结果 */
export interface PandocInfo {
  version: string;
  path: string;
  /** env=PANDOC_PATH 指定；bundled=随包二进制；path=系统 PATH 兜底 */
  source: 'env' | 'bundled' | 'path';
}

export const DEFAULT_TIMEOUT_MS = 60_000;
/** §5.3：E_SOURCE_TOO_LARGE 阈值（20MB） */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export const HIGHLIGHT_STYLES: readonly HighlightStyle[] = [
  'pygments',
  'tango',
  'espresso',
  'zenburn',
  'kate',
  'monochrome',
] as const;
