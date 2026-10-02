import { describe, expect, it, vi } from 'vitest';
import { SerialQueue } from '../../src/queue.js';

describe('SerialQueue 串行队列', () => {
  it('严格串行执行，结果按入队顺序返回', async () => {
    const q = new SerialQueue();
    const events: string[] = [];

    const t1 = q.enqueue({ run: async () => { events.push('s1'); await new Promise((r) => setTimeout(r, 30)); events.push('e1'); return 1; } });
    const t2 = q.enqueue({ run: async () => { events.push('s2'); return 2; } });
    const t3 = q.enqueue({ run: async () => { events.push('s3'); return 3; } });

    expect(await Promise.all([t1, t2, t3])).toEqual([1, 2, 3]);
    expect(events).toEqual(['s1', 'e1', 's2', 's3']);
  });

  it('任务失败不阻断后续任务', async () => {
    const q = new SerialQueue();
    const first = q.enqueue({ run: async () => { throw new Error('boom'); } });
    const second = q.enqueue({ run: async () => 'ok' });
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe('ok');
  });

  it('cancelAll 拒绝等待任务并中止在跑任务', async () => {
    const q = new SerialQueue();
    let abortListener: (() => void) | null = null;
    const running = q.enqueue({
      run: (signal) =>
        new Promise((_resolve, reject) => {
          abortListener = () => reject(new Error('cancelled-in-task'));
          signal.addEventListener('abort', abortListener, { once: true });
        }),
    });
    const pending = q.enqueue({ run: async () => 'never' });

    const cancelled = q.cancelAll('user cancel');
    expect(cancelled).toBe(2);
    await expect(running).rejects.toThrow('cancelled-in-task');
    await expect(pending).rejects.toThrow('user cancel');
  });

  it('pendingCount 反映等待数量', async () => {
    const q = new SerialQueue();
    let started = false;
    let release: () => void = () => {};
    const blocker = new Promise<void>((r) => { release = r; });
    const t1 = q.enqueue({ run: async () => { started = true; await blocker; return 1; } });
    await vi.waitFor(() => expect(started).toBe(true));
    const t2 = q.enqueue({ run: async () => 2 });
    expect(q.pendingCount).toBe(1);
    expect(q.isRunning).toBe(true);
    release();
    expect(await t1).toBe(1);
    expect(await t2).toBe(2);
    expect(q.isRunning).toBe(false);
  });
});
