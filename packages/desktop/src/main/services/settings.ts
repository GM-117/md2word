import { HIGHLIGHT_STYLES, type HighlightStyle } from '@md2word/core';

/** 键值存储抽象：生产用 electron-store，测试用内存实现（services 不 import electron） */
export interface KvStore {
  all(): Record<string, unknown>;
  set(patch: Record<string, unknown>): void;
}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  toc: false,
  tocDepth: 3,
  numberSections: false,
  highlightStyle: 'pygments',
  offline: false,
  overwrite: false,
  defaultTemplate: 'builtin-zh',
  metaTitle: '',
  metaAuthor: '',
  recentFiles: [] as string[],
};

export type SettingsPatchResult = { ok: true } | { ok: false; error: string };

/**
 * 设置服务：白名单校验与 web-host PUT /api/settings 完全一致（§5 防设置键失配回归），
 * 落盘格式为扁平 JSON（electron-store name=settings，与 web-host settings.json 同构）。
 */
export class SettingsService {
  constructor(private readonly store: KvStore) {}

  get all(): Record<string, unknown> {
    return this.store.all();
  }

  /** 校验并合并写入；非法键值抛错（bridge 转为人话错误给渲染层） */
  set(patch: Record<string, unknown>): SettingsPatchResult {
    if (patch.highlightStyle !== undefined && !HIGHLIGHT_STYLES.includes(patch.highlightStyle as HighlightStyle)) {
      return { ok: false, error: `highlightStyle 必须是：${HIGHLIGHT_STYLES.join('/')}` };
    }
    if (patch.tocDepth !== undefined && ![1, 2, 3, 4, 5, 6].includes(patch.tocDepth as number)) {
      return { ok: false, error: 'tocDepth 必须是 1-6' };
    }
    if (patch.recentFiles !== undefined) {
      if (!Array.isArray(patch.recentFiles) || patch.recentFiles.some((x) => typeof x !== 'string')) {
        return { ok: false, error: 'recentFiles 必须是字符串数组' };
      }
      patch = { ...patch, recentFiles: (patch.recentFiles as string[]).slice(0, 10) };
    }
    this.store.set(patch);
    return { ok: true };
  }
}
