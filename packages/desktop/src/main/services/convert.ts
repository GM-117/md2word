import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SerialQueue, convertMarkdown, type ConvertOptions, type ConvertStats, type HighlightStyle } from '@md2word/core';
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
 * - 设置合并 / 模板解析链与 web-host 完全一致；串行队列失败不中断。
 */
export class ConvertService {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly jobsRoot: string,
    private readonly registry: JobRegistry,
    private readonly templates: TemplateService,
    private readonly settingsAll: () => Record<string, unknown>,
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
    return this.queue.cancelAll('用户取消');
  }

  async run(entries: ConvertEntry[], options: ConvertOptionsPayload): Promise<JobResult> {
    const all = Array.isArray(entries) ? entries : [];
    const jobDir = join(this.jobsRoot, randomUUID());
    mkdirSync(jobDir, { recursive: true });

    // 落位：md 与资源分开处理；staged 重名按 web-host 策略加 `N-` 前缀
    const usedNames = new Set<string>();
    const mdEntries: PreparedMd[] = [];
    for (const entry of all) {
      const name = basename(String(entry?.name ?? ''));
      if (!name || !MD_RE.test(name)) continue;
      if (typeof entry.path === 'string' && entry.path.length > 0) {
        mdEntries.push({ name, srcPath: entry.path, staged: false });
      } else if (entry.bytes instanceof Uint8Array) {
        const stagedName = dedupeStagedName(usedNames, name);
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
    const items = await Promise.all(
      mdEntries.map(async (entry): Promise<ConvertItemResult> => {
        if (!entry.srcPath) {
          return {
            ok: false,
            durationMs: 0,
            warnings: [],
            name: entry.name,
            error: { code: 'E_SOURCE_NOT_FOUND', message: '文件内容不可读（路径模式需要真实文件）' },
          };
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
                this.registry.addOutput(jobId, entry.name, res.outputPath);
                this.logger.info(
                  `convert ok: ${entry.name} → ${res.outputPath} (${res.durationMs}ms, warnings=${res.warnings.length})`,
                );
              } else {
                this.logger.warn(`convert failed: ${entry.name} code=${res.error?.code} ${res.error?.message ?? ''}`);
              }
              return res;
            },
          });
          return {
            ok: r.ok,
            durationMs: r.durationMs,
            stats: r.stats,
            warnings: r.warnings,
            ...(r.ok && r.outputPath
              ? { outputPath: r.outputPath, downloadUrl: buildDownloadUrl(jobId, basename(r.outputPath)) }
              : { error: r.error }),
            name: entry.name,
          };
        } catch (err) {
          this.logger.error(`convert threw: ${entry.name} ${err instanceof Error ? err.message : String(err)}`);
          return {
            ok: false,
            durationMs: 0,
            warnings: [],
            name: entry.name,
            error: { code: 'E_PANDOC_FAILED', message: err instanceof Error ? err.message : String(err) },
          };
        }
      }),
    );

    return { jobId, items };
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
