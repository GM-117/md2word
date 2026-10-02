import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// E2E 前置：desktop 主进程构建（tsc + preload CJS）+ renderer 产物（Electron 以 file:// 加载）
const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const REPO = join(DESKTOP, '..', '..');

export default async function globalSetup(): Promise<void> {
  execSync('pnpm --filter @md2word/desktop build', { cwd: REPO, stdio: 'inherit' });
  execSync('pnpm --filter @md2word/renderer build', { cwd: REPO, stdio: 'inherit' });
  console.log('[e2e] desktop + renderer build ✓');
}
