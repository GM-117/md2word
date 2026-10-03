import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const PACKAGED_APP = join(HERE, '..', 'release', 'mac-arm64', 'md2word.app', 'Contents', 'MacOS', 'md2word');
const ASSETS = join(REPO_ROOT, 'docs', 'tests', 'assets');

// 一次性截图脚本：打包应用 + 转换一次 → 截取 UX 优化效果（最近文件/高亮预览/模板概览）
test.skip(!existsSync(PACKAGED_APP), '打包产物不存在');

test('ux screenshots', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'md2word-ux-shot-'));
  const ws = mkdtempSync(join(tmpdir(), 'md2word-ux-shot-ws-'));
  const app = await _electron.launch({
    executablePath: PACKAGED_APP,
    args: [],
    env: { ...process.env, MD2WORD_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  const srcDir = join(ws, 'src');
  mkdirSync(srcDir, { recursive: true });
  const md = join(srcDir, '项目说明.md');
  writeFileSync(md, '# 项目说明\n\n这是一个演示文档，用于展示转换效果。\n\n```js\nconst greeting = "你好";\n```\n', 'utf8');
  await win.locator('.dropzone input[type=file]').setInputFiles([md]);
  await win.waitForTimeout(4000);
  await win.screenshot({ path: join(ASSETS, 'UI体验优化-最近文件与转换结果.png') });

  // 展开目录 TOC 显示高亮预览 + 模板概览
  await win.locator('.opt', { hasText: '生成目录（TOC）' }).locator('input').click();
  await win.locator('.panel', { hasText: '文档模板' }).scrollIntoViewIfNeeded();
  await win.waitForTimeout(600);
  await win.screenshot({ path: join(ASSETS, 'UI体验优化-高亮预览与模板概览.png') });

  await app.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});
