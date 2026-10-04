/**
 * 文件夹递归扫描（M6 批量转换）：找出目录树下全部 .md 文件。
 * 口径（开发计划 M6 行）：排除隐藏文件/目录（. 开头）与非 .md；另排除 node_modules
 * 与目录符号链接（防环）；不跟随文件符号链接（不越出所选根目录）。
 */
import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { hasSkippedSegment, isBatchMarkdownPath } from './mdfilter.js';

/** 单次扫描的文件数上限（防御性：误选巨型目录时截断并在 UI 提示，而不是卡死队列） */
export const MAX_SCAN_FILES = 2000;
/** 递归深度上限（防御异常深/成环结构） */
const MAX_SCAN_DEPTH = 48;

export interface ScannedFile {
  /** 绝对路径（spawn/转换输入用） */
  path: string;
  /** 相对根目录的展示路径，'/' 分隔（批量列表展示与 web 端命名用） */
  relPath: string;
}

export interface ScanResult {
  root: string;
  files: ScannedFile[];
  /** 命中上限被截断（true 时 UI 须提示"仅包含前 N 个"） */
  truncated: boolean;
  /** 实际遍历的目录数（日志用） */
  scannedDirs: number;
}

export function scanMarkdownFiles(root: string, maxFiles: number = MAX_SCAN_FILES): ScanResult {
  const files: ScannedFile[] = [];
  let truncated = false;
  let scannedDirs = 0;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > MAX_SCAN_DEPTH) return;
    scannedDirs += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限/已消失的子目录：跳过，不让单个目录拖垮整次扫描
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.')) continue; // 隐藏文件/目录
      if (entry.isDirectory()) {
        if (hasSkippedSegment(entry.name)) continue;
        walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
        continue;
      }
      // 只收真实文件：符号链接（文件/目录）一律跳过，避免越出根目录与成环
      if (!entry.isFile()) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (!isBatchMarkdownPath(relPath)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push({ path: join(dir, entry.name), relPath });
    }
  };

  walk(root, '', 0);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { root, files, truncated, scannedDirs };
}

/** 渲染层展示用：导出共享过滤口径，宿主无需自行拼正则 */
export { isBatchMarkdownPath, hasHiddenSegment, hasSkippedSegment, isMarkdownName } from './mdfilter.js';
