import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CANCEL_REASON, SerialQueue, convertMarkdown, type ConvertOptions, type ConvertStats, type HighlightStyle } from '@md2word/core';
import type { LogBuffer } from './logger.js';
import type { JobRegistry } from './jobs.js';
import { buildDownloadUrl } from './resourceUrl.js';
import type { TemplateService } from './templates.js';

/** 渲染层传来的文件条目：path 模式（真实文件，优先）/ bytes 模式（虚拟文件回退，如 E2E） */
export interface ConvertEntry {
  name: string;
  path?: string;
  bytes?: Uint8Array;
}

/** 与 renderer ConvertOptionsPayload 契约一致（web-host multipart options 字段同构） */
export interface ConvertOptionsPayload {
  toc?: boolean;
  tocDepth?: number;
  numberSections?: boolean;
  highlightStyle?: string;
  offline?: boolean;
  overwrite?: boolean;
  metadata?: { title?: string; author?: string };
  template?: string;
}

export interface ConvertItemResult {
  ok: boolean;
  outputPath?: string;
  durationMs: number;
  stats?: ConvertStats;
  warnings: Array<{ code: string; message: string; detail?: string }>;
  error?: { code: string; message: string; stderrTail?: string };
  name: string;
  /** open/download 共用的登记键（唯一化产物 basename；文件夹批量下重名产物加 N- 前缀） */
  outputKey?: string;
  downloadUrl?: string;
}

export interface JobResult {
  jobId: string;
  items: ConvertItemResult[];
}

const MD_RE = /\.(md|markdown|mdown|mkd)$/i;

interface PreparedMd {
  name: string;
  srcPath: string;
  staged: boolean;
}

/**
 * 转换服务（IPC convert:file / convert:batch 的实现）：
 * - path 模式：直接从源位置转换，产物写源文件同目录（桌面语义），尊重"覆盖同名输出"开关；
 * - bytes 模式：与 web-host 上传等价，staged 到作业目录，产物落作业目录（覆盖写）；
 * - 设置合并 / 模板解析链与 web-host 完全一致；串行队列失败不中断；
 * - M6：entry.name 允许含子目录的展示名（文件夹批量），产物登记键唯一化（重名产物加 N- 前缀）。
 */
