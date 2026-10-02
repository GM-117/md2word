import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * 桌面开发：等待 renderer 的 Vite dev server（127.0.0.1:5173）就绪后拉起 Electron。
 * 用法：pnpm --filter @md2word/desktop dev（配合另一终端 pnpm --filter @md2word/renderer dev，
 * 或根目录 pnpm dev:desktop 一键双开）。
 */
const URL_TO_WAIT = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';
const TIMEOUT_MS = 60_000;

async function waitForServer(url: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.status < 500) return;
    } catch {
      // 未就绪，继续轮询
    }
    if (Date.now() - started > TIMEOUT_MS) {
      throw new Error(`等待 ${url} 超时——请先启动 renderer dev server（pnpm --filter @md2word/renderer dev）`);
    }
    await delay(500);
  }
}

await waitForServer(URL_TO_WAIT);
console.log(`[desktop] renderer 就绪：${URL_TO_WAIT}，启动 Electron…`);
const child = spawn('electron', ['.'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: URL_TO_WAIT },
});
child.on('exit', (code) => process.exit(code ?? 0));
