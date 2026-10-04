import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_SCAN_FILES, scanMarkdownFiles, type ScanResult } from '@md2word/core';

/**
 * 文件夹批量转换的扫描入口（M6）：校验路径后交给 core 递归扫描。
 * 路径来自渲染层（桌面端经 dialog:pickFolder 原生对话框取得），仅用于读取扫描，
 * 不参与任何写路径拼接；非法输入抛人话错误由渲染层展示。
 */
export function scanFolderForConvert(raw: unknown, maxFiles: number = MAX_SCAN_FILES): ScanResult {
  const root = resolve(String(raw ?? '').replace(/\0/g, ''));
  if (!root || !existsSync(root)) {
    throw new Error(`文件夹不存在或不可访问：${root}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`所选路径不是文件夹：${root}`);
  }
  const result = scanMarkdownFiles(root, maxFiles);
  if (result.files.length === 0) {
    throw new Error('该文件夹（含子目录）内没有找到 .md 文件（已跳过隐藏文件与 node_modules）');
  }
  return result;
}