export class ConvertService {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly jobsRoot: string,
    private readonly registry: JobRegistry,
    private readonly templates: TemplateService,
    private readonly settingsAll: () => Record<string, unknown>,
    private readonly settingsSet: (patch: Record<string, unknown>) => void,
    private readonly logger: LogBuffer,
  ) {}

  get pendingCount(): number {
    return this.queue.pendingCount;
  }

  get isRunning(): boolean {
    return this.queue.isRunning;
  }

  cancelAll(): number {
    this.logger.warn('cancel requested: aborting running conversion and clearing queue');
    return this.queue.cancelAll(CANCEL_REASON);
  }

  async run(
    entries: ConvertEntry[],
    options: ConvertOptionsPayload,
    onItem?: (index: number, item: ConvertItemResult, jobId: string) => void,
  ): Promise<JobResult> {
    const all = Array.isArray(entries) ? entries : [];
    // 仅 bytes 模式（staged md/资源）需要作业目录；纯 path 模式产物落源目录，不建空目录（D34）
    const needsStaging = all.some((e) => e?.bytes instanceof Uint8Array);
    const jobDir = join(this.jobsRoot, randomUUID());
    if (needsStaging) mkdirSync(jobDir, { recursive: true });

    // 落位：md 与资源分开处理；staged 重名按 web-host 策略加 `N-` 前缀。
    // name 保留调用方给的展示名（文件夹批量时为含子目录的相对路径），落盘名一律取 basename。
    const usedNames = new Set<string>();
    const mdEntries: PreparedMd[] = [];
    for (const entry of all) {
      const name = String(entry?.name ?? '').replace(/\0/g, '');
      if (!name || !MD_RE.test(name)) continue;
      if (typeof entry.path === 'string' && entry.path.length > 0) {
        mdEntries.push({ name, srcPath: entry.path, staged: false });
      } else if (entry.bytes instanceof Uint8Array) {
        const stagedName = dedupeStagedName(usedNames, basename(name));
        usedNames.add(stagedName);
        const stagedPath = join(jobDir, stagedName);
        writeFileSync(stagedPath, entry.bytes);
        mdEntries.push({ name, srcPath: stagedPath, staged: true });
      } else {
        mdEntries.push({ name, srcPath: '', staged: true }); // 无内容 → 结果报 E_SOURCE_NOT_FOUND
      }
    }
    for (const res of all) {
      const name = basename(String(res?.name ?? ''));
      // staged 资源文件（bytes 模式的图片等）落盘供相对路径引用；path 模式资源已在真实位置，忽略
      if (!name || MD_RE.test(name)) continue;
      if (res.bytes instanceof Uint8Array) {
        writeFileSync(join(jobDir, name), res.bytes);
      }
    }

    if (mdEntries.length === 0) {
      throw new Error('未收到任何 .md 文件（支持 .md/.markdown/.mdown/.mkd）');
    }

    const merged = await this.mergeOptions(options);
    const jobId = this.registry.createJob(jobDir);
    this.logger.info(
      `job accepted: ${mdEntries.length} file(s), options=${JSON.stringify({
        toc: merged.toc,
        offline: merged.offline,
        template: merged.referenceDocx ? basename(merged.referenceDocx) : undefined,
      })}`,
    );

    const userOverwrite = this.settingsAll().overwrite === true;
    // 产物登记键逐项分配（键 = 唯一化的产物 basename）：文件夹批量下不同子目录的同名文件
    // 产物 basename 相同，按完成序加 `N-` 前缀消解（串行队列 → 完成序 = 提交序，确定性不变），
    // downloadUrl/open 都走该键；键随单项结果即时可用（流式进度 M6+）
    const usedOutputKeys = new Set<string>();
    const uniqueOutputKey = (outputPath: string): string => {
      const base = basename(outputPath);
      let key = base;
      let n = 1;
      while (usedOutputKeys.has(key)) key = `${++n}-${base}`;
      usedOutputKeys.add(key);
      return key;
    };

    const items = await Promise.all(
      mdEntries.map(async (entry, index): Promise<ConvertItemResult> => {
        if (!entry.srcPath) {
          const item: ConvertItemResult = {
            ok: false,
            durationMs: 0,
            warnings: [],
            name: entry.name,
            error: { code: 'E_SOURCE_NOT_FOUND', message: '文件内容不可读（路径模式需要真实文件）' },
          };
          onItem?.(index, item, jobId);
          return item;
        }
        try {
          const r = await this.queue.enqueue({
            label: entry.name,
            run: async (signal) => {
              this.logger.info(`convert start: ${entry.name} (job ${jobId.slice(0, 8)})`);
              const res = await convertMarkdown(entry.srcPath, {
                ...merged,
                overwrite: entry.staged ? true : userOverwrite,
                signal,
              });
              if (res.ok && res.outputPath) {
                this.logger.info(
                  `convert ok: ${entry.name} → ${res.outputPath} (${res.durationMs}ms, warnings=${res.warnings.length})`,
                );
              } else {
                this.logger.warn(`convert failed: ${entry.name} code=${res.error?.code} ${res.error?.message ?? ''}`);
              }
              return res;
            },
          });
          const item: ConvertItemResult = {
            ok: r.ok,
            durationMs: r.durationMs,
            stats: r.stats,
            warnings: r.warnings,
            ...(r.ok && r.outputPath ? { outputPath: r.outputPath } : { error: r.error }),
            name: entry.name,
          };
          if (r.ok && r.outputPath) {
            const key = uniqueOutputKey(r.outputPath);
            this.registry.addOutput(jobId, key, r.outputPath);
            item.outputKey = key;
            item.downloadUrl = buildDownloadUrl(jobId, key);
          }
          onItem?.(index, item, jobId);
          return item;
        } catch (err) {
          this.logger.error(`convert threw: ${entry.name} ${err instanceof Error ? err.message : String(err)}`);
          const message = err instanceof Error ? err.message : String(err);
          const item: ConvertItemResult = {
            ok: false,
            durationMs: 0,
            warnings: [],
            name: entry.name,
            // 整队取消的待执行任务以 rejection 落到这里：与在跑任务的 E_CANCELLED 统一口径
            error:
              message === CANCEL_REASON
                ? { code: 'E_CANCELLED', message: '转换已被取消。' }
                : { code: 'E_PANDOC_FAILED', message },
          };
          onItem?.(index, item, jobId);
          return item;
        }
      }),
    );

    this.recordRecentPaths(mdEntries);
    return { jobId, items };
  }

  /**
   * 登记最近文件的源路径（桌面端"点击最近文件重新转换"的数据源）：
   * 仅 path 模式的真实文件；键裁剪到渲染层维护的 recentFiles 列表内（上限 10）。
   */
  private recordRecentPaths(mdEntries: PreparedMd[]): void {
    try {
      const s = this.settingsAll();
      const recentFiles = Array.isArray(s.recentFiles) ? (s.recentFiles as string[]) : [];
      if (recentFiles.length === 0) return;
      const merged: Record<string, string> = { ...((s.recentPaths ?? {}) as Record<string, string>) };
      let changed = false;
      for (const e of mdEntries) {
        // 仅登记纯 basename 的源（文件夹批量的相对路径名不进最近文件登记表）
        if (!e.staged && e.srcPath && !e.name.includes('/') && !e.name.includes('\\') && merged[e.name] !== e.srcPath) {
          merged[e.name] = e.srcPath;
          changed = true;
        }
      }
      const ordered: Record<string, string> = {};
      for (const name of recentFiles.slice(0, 10)) {
        if (merged[name]) ordered[name] = merged[name];
      }
      if (changed || JSON.stringify(ordered) !== JSON.stringify(s.recentPaths ?? {})) {
        this.settingsSet({ recentPaths: ordered });
      }
    } catch {
      // 记录失败不影响转换结果
    }
  }

  /** 设置合并（web-host /api/convert 同构）：设置兜底 + 请求覆盖；模板由设置链解析（template 键由渲染层剥离） */
  private async mergeOptions(options: ConvertOptionsPayload): Promise<ConvertOptions> {
    const s = this.settingsAll();
    const merged: ConvertOptions = {
      toc: options.toc ?? s.toc === true,
      tocDepth: coerceTocDepth(options.tocDepth ?? (s.tocDepth as number)),
      numberSections: options.numberSections ?? s.numberSections === true,
      highlightStyle: (options.highlightStyle as HighlightStyle | undefined) ?? (s.highlightStyle as HighlightStyle) ?? 'pygments',
      offline: options.offline ?? s.offline === true,
      referenceDocx: await this.templates.resolveTemplate(),
      metadata: {
        title: typeof s.metaTitle === 'string' && s.metaTitle ? s.metaTitle : undefined,
        author: typeof s.metaAuthor === 'string' && s.metaAuthor ? s.metaAuthor : undefined,
      },
    };
    if (options.metadata?.title || options.metadata?.author) {
      merged.metadata = { title: options.metadata.title, author: options.metadata.author };
    }
    if (merged.metadata && !merged.metadata.title && !merged.metadata.author) delete merged.metadata;
    return merged;
  }
}

