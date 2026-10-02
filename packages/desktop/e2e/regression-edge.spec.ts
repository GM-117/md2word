import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const BASIC_ZH = join(REPO_ROOT, 'samples', 'basic-zh.md');
const RENDERER_DIST = join(REPO_ROOT, 'packages', 'renderer', 'dist');

// M4 回归——桌面端边界与异常场景（docs/tests/M4回归测试报告.md §5）
// 独立 userData 与下载目录，避免与其他 spec 互相污染

let app: ElectronApplication;
let win: Page;
let userData: string;
let workspace: string;

test.describe('M4 回归 · 边界与异常', () => {
  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'md2word-reg-user-'));
    workspace = mkdtempSync(join(tmpdir(), 'md2word-reg-ws-'));
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

  /** 干净目录转换，返回最后一行 */
  async function convertInCleanDir(caseName: string, mdSource: Buffer | string = readFileSync(BASIC_ZH), mdName = 'basic-zh.md') {
    const srcDir = join(workspace, caseName);
    mkdirSync(srcDir, { recursive: true });
    const mdPath = join(srcDir, mdName);
    writeFileSync(mdPath, mdSource);
    await win.locator('.dropzone input[type=file]').setInputFiles([mdPath]);
    const row = win.locator('.row').last();
    await expect(row.locator('.badge')).toContainText(/成功|失败/, { timeout: 30_000 });
    return { row, srcDir, mdPath };
  }

  test('R1 多文件 UI 转换：3 文件全部成功且行序与选择序一致', async () => {
    const srcDir = join(workspace, 'multi');
    mkdirSync(srcDir, { recursive: true });
    const names = ['第一篇.md', 'second.md', '第三篇 🎉.md'];
    for (const [i, name] of names.entries()) {
      writeFileSync(join(srcDir, name), `# 文件 ${i}\n\n内容 ${i}。\n`);
    }
    await win.locator('.dropzone input[type=file]').setInputFiles(names.map((n) => join(srcDir, n)));
    for (const [i, name] of names.entries()) {
      const row = win.locator('.row').nth(i);
      await expect(row.locator('.name')).toHaveText(name, { timeout: 30_000 });
      await expect(row.locator('.badge')).toContainText('成功');
    }
  });

  test('R2 CJK/空格/emoji 文件名 UI 转换 + 产物落位', async () => {
    const { row, srcDir } = await convertInCleanDir('cjk-ui', '# 标题\n\n正文 😊。\n', '中文 文档 😊.md');
    await expect(row.locator('.badge')).toContainText('成功');
    expect(existsSync(join(srcDir, '中文 文档 😊.docx'))).toBe(true);
  });

  test('R3 伪造产物下载被拒：未登记 jobId → 404、无新文件、页面不跳转', async () => {
    const downloads = join(workspace, 'downloads');
    const before = readdirSync(downloads).length;
    await win.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'md2word://download/00000000-0000-0000-0000-000000000000/ghost.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    await win.waitForTimeout(2500);
    expect(readdirSync(downloads).length).toBe(before);
    expect(win.url()).toContain('app://bundle/index.html');
  });

  test('R4 非法设置经 IPC 被拒并返回人话错误（不落盘）', async () => {
    const r1 = await win.evaluate(() =>
      window.md2word!.saveSettings({ tocDepth: 9 }).then(() => 'resolved').catch((e: Error) => e.message),
    );
    expect(r1).toContain('tocDepth');
    const r2 = await win.evaluate(() =>
      window.md2word!.saveSettings({ highlightStyle: 'nope' }).then(() => 'resolved').catch((e: Error) => e.message),
    );
    expect(r2).toContain('highlightStyle');
    const s = await win.evaluate(() => window.md2word!.getSettings());
    expect(s.tocDepth).not.toBe(9);
  });

  test('R5 离线模式 UI：远程图跳过显示人话警告', async () => {
    await win.locator('.opt', { hasText: '离线模式' }).locator('input').click();
    const { row } = await convertInCleanDir(
      'offline-ui',
      '# t\n\n![remote](https://example.invalid/pic.png)\n',
      'offline.md',
    );
    await expect(row.locator('.warn')).toContainText('离线模式', { timeout: 10_000 });
    // 还原
    await win.locator('.opt', { hasText: '离线模式' }).locator('input').click();
  });

  test('R6 超限文件 UI：>20MB → 失败行 + E_SOURCE_TOO_LARGE 详情', async () => {
    test.setTimeout(60_000);
    // '段。\n\n' UTF-8 编码 8 字节，280 万次 ≈ 22.4MB（> 20MB 上限）
    const big = '段。\n\n'.repeat(2_800_000);
    const { row } = await convertInCleanDir('too-large-ui', big, 'big.md');
    await expect(row.locator('.badge')).toContainText('失败', { timeout: 30_000 });
    await expect(row.locator('details summary')).toContainText('E_SOURCE_TOO_LARGE');
  });

  test('R7 重复转换同源文件：覆盖保护生效（默认不覆盖 → E_OUTPUT_EXISTS）', async () => {
    // R5 已将 offline.md 转换成功（产物 offline.docx 在源目录）；重转同文件应被覆盖保护拦截
    const mdPath = join(workspace, 'offline-ui', 'offline.md');
    expect(existsSync(join(workspace, 'offline-ui', 'offline.docx'))).toBe(true);
    await win.locator('.dropzone input[type=file]').setInputFiles([mdPath]);
    const row = win.locator('.row').last();
    await expect(row.locator('.badge')).toContainText('失败', { timeout: 30_000 });
    await expect(row.locator('.err')).toContainText('输出文件已存在');
  });
});
