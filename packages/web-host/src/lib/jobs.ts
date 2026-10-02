import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SerialQueue, convertMarkdown } from '@md2word/core';
import type { ConvertOptions, ConvertResult } from '@md2word/core';
import type { LogBuffer } from './logger.js';

export interface JobItemResult extends ConvertResult {
  /** 上传时的原始文件名（含中文/空格/emoji） */
  name: string;
  /** 下载端点（ok 时存在） */
  downloadUrl?: string;
}

export interface JobResult {
  jobId: string;
  items: JobItemResult[];
}

export type ConvertPhase = 'queued' | 'converting' | 'done' | 'failed';

export interface JobItemState {
  name: string;
  phase: ConvertPhase;
  result?: JobItemResult;
}

export interface JobState {
  jobId: string;
  dir: string;
  items: JobItemState[];
}

/**
 * 转换作业管理：上传文件落盘 → SerialQueue 串行转换 → 结果含下载端点。
 * 失败不中断队列（US2 口径的 v1.0 单文件队列形态）。
 */
export class JobManager {
  private queue = new SerialQueue();
  private jobs = new Map<string, JobState>();

  constructor(
    private readonly dataDir: string,
    private readonly logger: LogBuffer,
  ) {
    mkdirSync(this.jobsRoot(), { recursive: true });
  }

  private jobsRoot(): string {
    return join(this.dataDir, 'jobs');
  }

  get pendingCount(): number {
    return this.queue.pendingCount;
  }

  get isRunning(): boolean {
    return this.queue.isRunning;
  }

  /** 创建作业（文件已由路由保存到 dir），登记状态 */
  createJob(dir: string, names: string[]): JobState {
    const jobId = randomUUID();
    const state: JobState = {
      jobId,
      dir,
      items: names.map((name) => ({ name, phase: 'queued' })),
    };
    this.jobs.set(jobId, state);
    return state;
  }

  /** 把作业逐项入队（队列内串行执行）；resolve 在全部处理完后触发 */
  enqueueJob(state: JobState, baseOptions: ConvertOptions): Promise<JobResult> {
    const { jobId, dir } = state;
    const tasks = state.items.map((item): Promise<void> =>
      this.queue.enqueue({
        label: item.name,
        run: async (signal) => {
          const srcPath = join(dir, item.name);
          item.phase = 'converting';
          this.logger.info(`convert start: ${item.name} (job ${jobId.slice(0, 8)})`);
          const result = await convertMarkdown(srcPath, { ...baseOptions, overwrite: true, signal });
          item.phase = result.ok ? 'done' : 'failed';
          item.result = {
            ...result,
            name: item.name,
            ...(result.ok
              ? { downloadUrl: `/api/download/${jobId}/${encodeURIComponent(result.outputPath!.split(/[\\/]/).pop()!)}` }
              : {}),
          };
          if (result.ok) {
            this.logger.info(`convert ok: ${item.name} → ${result.outputPath} (${result.durationMs}ms, warnings=${result.warnings.length})`);
          } else {
            this.logger.warn(`convert failed: ${item.name} code=${result.error?.code} ${result.error?.message ?? ''}`);
          }
        },
      }).catch((err: unknown) => {
        item.phase = 'failed';
        item.result = {
          ok: false,
          durationMs: 0,
          warnings: [],
          name: item.name,
          error: { code: 'E_PANDOC_FAILED', message: err instanceof Error ? err.message : String(err) },
        };
        this.logger.error(`convert threw: ${item.name} ${err instanceof Error ? err.message : String(err)}`);
      }),
    );

    return (async () => {
      await Promise.all(tasks);
      return {
        jobId,
        items: state.items.map((i) => i.result!).filter((r): r is JobItemResult => Boolean(r)),
      };
    })();
  }

  /** 取消当前 + 清空等待 */
  cancelAll(): number {
    this.logger.warn('cancel requested: aborting running conversion and clearing queue');
    return this.queue.cancelAll('用户取消');
  }

  /** 作业目录（供下载/打开路由做白名单校验） */
  jobDir(jobId: string): string | null {
    const state = this.jobs.get(jobId);
    return state ? state.dir : null;
  }

  /** 在系统文件管理器中打开目录 / 用系统默认程序打开文件（US1） */
  async openPath(target: string, mode: 'file' | 'folder'): Promise<boolean> {
    const abs = resolve(target);
    if (!abs.startsWith(resolve(this.jobsRoot()))) {
      throw new Error('仅允许打开作业产物目录');
    }
    const { spawn } = await import('node:child_process');
    const openBin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const args = process.platform === 'win32'
      ? [abs]
      : mode === 'folder' ? [abs] : ['-R', abs]; // macOS：-R 在 Finder 中显示文件
    return new Promise((resolveOpen) => {
      const child = spawn(openBin, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolveOpen(false));
      child.on('close', (code) => resolveOpen(code === 0));
      child.unref();
    });
  }

  /** 清理：删除作业目录（下载后的临时副本） */
  cleanupJob(jobId: string): void {
    const dir = this.jobDir(jobId);
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      this.jobs.delete(jobId);
    }
  }
}
