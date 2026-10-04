import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * M6 批量转换 E2E：文件夹批量（stub 原生文件夹对话框）与失败重试。
 * 覆盖 US2：选文件夹 → 含子目录全部 .md 逐个成功/失败清单；失败不中断队列；
 * 重试语义：E_OUTPUT_EXISTS 失败 → 勾选覆盖 → 重试成功。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SAMPLES = join(REPO_ROOT, 'samples');
const BASIC_ZH = join(SAMPLES, 'basic-zh.md');
const RENDERER_DIST = join(REPO_ROOT, 'packages', 'renderer', 'dist');

let app: ElectronApplication;
let win: Page;
let userData: string;
let workspace: string;

test.describe('M6 批量转换', () => {
  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'md2word-m6-e2e-user-'));
    workspace = mkdtempSync(join(tmpdir(), 'md2word-m6-e2e-ws-'));
    app = await _electron.launch({
      cwd: join(REPO_ROOT, 'packages', 'desktop'),
      args: ['.'],
      env: {
        ...process.env,
        MD2WORD_USER_DATA: userData,
        MD2WORD_RENDERER_DIST: RENDERER_DIST,
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

  /** 构造批量测试树：两个子目录含同名 md + 噪声（隐藏/非 md/node_modules） */
  function buildTree(caseName: string): string {
    const root = join(workspace, caseName);
    mkdirSync(join(root, 'sub1'), { recursive: true });
    mkdirSync(join(root, 'sub2'), { recursive: true });
    copyFileSync(BASIC_ZH, join(root, '子目录外的文件.md'));
    copyFileSync(BASIC_ZH, join(root, 'sub1', '报告.md'));
    copyFileSync(BASIC_ZH, join(root, 'sub2', '报告.md'));
    writeFileSync(join(root, '.hidden.md'), '# hidden');
    writeFileSync(join(root, 'notes.txt'), 'not md');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'readme.md'), '# dep');
    return root;
  }

  /** stub 主进程 dialog.showOpenDialog → 返回指定目录（不经原生对话框） */
  async function stubFolderDialog(dir: string): Promise<void> {
    await app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    }, dir);
  }

  test('文件夹批量：递归扫描含子目录，排除隐藏/非 md/node_modules，逐个出结果', async () => {
    const root = buildTree('folder-batch');
    await stubFolderDialog(root);

    await win.getByRole('button', { name: /选择文件夹（批量）/ }).click();

    // 三行结果：根目录 + 两个子目录的同名 报告.md（relPath 展示）
    const rows = win.locator('.queue .row');
    await expect(rows).toHaveCount(3, { timeout: 60_000 });
    await expect(win.locator('.queue .row', { hasText: '子目录外的文件.md' })).toHaveCount(1);
    await expect(win.locator('.queue .row', { hasText: 'sub1/报告.md' })).toHaveCount(1);
    await expect(win.locator('.queue .row', { hasText: 'sub2/报告.md' })).toHaveCount(1);
    await expect(win.locator('.queue .row', { hasText: '.hidden.md' })).toHaveCount(0);
    await expect(win.locator('.queue .row', { hasText: 'readme.md' })).toHaveCount(0);

    // 全部成功（失败不中断队列的反向验证：本用例无失败项）
    await expect(win.locator('.queue .row.done')).toHaveCount(3, { timeout: 60_000 });
    await expect(win.getByText('成功 3')).toBeVisible();

    // 重名产物各自登记：两条 报告.md 行都有可用的「打开」按钮（outputKey 已登记）
    for (const rel of ['sub1/报告.md', 'sub2/报告.md']) {
      const row = win.locator('.queue .row', { hasText: rel });
      await expect(row.getByRole('button', { name: '打开', exact: true })).toBeVisible();
    }
    // 产物落各自源目录
    expect(existsSync(join(root, 'sub1', '报告.docx'))).toBe(true);
    expect(existsSync(join(root, 'sub2', '报告.docx'))).toBe(true);
    expect(existsSync(join(root, '子目录外的文件.docx'))).toBe(true);
  });

  test('重试：覆盖关闭时重转 E_OUTPUT_EXISTS 失败 → 勾选覆盖 → 重试成功', async () => {
    const srcDir = join(workspace, 'retry-flow');
    mkdirSync(srcDir, { recursive: true });
    const mdCopy = join(srcDir, 'basic-zh.md');
    copyFileSync(BASIC_ZH, mdCopy);

    // 第一次：成功
    await win.locator('.dropzone input[type=file]').setInputFiles([mdCopy]);
    const row = win.locator('.queue .row', { hasText: 'basic-zh.md' }).first();
    await expect(row).toHaveClass(/done/, { timeout: 60_000 });

    // 第二次（覆盖默认关闭）：失败 E_OUTPUT_EXISTS，失败行出现「重试」按钮
    await win.locator('.dropzone input[type=file]').setInputFiles([mdCopy]);
    const failedRow = win.locator('.queue .row', { hasText: 'basic-zh.md' }).first();
    await expect(failedRow).toHaveClass(/failed/, { timeout: 60_000 });
    await expect(failedRow).toContainText('E_OUTPUT_EXISTS');
    const retryBtn = failedRow.getByRole('button', { name: '重试', exact: true });
    await expect(retryBtn).toBeVisible();

    // 直接重试仍失败（产物还在）；勾选覆盖后重试成功
    await retryBtn.click();
    const retriedRow = win.locator('.queue .row', { hasText: 'basic-zh.md' }).first();
    await expect(retriedRow).toHaveClass(/failed/, { timeout: 60_000 });

    const overwrite = win.locator('.opt', { hasText: '覆盖同名输出' }).locator('input');
    await overwrite.check();
    await retriedRow.getByRole('button', { name: '重试', exact: true }).click();
    await expect(win.locator('.queue .row', { hasText: 'basic-zh.md' }).first()).toHaveClass(/done/, { timeout: 60_000 });
  });
});
