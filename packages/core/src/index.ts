// @md2word/core —— 公共 API（M1 冻结接口，见开发计划 §2.6）
export { convertMarkdown, convertBatch, resolveOutputPath, buildPandocArgs, classifyStderr, classifyFailure } from './convert.js';
export { SourceError } from './preprocess.js';
export { resolvePandocInfo, resetPandocCache, runPandoc } from './pandoc.js';
export { validateTemplate, getBundledReferenceDocx, augmentTemplateStyles, REQUIRED_STYLES } from './template.js';
export { openDocx, computeStats, hasNamedStyle, countStyleUsage } from './validate.js';
export { SerialQueue, CANCEL_REASON } from './queue.js';
export { scanMarkdownFiles, MAX_SCAN_FILES } from './scan.js';
export type { ScanResult, ScannedFile } from './scan.js';
export {
  isBatchMarkdownPath,
  hasHiddenSegment,
  hasSkippedSegment,
  isMarkdownName,
  MD_EXTENSIONS,
  SKIPPED_DIRS,
} from './mdfilter.js';
export {
  DEFAULT_TIMEOUT_MS,
  MAX_SOURCE_BYTES,
  HIGHLIGHT_STYLES,
} from './types.js';
export type {
  ConvertOptions,
  ConvertResult,
  ConvertStats,
  ErrorCode,
  HighlightStyle,
  PandocInfo,
  Warning,
  WarningCode,
} from './types.js';
