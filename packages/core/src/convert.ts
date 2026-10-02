import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { absolutizeImagePaths, assertSourceUsable, countFencedCodeBlocks, readSourceText, SourceError, writeTempMarkdown } from './preprocess.js';
import { resolvePandocInfo, runPandoc } from './pandoc.js';
import { CORE_ROOT, getBundledReferenceDocx } from './template.js';
import { computeStats, openDocx } from './validate.js';
import type { ConvertOptions, ConvertResult, ErrorCode, Warning } from './types.js';
import { DEFAULT_TIMEOUT_MS } from './types.js';

export { SourceError } from './preprocess.js';

// ---------------------------------------------------------------------------
// 选项 → pandoc 参数映射（快照测试目标；§2.6 / §4）
// ---------------------------------------------------------------------------

/** 输出路径推导：outputDir 优先，否则与源文件同目录；同名 .docx */
export function resolveOutputPath(srcPath: string, outputDir?: string): string {
  const src = resolve(srcPath);
  const stem = basename(src).replace(/\.(md|markdown|mdown|mkd)$/i, '');
  const dir = outputDir ? resolve(outputDir) : dirname(src);
  return join(dir, `${stem}.docx`);
}

/**
 * 构建 pandoc 参数数组（禁 shell:true，§4.1）。
 * 输入/输出一律走临时文件（§4.2），成功后由调用方原子改名。
 */
export function buildPandocArgs(paths: {
  inputMd: string;
  outputDocx: string;
  sourceDir: string;
  referenceDocx?: string;
  offlineFilterPath?: string;
}, opts: ConvertOptions): string[] {
  const args: string[] = [
    paths.inputMd,
    '--from', 'markdown',
    '--to', 'docx',
    '--output', paths.outputDocx,
    '--resource-path', paths.sourceDir,
  ];

  if (opts.toc) {
    args.push('--toc');
    if (opts.tocDepth !== undefined) args.push('--toc-depth', String(opts.tocDepth));
  }
  if (opts.numberSections) args.push('--number-sections');
  if (opts.highlightStyle) args.push('--highlight-style', opts.highlightStyle);
  if (paths.referenceDocx) args.push('--reference-doc', paths.referenceDocx);
  if (opts.metadata?.title !== undefined) args.push('--metadata', `title=${opts.metadata.title}`);
  if (opts.metadata?.author !== undefined) args.push('--metadata', `author=${opts.metadata.author}`);
  if (opts.offline && paths.offlineFilterPath) args.push('--lua-filter', paths.offlineFilterPath);

  return args;
}

// ---------------------------------------------------------------------------
// stderr 分类（§5.3 错误分类表）
// ---------------------------------------------------------------------------

interface StderrWarningPattern {
  code: Warning['code'];
  re: RegExp;
  message: (detail: string) => string;
}

const STDERR_WARNINGS: StderrWarningPattern[] = [
  {
    code: 'W_IMAGE_FETCH',
    re: /Could not fetch resource\s+([^\s,]+)/g,
    message: (d) => `图片 ${d} 获取失败，已保留占位（可开启离线模式跳过）`,
  },
  {
    code: 'W_MATH',
    re: /Could not convert TeX math ([^\s,]+)/g,
    message: (d) => `公式 ${d} 解析失败，已按原文输出`,
  },
  {
    code: 'W_IMAGE_OFFLINE',
    re: /\[MD2WORD\] OFFLINE-IMAGE-SKIPPED: (\S+)/g,
    message: (d) => `离线模式：已跳过远程图片 ${d}`,
  },
];

