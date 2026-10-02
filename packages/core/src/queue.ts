/**
 * 串行任务队列：宿主（web-host / desktop）用它保证同一时刻至多一个 pandoc 在跑，
 * 任务间互不干扰；支持清空待执行任务与整队取消（convert:cancel 通道）。
 */
export interface QueueTask<T> {
  run: (signal: AbortSignal) => Promise<T>;
  /** 任务标签（日志/展示用，如源文件路径） */
  label?: string;
}

interface PendingJob<T> {
  task: QueueTask<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  controller: AbortController;
}

export class SerialQueue {
  private pending: PendingJob<unknown>[] = [];
  private running = false;

  get pendingCount(): number {
    return this.pending.length;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 入队；返回任务结果 promise（任务被取消则 reject） */
  enqueue<T>(task: QueueTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: PendingJob<unknown> = {
        task: task as QueueTask<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        controller: new AbortController(),
      };
      this.pending.push(job);
      void this.drain();
    });
  }

  /** 当前在跑任务的取消信号（无在跑任务返回 undefined） */
  currentSignal(): AbortSignal | undefined {
    return this.current?.controller.signal;
  }

  /** 取消当前在跑任务 + 清空等待队列；被取消任务 reject */
  cancelAll(reason = 'queue cancelled'): number {
    let n = 0;
    if (this.current) {
      this.current.controller.abort(new Error(reason));
      n += 1;
    }
    const rest = this.pending.splice(0, this.pending.length);
    for (const job of rest) {
      job.reject(new Error(reason));
      n += 1;
    }
    return n;
  }

  private current: PendingJob<unknown> | null = null;

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()!;
        this.current = job;
        try {
          const value = await job.task.run(job.controller.signal);
          job.resolve(value);
        } catch (err) {
          job.reject(err);
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
