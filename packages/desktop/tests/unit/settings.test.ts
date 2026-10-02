import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsService, type KvStore } from '../../src/main/services/settings.js';

class MemoryStore implements KvStore {
  data: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  all() {
    return { ...this.data };
  }
  set(patch: Record<string, unknown>) {
    this.data = { ...this.data, ...patch };
  }
}

describe('SettingsService', () => {
  it('默认值与 web-host DEFAULT_SETTINGS 一致', () => {
    const s = new SettingsService(new MemoryStore());
    expect(s.all).toEqual(DEFAULT_SETTINGS);
    expect(s.all.defaultTemplate).toBe('builtin-zh');
  });

  it('合法补丁写入并持久化到 store', () => {
    const store = new MemoryStore();
    const s = new SettingsService(store);
    const r = s.set({ toc: true, tocDepth: 5 });
    expect(r.ok).toBe(true);
    expect(store.data.toc).toBe(true);
    expect(store.data.tocDepth).toBe(5);
  });

  it('拒绝非法 highlightStyle / tocDepth / recentFiles', () => {
    const s = new SettingsService(new MemoryStore());
    expect(s.set({ highlightStyle: 'nope' })).toEqual({ ok: false, error: expect.stringContaining('highlightStyle') });
    expect(s.set({ tocDepth: 9 })).toEqual({ ok: false, error: expect.stringContaining('tocDepth') });
    expect(s.set({ recentFiles: 'x' })).toEqual({ ok: false, error: expect.stringContaining('recentFiles') });
    expect(s.set({ recentFiles: [1, 2] })).toMatchObject({ ok: false });
  });

  it('recentFiles 截断到 10 条', () => {
    const store = new MemoryStore();
    const s = new SettingsService(store);
    const files = Array.from({ length: 15 }, (_, i) => `f${i}.md`);
    s.set({ recentFiles: files });
    expect((store.data.recentFiles as string[]).length).toBe(10);
  });

  it('未知键直接透传存储（与 web-host 行为一致，由调用方白名单化）', () => {
    const store = new MemoryStore();
    const s = new SettingsService(store);
    s.set({ customKey: 1 });
    expect(store.data.customKey).toBe(1);
  });
});