/** pandoc stderr → 结构化 warnings（按出现顺序，同资源去重；detail 去除尾随标点） */
export function classifyStderr(stderr: string): Warning[] {
  const warnings: Warning[] = [];
  const seen = new Set<string>();
  for (const p of STDERR_WARNINGS) {
    for (const m of stderr.matchAll(p.re)) {
      const detail = (m[1] ?? '').trim().replace(/[.,:;]+$/, '');
      const key = `${p.code}:${detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({ code: p.code, message: p.message(detail), detail: detail || undefined });
    }
  }
  return warnings;
}

/** 失败原因细分：模板相关错误单列（§5.3 E_TEMPLATE_INVALID） */
export function classifyFailure(stderr: string): 'E_TEMPLATE_INVALID' | 'E_PANDOC_FAILED' {
  if (/reference[- ]doc|template/i.test(stderr)) return 'E_TEMPLATE_INVALID';
  return 'E_PANDOC_FAILED';
}

function stderrTail(stderr: string, max = 2000): string {
  const s = stderr.trim();
  return s.length > max ? s.slice(-max) : s;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 单文件转换。域错误（文件不存在/超时/pandoc 失败等）一律通过
 * 返回值 ConvertResult.error 表达，不抛异常；只有编程性错误才 throw。
 */
export async function convertMarkdown(srcPath: string, opts: ConvertOptions = {}): Promise<ConvertResult> {
  const started = Date.now();
  const warnings: Warning[] = [];

  const fail = (code: ErrorCode, message: string, tail?: string): ConvertResult => ({
    ok: false,
    durationMs: Date.now() - started,
    warnings,
    error: tail === undefined ? { code, message } : { code, message, stderrTail: tail },
  });

  // 1. pandoc sidecar 就位
  const pandoc = await resolvePandocInfo();
  if (pandoc === null) {
    return fail('E_PANDOC_NOT_FOUND', '未找到 pandoc 转换引擎（sidecar）。请重新安装应用或设置 PANDOC_PATH。');
  }

  // 2. 输入校验
  try {
    assertSourceUsable(srcPath);
  } catch (err) {
    if (err instanceof SourceError) return fail(err.code, err.message);
    throw err;
  }

  // 3. 输出路径与覆盖策略
  const outputPath = resolveOutputPath(srcPath, opts.outputDir);
  if (!opts.overwrite) {
    try {
      statSync(outputPath);
      return fail('E_OUTPUT_EXISTS', `输出文件已存在：${outputPath}（可勾选“覆盖输出”重试）`);
    } catch {
      // 不存在 → 继续
    }
  }

  // 4. 预处理：读文本 → 图片路径绝对化 → 临时 md（§4.2/§4.3）
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'md2word-'));
  const tempMdPath = writeTempMarkdown('', srcPath, tmpDir);
  const tempDocxPath = join(tmpDir, 'out.docx');
  try {
    const sourceText = readSourceText(srcPath);
    const prepared = absolutizeImagePaths(sourceText, srcPath);
    const fenceStats = countFencedCodeBlocks(sourceText);
    writeFileSync(tempMdPath, prepared.text, 'utf8');

    // 5. 组参数并 spawn（参数数组、UTF-8、超时 kill 进程树）
    const referenceDocx = opts.referenceDocx ?? getBundledReferenceDocx() ?? undefined;
    // MD2WORD_LUA_FILTER：宿主注入（desktop 打包后 core 在 asar 内，pandoc 子进程读不到虚拟路径，
    // 过滤器须落在 extraResources 真实文件系统；与 PANDOC_PATH/MD2WORD_PANDOC_BIN 注入模式一致）
    const offlineFilterPath = opts.offline
      ? (process.env.MD2WORD_LUA_FILTER ?? join(CORE_ROOT, 'assets', 'offline-images.lua'))
      : undefined;
    const args = buildPandocArgs(
      {
        inputMd: tempMdPath,
        outputDocx: tempDocxPath,
        sourceDir: prepared.sourceDir,
        ...(referenceDocx !== undefined ? { referenceDocx } : {}),
        ...(offlineFilterPath !== undefined ? { offlineFilterPath } : {}),
      },
      opts,
    );
    const run = await runPandoc(pandoc.path, args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (run.timedOut) {
      return fail('E_TIMEOUT', `转换超过 ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s 已终止（文件过大或图片过多）`, stderrTail(run.stderr));
    }
    if (run.cancelled) {
      return fail('E_CANCELLED', '转换已被取消。');
    }
    if (run.code !== 0) {
      const kind = classifyFailure(run.stderr);
      const message = kind === 'E_TEMPLATE_INVALID'
        ? '模板文件无效或不被 pandoc 接受（请基于默认模板修改，或改用内置模板重试）'
        : '转换失败（pandoc 报错，详见完整日志）';
      return fail(kind, message, stderrTail(run.stderr));
    }

    // 6. 产物校验（zip 完整性 + document.xml 可解析）与统计
    const outBuf = readFileSync(tempDocxPath);
    const opened = openDocx(outBuf);
    if (!opened.ok) {
      return fail('E_PANDOC_FAILED', `pandoc 已退出但产物无效：${opened.reason}`, stderrTail(run.stderr));
    }
    const stats = computeStats(opened.contents!.documentXml, opened.contents?.footnotesXml);
    stats.plainCodeBlocks = fenceStats.total - fenceStats.withLanguage;

    // 7. 原子落盘：拷贝到目标目录的 .moving 中转名，再同盘 rename（§1.4 不产生半成品）
    mkdirSync(dirname(outputPath), { recursive: true });
    const movingPath = `${outputPath}.moving`;
    copyFileSync(tempDocxPath, movingPath);
    try {
      renameSync(movingPath, outputPath);
    } catch {
      // Windows：目标存在时 rename 可能报错，先删后改（窗口极小）
      try { unlinkSync(outputPath); } catch { /* 目标不存在 */ }
      renameSync(movingPath, outputPath);
    }

    // 8. warnings 组装（§4.4/§4.5 + stderr 分类）
    warnings.push(...classifyStderr(run.stderr));
    if (stats.plainCodeBlocks > 0) {
      warnings.push({
        code: 'W_PLAIN_CODE_BLOCK',
        message: `有 ${stats.plainCodeBlocks} 个代码块未标注语言，未做语法高亮（可补语言标注后重试）`,
        detail: String(stats.plainCodeBlocks),
      });
    }
    if (opts.toc) {
      warnings.push({
        code: 'W_TOC_FIELD',
        message: '目录为 Word 域指令：打开文档后按 Ctrl/Cmd+A 全选，再按 F9 更新域即可显示页码',
      });
    }

    return {
      ok: true,
      outputPath,
      durationMs: Date.now() - started,
      stats,
      warnings,
    };
  } finally {
    // 临时目录清理（任何路径都不留半成品）
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
}

// ---------------------------------------------------------------------------
// 批量：串行队列（失败不中断；v1.0 供宿主复用，M6 做 UI 与递归扫描）
// ---------------------------------------------------------------------------

/** 顺序逐个转换；单个失败（ok=false）不中断队列；收到 abort 后停止派发 */
export async function* convertBatch(srcPaths: string[], opts: ConvertOptions): AsyncGenerator<ConvertResult> {
  for (const p of srcPaths) {
    if (opts.signal?.aborted) break;
    yield await convertMarkdown(p, opts);
  }
}
