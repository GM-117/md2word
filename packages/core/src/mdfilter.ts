/**
 * 批量转换的文件过滤纯规则（M6）：递归扫描器（node 侧）与渲染层
 * webkitdirectory 客户端过滤共用同一事实源；本模块零 Node 依赖，可进浏览器 bundle。
 */

/** 参与 md→docx 转换的扩展名（与 convert.ts 输出命名、宿主过滤口径一致） */
export const MD_EXTENSIONS = /\.(md|markdown|mdown|mkd)$/i;

/** 批量扫描时跳过的目录名（与隐藏目录同类的第三方/工具目录，批量场景必非用户意图） */
export const SKIPPED_DIRS = new Set(['node_modules']);

/** 是否 Markdown 源文件（按文件名判断，不含路径） */
export function isMarkdownName(name: string): boolean {
  return MD_EXTENSIONS.test(name);
}

/** 相对路径中是否含隐藏段（任一路径段以 . 开头，posix/win 分隔符通用） */
export function hasHiddenSegment(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => seg.startsWith('.'));
}

/** 相对路径中是否含被跳过的目录段（node_modules 等） */
export function hasSkippedSegment(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => SKIPPED_DIRS.has(seg));
}

/** 文件夹批量入口的统一过滤：仅收 .md，排除隐藏段/跳过目录段（渲染层与扫描器共用） */
export function isBatchMarkdownPath(relPath: string): boolean {
  return isMarkdownName(relPath) && !hasHiddenSegment(relPath) && !hasSkippedSegment(relPath);
}
