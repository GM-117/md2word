import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PandocInfo } from './types.js';

// ---------------------------------------------------------------------------
// sidecar 定位
// 优先级（开发计划 §2.4.3 / §4.7）：
//   1. PANDOC_PATH 环境变量（用户改用系统自装 pandoc 的通道）
//   2. MD2WORD_PANDOC_BIN（宿主注入：desktop 打包后的 extraResources / 测试注入）
//   3. core 内置开发缓存 assets/bin/<version>/<platform>/pandoc（fetch-pandoc.mjs 产物）
//   4. 系统 PATH 中的 pandoc（兜底）
// ---------------------------------------------------------------------------

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(CORE_ROOT, 'assets', 'pandoc.lock.json');

let cached: PandocInfo | null | undefined;

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return existsSync(p);
  } catch {
    return false;
  }
}

function platformDir(): string {
  const p = process.platform === 'win32' ? 'win32' : process.platform;
  return `${p}-${process.arch}`;
}

function devCachePath(): string {
  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { version: string };
    const exe = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
    return join(CORE_ROOT, 'assets', 'bin', lock.version, platformDir(), exe);
  } catch {
    const exe = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
    return join(CORE_ROOT, 'assets', 'bin', 'unknown', platformDir(), exe);
  }
}

async function queryVersion(bin: string): Promise<string | null> {
  try {
    const res = await runPandoc(bin, ['--version'], { timeoutMs: 10_000 });
    if (res.code !== 0) return null;
    const firstLine = res.stderr.length > 0 && res.stdout.length === 0 ? res.stderr : res.stdout;
    const m = /pandoc(?:\.exe)?\s+(\S+)/.exec(firstLine.split(/\r?\n/, 1)[0] ?? '');
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * 定位 pandoc sidecar 并返回版本信息；找不到返回 null。
 * 结果进程内缓存；测试可用 resetPandocCache() 重置。
 */
export async function resolvePandocInfo(): Promise<PandocInfo | null> {
  if (cached !== undefined) return cached;

  const candidates: Array<{ path: string; source: PandocInfo['source'] }> = [];
  if (process.env.PANDOC_PATH) candidates.push({ path: process.env.PANDOC_PATH, source: 'env' });
  if (process.env.MD2WORD_PANDOC_BIN) candidates.push({ path: process.env.MD2WORD_PANDOC_BIN, source: 'bundled' });
  candidates.push({ path: devCachePath(), source: 'bundled' });
  candidates.push({ path: 'pandoc', source: 'path' });

  for (const c of candidates) {
    if (c.source !== 'path' && !isExecutable(c.path)) continue;
    const version = await queryVersion(c.path);
    if (version !== null) {
      cached = { version, path: c.path, source: c.source };
      return cached;
    }
  }
  cached = null;
  return null;
}

/** 同步版：仅用于已知路径的场景（宿主启动自检失败提示） */
export function resetPandocCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// spawn（一律参数数组，禁 shell:true —— 开发计划 §4.1）
// ---------------------------------------------------------------------------

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 传给子进程的环境（默认继承） */
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 因超时被 kill */
  timedOut: boolean;
  /** 因外部 signal 被 kill */
  cancelled: boolean;
  durationMs: number;
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows：taskkill /T 连同子进程树一起终止
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    // POSIX：spawn 时 detached 使子进程成为独立进程组，负 pid 杀全组
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }
}

/** 运行 pandoc 子进程；超时或外部取消时 kill 整个进程树（§1.4 可靠性） */
export function runPandoc(binPath: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(binPath, args, {
      windowsHide: true,
      // POSIX 下独立进程组，便于 kill(-pid) 整组终止；Windows 无进程组语义，走 taskkill
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => { stdout += d; });
    child.stderr!.on('data', (d: string) => { stderr += d; });

    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs)
      : null;

    const onAbort = () => { cancelled = true; killTree(child); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolveRun({
        code,
        stdout,
        stderr,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (err) => {
      // spawn 本身失败（二进制缺失/权限）——以 stderr 承载原因，code 记 -1
      stderr += `\n[spawn error] ${err.message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}
