import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CANCEL_REASON, SerialQueue, convertMarkdown } from '@md2word/core';
import type { ConvertOptions, ConvertResult } from '@md2word/core';
import type { LogBuffer } from './logger.js';

export interface JobItemResult extends ConvertResult {
  /** 上传时的原始文件名（含中文/空格/emoji；文件夹批量为含子目录的相对路径） */
  name: string;
  /** open/download 共用的登记键（唯一化产物 basename；M6 文件夹批量下重名产物加 N- 前缀） */
  outputKey?: string;
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
  /** 本作业已使用的产物登记键（唯一化用） */
  usedKeys: Set<string>;
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
    this.sweepStaleJobDirs();
  }

  private jobsRoot(): string {
    return join(this.dataDir, 'jobs');
  }

  /**
   * 启动清扫（D34）：作业注册表在内存中，重启后历史作业目录全部不可达（下载/打开均被拒），
   * 属于纯垃圾——启动时整目录清掉，防止 .data/jobs 无限累积占盘。运行期间产生的作业保留至下次启动。
   */
  private sweepStaleJobDirs(): void {
    let removed = 0;
    try {
      for (const name of readdirSync(this.jobsRoot())) {
        rmSync(join(this.jobsRoot(), name), { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // 清扫失败不阻断启动
    }
    if (removed > 0) this.logger.info(`startup sweep: removed ${removed} stale job dir(s)`);
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
      usedKeys: new Set<string>(),
    };
    this.jobs.set(jobId, state);
    return state;
  }

  /** 产物登记键唯一化：同名 basename 按 `N-` 前缀消解（M6 文件夹批量：不同子目录可产出同名 docx） */
  private uniqueKey(state: JobState, outputPath: string): string {
    const base = outputPath.split(/[\\/]/).pop()!;
    let key = base;
    let n = 1;
    while (state.usedKeys.has(key)) key = `${++n}-${base}`;
    state.usedKeys.add(key);
    return key;
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
          if (result.ok) {
            const key = this.uniqueKey(state, result.outputPath!);
            item.result = {
              ...result,
              name: item.name,
              outputKey: key,
              downloadUrl: `/api/download/${jobId}/${encodeURIComponent(key)}`,
            };
          } else {
            item.result = { ...result, name: item.name };
          }
          if (result.ok) {
            this.logger.info(`convert ok: ${item.name} → ${result.outputPath} (${result.durationMs}ms, warnings=${result.warnings.length})`);
          } else {
            this.logger.warn(`convert failed: ${item.name} code=${result.error?.code} ${result.error?.message ?? ''}`);
          }
        },
      }).catch((err: unknown) => {
        item.phase = 'failed';
        // 整队取消的待执行任务以 rejection 落到这里：与在跑任务的 E_CANCELLED 统一口径
        const message = err instanceof Error ? err.message : String(err);
        item.result = {
          ok: false,
          durationMs: 0,
          warnings: [],
          name: item.name,
          error:
            message === CANCEL_REASON
              ? { code: 'E_CANCELLED', message: '转换已被取消。' }
              : { code: 'E_PANDOC_FAILED', message },
        };
        this.logger.error(`convert threw: ${item.name} ${message}`);
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
    return this.queue.cancelAll(CANCEL_REASON);
  }

  /** 作业目录（供下载/打开路由做白名单校验） */
  jobDir(jobId: string): string | null {
    const state = this.jobs.get(jobId);
    return state ? state.dir : null;
  }

  /**
   * 按登记键（outputKey）解析该作业的产物 docx 路径（下载/open 路由数据源）；
   * 兼容旧调用：键不匹配时回退按上传名匹配（D30 语义）。
   */
  findOutputPath(jobId: string, key: string): string | null {
    const state = this.jobs.get(jobId);
    if (!state) return null;
    for (const item of state.items) {
      if (item.result?.ok && item.result.outputPath) {
        if ((item.result.outputKey && item.result.outputKey === key) || item.name === key) {
          return item.result.outputPath;
        }
      }
    }
    return null;
  }

  /**
   * 用系统方式打开产物：file = 默认程序打开文件；reveal = 在文件管理器中定位该文件。
   * （D30：原先 file 模式在 macOS 走 `open -R` 定位的是 staged 的 .md，用户感知为"打开的是源文件目录"）
   */
  async openPath(target: string, mode: 'file' | 'reveal'): Promise<boolean> {
    const abs = resolve(target);
    if (!abs.startsWith(resolve(this.jobsRoot()))) {
      throw new Error('仅允许打开作业产物目录');
    }
    const { spawn } = await import('node:child_process');
    let openBin: string;
    let args: string[];
    if (process.platform === 'darwin') {
      openBin = 'open';
      args = mode === 'reveal' ? ['-R', abs] : [abs];
    } else if (process.platform === 'win32') {
      openBin = 'explorer';
      args = mode === 'reveal' ? ['/select,', abs] : [abs];
    } else {
      openBin = 'xdg-open';
      args = [mode === 'reveal' ? dirname(abs) : abs];
    }
    return new Promise((resolveOpen) => {
      const child = spawn(openBin, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolveOpen(false));
      // Windows 的 explorer 即使成功也常返回退出码 1
      child.on('close', (code) => resolveOpen(process.platform === 'win32' ? code === 0 || code === 1 : code === 0));
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
