import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const RENDERER_DIST = join(REPO_ROOT, 'packages', 'renderer', 'dist');

// UX 优化回归（docs/tests/UI体验优化回归报告.md）：
// ① 最近文件点击重转 ② 取消转换按需显示 + 页脚导出日志 ③ 高亮风格示意预览 ④ 模板样式概览

let app: ElectronApplication;
let win: Page;
let userData: string;
let workspace: string;

test.describe('UX 优化（桌面端）', () => {
  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'md2word-ux-user-'));
    workspace = mkdtempSync(join(tmpdir(), 'md2word-ux-ws-'));
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
    rmSync(userData, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test('U4 空闲时「取消转换」不显示；导出日志弱化到页脚', async () => {
    await expect(win.locator('h1')).toHaveText('md2word', { timeout: 15_000 });
    await expect(win.getByRole('button', { name: '取消转换' })).toHaveCount(0);
    await expect(win.locator('.foot').getByRole('link', { name: '导出日志' })).toBeVisible();
    await expect(win.locator('.topbar-actions').getByRole('link', { name: '导出日志' })).toHaveCount(0);
  });

  test('U1 模板样式概览：内置中文模板显示宋体/黑体/Consolas 概览与示意', async () => {
    const preview = win.locator('.tpl-preview');
    await expect(preview).toBeVisible({ timeout: 10_000 });
    await expect(preview.locator('.hint')).toContainText('内置中文模板');
    await expect(preview.locator('.hint')).toContainText('宋体');
    await expect(preview.locator('.hint')).toContainText('黑体');
    await expect(preview.locator('.hint')).toContainText('Consolas');
    await expect(preview.locator('.hint')).toContainText('1.5 倍行距');
    // 示意文字应用模板字体（黑体标题）
    const hFont = await preview.locator('.ts-h').evaluate((el) => getComputedStyle(el).fontFamily);
    expect(hFont).toContain('SimHei');
    // 切到 pandoc 默认样式 → 概览随之切换
    await win.locator('.panel', { hasText: '文档模板' }).locator('select').selectOption('pandoc-default');
    await expect(preview.locator('.hint')).toContainText('pandoc 默认样式', { timeout: 10_000 });
    await win.locator('.panel', { hasText: '文档模板' }).locator('select').selectOption('builtin-zh');
  });

  test('U2 高亮风格示意预览：默认折叠，展开后随选择切换配色', async () => {
    const details = win.locator('.hl-details');
    const preview = win.locator('.hl-preview');
    // 默认折叠：不占选项区空间
    await expect(details).toBeVisible();
    await expect(preview).not.toBeVisible();
    // 展开后可见
    await details.locator('summary').click();
    await expect(preview).toBeVisible();
    const bgBefore = await preview.evaluate((el) => getComputedStyle(el).backgroundColor);
    await win.locator('.opt', { hasText: '代码块高亮风格' }).locator('select').selectOption('zenburn');
    const bgAfter = await preview.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bgBefore).not.toBe(bgAfter);
    await expect(preview.locator('.hl-preview-note')).toContainText('zenburn');
    // 还原默认风格并收起
    await win.locator('.opt', { hasText: '代码块高亮风格' }).locator('select').selectOption('pygments');
    await details.locator('summary').click();
  });

  test('U6 模板文件下载：md2word://template → 确定性落盘（PK 魔数）', async () => {
    const downloads = join(workspace, 'downloads');
    const before = readdirSync(downloads).length;
    await win.locator('.tpl-export').dispatchEvent('click');
    await expect
      .poll(async () => readdirSync(downloads).filter((f) => f.endsWith('.docx')).length, { timeout: 15_000 })
      .toBeGreaterThan(before);
    const file = readdirSync(downloads).filter((f) => f.endsWith('.docx')).map((f) => join(downloads, f)).at(-1)!;
    expect(readFileSync(file).subarray(0, 2).toString()).toBe('PK');
    // 页面不跳转
    expect(win.url()).toContain('app://bundle/index.html');
  });

  test.skip('U3 最近文件点击重新转换：默认覆盖保护下先失败，勾选覆盖后成功（UI 暂时隐藏）', async () => {
    const srcDir = join(workspace, 'reconvert');
    mkdirSync(srcDir, { recursive: true });
    const mdPath = join(srcDir, '重转测试.md');
    writeFileSync(mdPath, '# 重转\n\n内容。\n', 'utf8');
    await win.locator('.dropzone input[type=file]').setInputFiles([mdPath]);
    const firstRow = win.locator('.row').first();
    await expect(firstRow.locator('.badge')).toContainText('成功', { timeout: 30_000 });

    // 最近文件 chip 出现且可点击（桌面端）
    const chip = win.locator('.recent-chip', { hasText: '重转测试.md' });
    await expect(chip).toBeVisible();
    await chip.locator('.chip-name').click();
    const reRow = win.locator('.row').first();
    await expect(reRow.locator('.badge')).toContainText('失败', { timeout: 30_000 });
    await expect(reRow.locator('.err')).toContainText('输出文件已存在');

    // 勾选覆盖同名输出后再点击 chip → 成功
    await win.locator('.opt', { hasText: '覆盖同名输出' }).locator('input').click();
    await chip.locator('.chip-name').click();
    await expect(win.locator('.row').first().locator('.badge')).toContainText('成功', { timeout: 30_000 });
    expect(existsSync(join(srcDir, '重转测试.docx'))).toBe(true);
    // 还原覆盖开关
    await win.locator('.opt', { hasText: '覆盖同名输出' }).locator('input').click();
  });

  test.skip('U5 最近文件一键清空：确认后清空并持久化（重启窗口仍为空）（UI 暂时隐藏）', async () => {
    const srcDir = join(workspace, 'clear-ui');
    mkdirSync(srcDir, { recursive: true });
    const mdPath = join(srcDir, '清空测试.md');
    writeFileSync(mdPath, '# 清空\n\n内容。\n', 'utf8');
    await win.locator('.dropzone input[type=file]').setInputFiles([mdPath]);
    await expect(win.locator('.recent-chip').first()).toBeVisible({ timeout: 30_000 });

    // 原生 confirm 对话框：接受
    win.once('dialog', (d) => void d.accept());
    await win.locator('.recent-clear').click();
    await expect(win.locator('.recent-chip')).toHaveCount(0);

    // 重载后仍为空（recentFiles 持久化已清）
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.recent-chip')).toHaveCount(0, { timeout: 15_000 });
  });

  test('U7 模板闭环：下载当前模板 → 原样导入 → 导入成功（D32）', async () => {
    const downloads = join(workspace, 'downloads');
    const before = readdirSync(downloads).length;
    await win.locator('.tpl-export').dispatchEvent('click');
    await expect
      .poll(async () => readdirSync(downloads).filter((f) => f.endsWith('.docx')).length, { timeout: 15_000 })
      .toBeGreaterThan(before);
    const file = readdirSync(downloads).filter((f) => f.endsWith('.docx')).map((f) => join(downloads, f)).at(-1)!;
    // 用户工作流闭环：下载的模板原样导回（Word 修改后再导入同路径），必须被接受
    await win.locator('input[type=file][accept=".docx"]').setInputFiles(file);
    await expect(
      win.locator('.panel', { hasText: '文档模板' }).locator('.tpl-msg'),
    ).toContainText('导入成功', { timeout: 10_000 });
  });
});
