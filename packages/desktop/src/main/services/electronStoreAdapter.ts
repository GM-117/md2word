import type { KvStore } from './settings.js';
import { DEFAULT_SETTINGS } from './settings.js';

/**
 * electron-store 适配（开发计划 §3 M2 行：Electron 阶段换 electron-store，格式一致）。
 * 动态 import + 显式 cwd：services 其余部分保持无 electron 依赖（vitest 可测）。
 * 序列化对齐 web-host settings.json：扁平 JSON、2 空格缩进、尾部换行。
 */
export async function createKvStore(userDataDir: string): Promise<KvStore> {
  const { default: Store } = await import('electron-store');
  const store = new Store({
    cwd: userDataDir,
    name: 'settings',
    defaults: DEFAULT_SETTINGS,
    serialize: (value: unknown) => JSON.stringify(value, null, 2) + '\n',
  });
  return {
    all: () => store.store as Record<string, unknown>,
    set: (patch: Record<string, unknown>) => {
      store.set(patch as Record<string, unknown>);
    },
  };
}
