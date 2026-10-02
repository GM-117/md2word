import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

const MAX_ENTRIES = 2000;

export class LogBuffer {
  private entries: string[] = [];
  private filePath: string | null = null;

  attachFile(path: string): void {
    this.filePath = path;
    if (!existsSync(path)) {
      mkdirSync(join(path, '..'), { recursive: true });
      appendFileSync(path, '');
    }
  }

  log(level: LogLevel, message: string): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    this.entries.push(line);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    if (this.filePath) {
      try { appendFileSync(this.filePath, line + '\n'); } catch { /* 磁盘问题不拖垮服务 */ }
    }
  }

  info(message: string): void { this.log('info', message); }
  warn(message: string): void { this.log('warn', message); }
  error(message: string): void { this.log('error', message); }

  /** 导出文本（日志导出，US5） */
  exportText(): string {
    return this.entries.join('\n') + '\n';
  }

  size(): number {
    return this.entries.length;
  }
}
