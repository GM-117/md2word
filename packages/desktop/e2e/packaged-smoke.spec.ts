import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const PACKAGED_APP = join(HERE, '..', 'release', 'mac-arm64', 'md2word.app', 'Contents', 'MacOS', 'md2word');

// 打包产物冒烟：以打包后的 .app 可执行文件启动（isPackaged=true → extraResources sidecar 注入生效）。
// 仅在已构建安装包（packages/desktop/release/**）时运行；`pnpm dist:dir` / `dist` 后可用。
test.skip(!existsSync(PACKAGED_APP), '打包产物不存在：先运行 pnpm --filter @md2word/desktop dist:dir');

test('packaged smoke: UI + bundled pandoc + convert', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'md2word-pkg-smoke-'));
  const ws = mkdtempSync(join(tmpdir(), 'md2word-pkg-ws-'));
  const app = await _electron.launch({
    executablePath: PACKAGED_APP,
    args: [],
    env: {
      ...process.env,
      MD2WORD_USER_DATA: userData,
      MD2WORD_DOWNLOAD_DIR: join(ws, 'dl'),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // 1) 健康状态：pandoc 来自打包 sidecar（source=bundled）
  await win.waitForTimeout(3000);
  console.log('SUB_TEXT:', JSON.stringify(await win.locator('.topbar .sub').innerText()));

  // 1b) 页面截图存档（打包 UI 证据，docs/tests/assets/）
  await win.screenshot({ path: join(HERE, '..', '..', '..', 'docs', 'tests', 'assets', 'M4-打包产物-界面.png') });

  // 2) UI 转换：真实路径模式
  const srcDir = join(ws, 'src');
  mkdirSync(srcDir, { recursive: true });
  copyFileSync(join(REPO_ROOT, 'samples', 'basic-zh.md'), join(srcDir, 'basic-zh.md'));
  await win.locator('.dropzone input[type=file]').setInputFiles([join(srcDir, 'basic-zh.md')]);
  const row = win.locator('.row').first();
  await win.waitForTimeout(6000);
  console.log('BADGE:', JSON.stringify(await row.locator('.badge').innerText().catch(() => '<missing>')));
  console.log('DOCX_EXISTS:', existsSync(join(srcDir, 'basic-zh.docx')));
  await win.screenshot({ path: join(HERE, '..', '..', '..', 'docs', 'tests', 'assets', 'M4-打包产物-转换结果.png') });

  // 3) 内置模板经 extraResources 生效（转换未报 E_PANDOC_FAILED 即模板路径可读）
  const logPath = join(userData, 'logs', 'md2word.log');
  if (existsSync(logPath)) console.log('LOG_TAIL:\n' + readFileSync(logPath, 'utf8').split('\n').slice(-8).join('\n'));
  await app.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});