/** staged md 重名消解：`2-a.md`、`3-a.md` …（与 web-host 一致） */
function dedupeStagedName(used: Set<string>, name: string): string {
  if (!used.has(name)) return name;
  let n = 1;
  let candidate: string;
  do {
    candidate = `${++n}-${name}`;
  } while (used.has(candidate));
  return candidate;
}

/** tocDepth 收敛到 1-6（越界回 3），满足 core 的字面量类型 */
function coerceTocDepth(n: number | undefined): 1 | 2 | 3 | 4 | 5 | 6 {
  const d = Math.round(Number(n));
  return (d >= 1 && d <= 6 ? d : 3) as 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * 启动清扫（D34）：作业注册表在内存中，重启后 userData/jobs 下的历史作业目录全部不可达
 * （open/download 均被拒），属纯垃圾——启动时清掉防止累积占盘；清扫失败不阻断启动。
 */
export function sweepStaleJobDirs(jobsRoot: string, log?: (msg: string) => void): void {
  try {
    let removed = 0;
    for (const name of readdirSync(jobsRoot)) {
      rmSync(join(jobsRoot, name), { recursive: true, force: true });
      removed += 1;
    }
    if (removed > 0) log?.(`startup sweep: removed ${removed} stale job dir(s)`);
  } catch {
    /* jobsRoot 不存在（首次启动）或清扫失败：跳过 */
  }
}
