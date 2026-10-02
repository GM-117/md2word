import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogBuffer } from '../../src/main/services/logger.js';

describe('LogBuffer', () => {
  it('环形缓冲上限 2000 条', () => {
    const log = new LogBuffer();
    for (let i = 0; i < 2005; i++) log.info(`line ${i}`);
    expect(log.size()).toBe(2000);
    const text = log.exportText();
    expect(text).not.toContain('line 3\n');
    expect(text).toContain('line 2004');
  });

  it('attachFile 后写盘（落盘文件可读回）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'md2word-log-'));
    try {
      const file = join(dir, 'logs', 'md2word.log');
      const log = new LogBuffer();
      log.attachFile(file);
      log.warn('hello 落盘');
      expect(readFileSync(file, 'utf8')).toContain('[WARN] hello 落盘');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
