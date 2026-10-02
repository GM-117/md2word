import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertBatch, convertMarkdown } from '../../src/convert.js';
import { SerialQueue } from '../../src/queue.js';

function makeWorkDir(): { dir: string; file: (name: string, text: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'md2word-batch-'));
  return {
    dir,
    file: (name, text) => {
      const p = join(dir, name);
      writeFileSync(p, text, 'utf8');
      return p;
    },
  };
}

const GOOD = '# 好\n\n段落。\n';

describe('convertBatch 串行队列（v1.0 核心，M6 复用）', () => {
  it('顺序逐个产出结果', async () => {
    const { file } = makeWorkDir();
    const files = [file('a.md', GOOD), file('b.md', GOOD), file('c.md', GOOD)];
    const order: string[] = [];
    for await (const r of convertBatch(files, {})) {
      expect(r.ok).toBe(true);
      order.push(r.outputPath!);
    }
    expect(order).toEqual(files.map((f) => f.replace(/\.md$/, '.docx')));
  });

  it('单文件失败不中断队列（US2 验收口径）', async () => {
    const { dir, file } = makeWorkDir();
    const ok1 = file('ok1.md', GOOD);
    const ok2 = file('ok2.md', GOOD);
    const ghost = join(dir, 'ghost.md'); // 故意不存在
    const outcomes: boolean[] = [];
    for await (const r of convertBatch([ok1, ghost, ok2], {})) {
      outcomes.push(r.ok);
    }
    expect(outcomes).toEqual([true, false, true]);
  });

  it('abort 信号停止派发剩余任务', async () => {
    const { file } = makeWorkDir();
    const files = [file('x1.md', GOOD), file('x2.md', GOOD), file('x3.md', GOOD)];
    const ac = new AbortController();
    let seen = 0;
    for await (const r of convertBatch(files, { signal: ac.signal })) {
      seen += 1;
      void r;
      ac.abort();
    }
    expect(seen).toBe(1);
  });
});

describe('SerialQueue 与宿主集成形态', () => {
  it('转换任务经队列串行执行', async () => {
    const q = new SerialQueue();
    const { file } = makeWorkDir();
    const f1 = file('q1.md', GOOD);
    const r1 = await q.enqueue({ run: () => convertMarkdown(f1, { overwrite: true }) });
    expect(r1.ok).toBe(true);
    expect(q.isRunning).toBe(false);
  });
});
