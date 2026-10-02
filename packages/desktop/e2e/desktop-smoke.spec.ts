import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SAMPLES = join(REPO_ROOT, 'samples');
const BASIC_ZH = join(SAMPLES, 'basic-zh.md');
const BUILTIN_DOCX = join(REPO_ROOT, 'packages', 'core', 'assets', 'reference-zh.docx');
const BROKEN_DOCX = join(REPO_ROOT, 'packages', 'web-host', 'e2e', 'fixtures', 'broken-template.docx');
const RENDERER_DIST = join(REPO_ROOT, 'packages', 'renderer', 'dist');

// M4 桌面 E2E：Playwright _electron 走真实 IPC 桥（preload contextBridge + ipcMain 白名单）
// 覆盖 P0 用户故事：启动健康 / US1 转换（bytes+path 双模式）/ US4 选项 / US5 日志 / US6 持久化 / M3 模板

let app: ElectronApplication;
let win: Page;
let userData: string;
let workspace: string;

const savedCopies: string[] = [];

test.describe('M4 桌面冒烟', () => {
  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'md2word-e2e-user-'));
    workspace = mkdtempSync(join(tmpdir(), 'md2word-e2e-ws-'));
    mkdirSync(join(workspace, 'downloads'), { recursive: true });
    app = await _electron.launch({
      cwd: join(REPO_ROOT, 'packages', 'desktop'),
      args: ['.'],
      env: {
        ...process.env,
        MD2WORD_USER_DATA: userData,
        MD2WORD_RENDERER_DIST: RENDERER_DIST,
        MD2WORD_DOWNLOAD_DIR: join(workspace, 'downloads'),
      },
    });
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await app.close();
    for (const p of savedCopies) rmSync(p, { force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  /** 每个用例自包含：把样例复制进干净目录并经 UI 转换，返回（行定位器, 源目录） */
  async function convertInCleanDir(caseName: string) {
    const srcDir = join(workspace, caseName);
    mkdirSync(srcDir, { recursive: true });
    const mdCopy = join(srcDir, 'basic-zh.md');
    copyFileSync(BASIC_ZH, mdCopy);
    await win.locator('.dropzone input[type=file]').setInputFiles([mdCopy]);
    const row = win.locator('.row').last();
    await expect(row.locator('.badge')).toContainText('成功', { timeout: 30_000 });
    return { row, srcDir };
  }

  test('T1 启动健康：窗口渲染 + 桥存在 + pandoc bundled 定位', async () => {
    await expect(win.locator('h1')).toHaveText('md2word');
    await expect(win.locator('.topbar .sub')).toContainText('桥接正常', { timeout: 20_000 });
    await expect(win.locator('.topbar .sub')).toContainText(/pandoc 3\.12/);
    const platform = await win.evaluate(() => window.md2word?.platform);
    expect(platform).toBe(process.platform);
  });

  test('T2 US1 转换（UI 真实路径模式）：选文件 → 成功结果 + 统计 + md2word:// 下载锚点', async () => {
    // 桌面端产物写源文件同目录（webUtils.getPathForFile 拿到真实路径）；
    // 源目录已有同名 .docx 时按"覆盖同名输出"设置报 E_OUTPUT_EXISTS（T2b 单独验证该失败路径）
    const { row, srcDir } = await convertInCleanDir('ui-convert');
    await expect(row.locator('.stats')).toContainText('标题 9');
    expect(existsSync(join(srcDir, 'basic-zh.docx'))).toBe(true);
    const href = await row.getByRole('link', { name: '下载 .docx' }).getAttribute('href');
    expect(href).toMatch(/^md2word:\/\/download\//);
  });

  test('T3b 失败路径（UI）：产物已存在且未开覆盖 → E_OUTPUT_EXISTS 人话错误', async () => {
    // 对 T2 已成功转换过的源目录再转一次（默认不覆盖 → 冲突）
    await win.locator('.dropzone input[type=file]').setInputFiles([join(workspace, 'ui-convert', 'basic-zh.md')]);
    const lastRow = win.locator('.row').last();
    await expect(lastRow.locator('.badge')).toContainText('失败', { timeout: 30_000 });
    await expect(lastRow.locator('.err')).toContainText('输出文件已存在');
    await expect(lastRow.locator('details summary')).toContainText('E_OUTPUT_EXISTS');
  });

  test('T3 US1 下载锚点：md2word:// attachment → 浏览器式下载（PK 魔数）', async () => {
    const { row } = await convertInCleanDir('ui-download');
    // 主进程 protocol.handle 返回 attachment → Chromium 下载管线（页面不跳转）；
    // will-download 在 E2E（MD2WORD_DOWNLOAD_DIR）下确定性落盘；生产为 Electron 原生保存对话框
    await row.getByRole('link', { name: '下载 .docx' }).dispatchEvent('click');
    const downloads = join(workspace, 'downloads');
    await expect
      .poll(async () => readdirSync(downloads).filter((f) => f.endsWith('.docx')).length, {
        timeout: 15_000,
        message: '下载副本应出现在 MD2WORD_DOWNLOAD_DIR',
      })
      .toBeGreaterThanOrEqual(1);
    const file = readdirSync(downloads).filter((f) => f.endsWith('.docx')).map((f) => join(downloads, f)).at(-1)!;
    expect(readFileSync(file).subarray(0, 2).toString()).toBe('PK');
    // 页面不跳转
    expect(win.url()).toContain('app://bundle/index.html');
  });

  test('T4 US1 path 模式（IPC 直测）：真实文件 → 产物写源目录', async () => {
    const srcDir = join(workspace, 'path-mode');
    mkdirSync(srcDir, { recursive: true });
    const mdPath = join(srcDir, 'ipc-直测.md');
    copyFileSync(BASIC_ZH, mdPath);
    const result = await win.evaluate(async (p) => {
      const job = await window.md2word!.convert([{ name: 'ipc-直测.md', path: p }], {});
      return { ok: job.items[0]!.ok, outputPath: job.items[0]!.outputPath };
    }, mdPath);
    expect(result.ok).toBe(true);
    expect(result.outputPath).toBe(join(srcDir, 'ipc-直测.docx'));
    expect(existsSync(result.outputPath!)).toBe(true);
  });

  test('T5 打开产物：open:path 白名单 → shell.openPath 收到 .docx', async () => {
    const { row } = await convertInCleanDir('ui-open');
    await app.evaluate(({ shell }) => {
      (globalThis as { __opened?: string[] }).__opened = [];
      shell.openPath = async (p: string) => {
        (globalThis as { __opened?: string[] }).__opened!.push(p);
        return '';
      };
    });
    await row.getByRole('button', { name: '打开', exact: true }).click();
    const opened = await app.evaluate(() => (globalThis as { __opened?: string[] }).__opened);
    expect(opened?.length).toBeGreaterThanOrEqual(1);
    expect(opened!.at(-1)).toMatch(/\.docx$/);
  });

  test('T6 US5 日志导出：md2word://log 拦截 → txt 落盘含 [INFO]', async () => {
    const saveTo = join(workspace, 'exported-log.txt');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) as never;
    }, saveTo);
    savedCopies.push(saveTo);
    // target=_blank → setWindowOpenHandler 拦截（非导航），dispatchEvent 保持一致语义
    await win.getByRole('link', { name: '导出日志' }).dispatchEvent('click');
    await expect
      .poll(async () => existsSync(saveTo), { timeout: 10_000, message: '日志 txt 应在存盘对话框后落盘' })
      .toBe(true);
    expect(readFileSync(saveTo, 'utf8')).toContain('[INFO]');
  });

  test('T7 M3 模板：导入合法模板成功；无效模板被拒并提示缺失样式', async () => {
    const validCopy = join(workspace, '合法模板.docx');
    copyFileSync(BUILTIN_DOCX, validCopy);
    await win.locator('input[type=file][accept=".docx"]').setInputFiles(validCopy);
    await expect(
      win.locator('.panel', { hasText: '文档模板' }).locator('.hint'),
    ).toContainText('导入成功', { timeout: 10_000 });

    await win.locator('input[type=file][accept=".docx"]').setInputFiles(BROKEN_DOCX);
    await expect(
      win.locator('.panel', { hasText: '文档模板' }).locator('.err'),
    ).toContainText('缺少必需样式', { timeout: 10_000 });
  });

  test('T8 US6 设置持久化：勾选 TOC → 重载后保持（electron-store 落盘）', async () => {
    const toc = win.locator('.opt', { hasText: '生成目录（TOC）' }).locator('input');
    await toc.click();
    // settings:set 即时落盘；reload 后 UI 从 settings:get 恢复
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    const tocAfter = win.locator('.opt', { hasText: '生成目录（TOC）' }).locator('input');
    await expect(tocAfter).toBeChecked({ timeout: 15_000 });
    // 还原默认，避免影响收尾状态
    await tocAfter.click();
    await expect(tocAfter).not.toBeChecked();
  });
});
