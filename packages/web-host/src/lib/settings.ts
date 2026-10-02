import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 设置持久化（US6）：本地 JSON 落盘，扁平键值。
 * 格式与 Electron 阶段 electron-store 一致（开发计划 §3 M2 行），迁移零成本。
 */
export class SettingsStore {
  private data: Record<string, unknown>;
  private readonly filePath: string;

  constructor(dataDir: string, defaults: Record<string, unknown>) {
    this.filePath = join(dataDir, 'settings.json');
    mkdirSync(dirname(this.filePath), { recursive: true });
    let loaded: Record<string, unknown> = {};
    if (existsSync(this.filePath)) {
      try {
        loaded = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      } catch {
        loaded = {}; // 损坏则回退默认值并在下次写入时重写
      }
    }
    this.data = { ...defaults, ...loaded };
    this.flush();
  }

  get all(): Record<string, unknown> {
    return { ...this.data };
  }

  set(patch: Record<string, unknown>): void {
    this.data = { ...this.data, ...patch };
    this.flush();
  }

  private flush(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    } catch {
      // 写失败不抛出：下次 set 重试
    }
  }
}
