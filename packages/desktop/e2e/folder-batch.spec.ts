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

    // 直接重试仍失败（产物还在）；旧失败行标记"已重试"：不重复计数、按钮隐藏（D35）
    // 注意：重试后新行插到最前，.first() 指向新失败行，旧行用 .nth(1) 定位
    await retryBtn.click();
    const retriedRow = win.locator('.queue .row', { hasText: 'basic-zh.md' }).first();
    await expect(retriedRow).toHaveClass(/failed/, { timeout: 60_000 });
    const oldRow = win.locator('.queue .row', { hasText: 'basic-zh.md' }).nth(1);
    await expect(win.getByText('重试失败项（1）')).toBeVisible(); // 旧失败行不再计入（否则会显示 2）
    await expect(oldRow.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    await expect(oldRow).toContainText('已重新转换');

    // 勾选"覆盖同名输出"后重试 → 成功，重试入口消失
    const overwrite = win.locator('.opt', { hasText: '覆盖同名输出' }).locator('input');
    await overwrite.check();
    await retriedRow.getByRole('button', { name: '重试', exact: true }).click();
    await expect(win.locator('.queue .row', { hasText: 'basic-zh.md' }).first()).toHaveClass(/done/, { timeout: 60_000 });
    await expect(win.getByText(/重试失败项/)).toHaveCount(0);
  });

  test('取消批量（D35/M6+流式）：逐行实时翻转，剩余项统一 E_CANCELLED，一键重试成功', async () => {
    // 5 个 ~6MB 文件（单个 ≈3s，串行 ≈15s）；结果整批返回前，已完成行应先行翻转（流式进度）
    const srcDir = join(workspace, 'cancel-batch');
    mkdirSync(srcDir, { recursive: true });
    const big = '# 大文件\n\n' + '这是一个足够长的段落用于拖慢转换速度。\n\n'.repeat(90_000);
    const paths: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const p = join(srcDir, `big-${i}.md`);
      writeFileSync(p, big, 'utf8');
      paths.push(p);
    }

    await win.locator('.dropzone input[type=file]').setInputFiles(paths);
    const cancelBtn = win.getByRole('button', { name: '取消转换' });
    await expect(cancelBtn).toBeVisible({ timeout: 60_000 });

    // 流式断言：big-1 落定（≈3s）时其余 4 行仍是"转换中"——逐行翻转而非整批一起变
    await expect(win.locator('.queue .row.done', { hasText: 'big-1.md' })).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('.queue .row.converting', { hasText: 'big-' })).toHaveCount(4);

    // 首个完成后立即取消：剩余 4 项全部失败且统一为 E_CANCELLED「转换已被取消。」
    await cancelBtn.click();
    const failedRows = win.locator('.queue .row.failed', { hasText: 'E_CANCELLED' });
    await expect(failedRows).toHaveCount(4, { timeout: 60_000 });
    await expect(win.getByText('重试失败项（4）')).toBeVisible();

    // 一键重试 → 全部成功；旧失败行标记"已重试"，重试入口消失（不可重复点击建任务）
    await win.getByRole('button', { name: /重试失败项/ }).click();
    for (let i = 2; i <= 5; i += 1) {
      await expect(win.locator('.queue .row', { hasText: `big-${i}.md` }).first()).toHaveClass(/done/, {
        timeout: 60_000,
      });
    }
    await expect(win.getByText(/重试失败项/)).toHaveCount(0);
  });

  test('D36：点击"选择文件（可多选）"触发文件选择对话框，而非被文件夹按钮劫持', async () => {
    // 主进程对话框打桩计数：文件夹对话框被调用即记一次（返回 canceled 防原生对话框阻塞）
    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { __folderCalls: number }).__folderCalls = 0;
      dialog.showOpenDialog = async () => {
        (dialog as unknown as { __folderCalls: number }).__folderCalls += 1;
        return { canceled: true, filePaths: [] };
      };
    });
    // 渲染层监听文件 input 的 click（label 隐式转发会在其上派发 click 事件）
    await win.evaluate(() => {
      const w = window as typeof window & { __d36FileClick?: boolean };
      w.__d36FileClick = false;
      document.querySelector('.dropzone input[type="file"]')!.addEventListener('click', () => {
        w.__d36FileClick = true;
      });
    });

    await win.locator('.dropzone .button.primary').click();

    const fileClick = await win.evaluate(() => (window as typeof window & { __d36FileClick?: boolean }).__d36FileClick);
    const folderCalls = await app.evaluate(({ dialog }) => (dialog as unknown as { __folderCalls: number }).__folderCalls);
    expect(fileClick).toBe(true);   // label 转发命中文件 input
    expect(folderCalls).toBe(0);    // 不开文件夹对话框
  });
});
