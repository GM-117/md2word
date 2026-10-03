import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SAMPLES = join(REPO_ROOT, 'samples');
const BASIC_ZH = join(SAMPLES, 'basic-zh.md');
const BASIC_IMG = join(SAMPLES, 'test_img.png');

// M2 DoD：Playwright Web 冒烟（选文件→转换→结果出现）+ US1/US4/US5/US6 浏览器验收

test.describe('M2 Web 冒烟', () => {
  test('页面加载：健康状态显示 pandoc sidecar 版本', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('md2word');
    await expect(page.locator('.topbar .sub')).toContainText('pandoc 3.12', { timeout: 15_000 });
    await expect(page.locator('.dropzone')).toBeVisible();
  });

  test('US1：选择文件（含附带图片资源）→ 转换 → 成功结果 + 下载产物', async ({ page }) => {
    await page.goto('/');
    await page.locator('.dropzone input[type=file]').setInputFiles([BASIC_ZH, BASIC_IMG]);
    const row = page.locator('.row');
    await expect(row).toBeVisible();
    await expect(row.locator('.badge')).toContainText('成功', { timeout: 30_000 });

    // 结果统计与黄金样例口径一致（9 标题 1 表 1 图 2 公式 1 脚注 1 代码块）
    await expect(row.locator('.stats')).toContainText('标题 9');
    await expect(row.locator('.stats')).toContainText('表格 1');
    await expect(row.locator('.stats')).toContainText('图片 1');

    // 下载产物为合法 zip（PK 魔数）
    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('link', { name: '下载 .docx' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    const head = readFileSync(path!).subarray(0, 2).toString();
    expect(head).toBe('PK');
  });

  test('US4：勾选 TOC → 转换 → 域更新提示（选项即时生效）', async ({ page }) => {
    await page.goto('/');
    await page.locator('.opt', { hasText: '生成目录（TOC）' }).locator('input').click();
    await page.locator('.dropzone input[type=file]').setInputFiles([BASIC_ZH, BASIC_IMG]);
    const row = page.locator('.row');
    await expect(row.locator('.badge')).toContainText('成功', { timeout: 30_000 });
    await expect(row.locator('.warn').first()).toContainText('F9', { timeout: 10_000 });
    // 还原
    await page.locator('.opt', { hasText: '生成目录（TOC）' }).locator('input').click();
  });

  test('US6：设置持久化——勾选离线模式后刷新仍在', async ({ page }) => {
    await page.goto('/');
    const offline = page.locator('.opt', { hasText: '离线模式' }).locator('input[type=checkbox]');
    await offline.click();
    await page.reload();
    await expect(offline).toBeChecked();
    // 还原默认，避免影响其他用例
    await offline.click();
    await expect(offline).not.toBeChecked();
  });

  test('取消转换按钮：空闲时不显示（按需出现，避免误触）', async ({ page }) => {
    await page.goto('/');
    await page.locator('.status-dot').waitFor();
    await expect(page.getByRole('button', { name: '取消转换' })).toHaveCount(0);
    // 导出日志已弱化到页脚
    await expect(page.locator('.foot').getByRole('link', { name: '导出日志' })).toBeVisible();
  });

  test.skip('US6：最近文件——单条删除并持久化（UI 暂时隐藏）', async ({ page }) => {
    await page.goto('/');
    // 转换一次确保产生记录（前面用例已写入时命中同一 chip，幂等）
    await page.locator('.dropzone input[type=file]').setInputFiles([BASIC_ZH]);
    const chip = page.locator('.recent-chip', { hasText: 'basic-zh.md' });
    await expect(chip).toBeVisible();
    await chip.locator('.chip-x').click();
    await expect(chip).toHaveCount(0);
    // 刷新后仍不出现（删除已持久化）
    await page.reload();
    await expect(page.locator('.recent-chip', { hasText: 'basic-zh.md' })).toHaveCount(0);
  });

  test.skip('US6：最近文件——一键清空（确认后清空并持久化）（UI 暂时隐藏）', async ({ page }) => {
    await page.goto('/');
    await page.locator('.dropzone input[type=file]').setInputFiles([BASIC_ZH]);
    await expect(page.locator('.recent-chip').first()).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await page.locator('.recent-clear').click();
    await expect(page.locator('.recent-chip')).toHaveCount(0);
    // 刷新后仍为空（清空已持久化）
    await page.reload();
    await expect(page.locator('.recent-chip')).toHaveCount(0);
  });

  test('M3：模板文件下载（内置中文模板，合法 zip）', async ({ page }) => {
    await page.goto('/');
    const tplSelect = page.locator('.panel', { hasText: '文档模板' }).locator('select');
    await tplSelect.selectOption('builtin-zh');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.tpl-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('内置中文模板');
    expect(readFileSync(await download.path()).subarray(0, 2).toString()).toBe('PK');
    // 闭环：把下载的模板原样导回（D32：导出件必须能通过导入校验）
    await page.locator('input[type=file][accept=".docx"]').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: readFileSync(await download.path()),
    });
    await expect(
      page.locator('.panel', { hasText: '文档模板' }).locator('.tpl-msg'),
    ).toContainText('导入成功', { timeout: 10_000 });
  });

  test('队列：最新转换结果显示在列表首位', async ({ page }) => {
    await page.goto('/');
    const EMPTY = join(REPO_ROOT, 'samples', 'empty.md');
    await page.locator('.dropzone input[type=file]').setInputFiles([BASIC_ZH]);
    await expect(page.locator('.row').first()).toContainText('成功', { timeout: 30_000 });
    await page.locator('.dropzone input[type=file]').setInputFiles([EMPTY]);
    const first = page.locator('.row').first();
    await expect(first).toContainText('empty.md', { timeout: 30_000 });
    await expect(first.locator('.badge')).toContainText('成功');
  });

  test('US5：日志一键导出（md2word-log.txt，含 [INFO] 记录）', async ({ page }) => {
    await page.goto('/');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: '导出日志' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('md2word-log.txt');
    const text = readFileSync(await download.path(), 'utf8');
    expect(text).toContain('[INFO]');
  });

  test('M3：模板面板——内置中文模板可选，导入无效模板被拒并提示', async ({ page }) => {
    await page.goto('/');
    // 内置模板在下拉中
    const tplSelect = page.locator('.panel', { hasText: '文档模板' }).locator('select');
    await expect(tplSelect.locator('option[value="builtin-zh"]')).toHaveCount(1);
    // 导入无效 .docx → 提示缺失样式
    const bad = join(REPO_ROOT, 'packages', 'web-host', 'e2e', 'fixtures', 'broken-template.docx');
    await page.locator('input[type=file][accept=".docx"]').setInputFiles(bad);
    await expect(page.locator('.panel', { hasText: '文档模板' }).locator('.err')).toContainText('缺少必需样式', { timeout: 10_000 });
  });

  test('M3：模板选择真实生效——切到 pandoc-default 后产物不含中文字体', async ({ page }) => {
    await page.goto('/');
    const tplSelect = page.locator('.panel', { hasText: '文档模板' }).locator('select');
    await tplSelect.selectOption('pandoc-default');
    await page.locator('.dropzone input[type=file]').setInputFiles([BASIC_ZH, BASIC_IMG]);
    const row = page.locator('.row');
    await expect(row.locator('.badge')).toContainText('成功', { timeout: 30_000 });
    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('link', { name: '下载 .docx' }).click();
    const download = await downloadPromise;
    const { unzipSync } = await import('fflate');
    const stylesXml = new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync(await download.path())))['word/styles.xml']);
    expect(stylesXml).not.toContain('SimSun');
    // 还原默认模板
    await tplSelect.selectOption('builtin-zh');
  });

  test('M3：元数据面板——标题/作者写入 docx 核心属性', async ({ page }) => {
    await page.goto('/');
    const metaPanel = page.locator('.panel', { hasText: '元数据' });
    await metaPanel.locator('input').first().fill('端到端元数据标题');
    await metaPanel.locator('input').nth(1).fill('端到端作者');
    await page.locator('.dropzone input[type=file]').setInputFiles([BASIC_ZH, BASIC_IMG]);
    const row = page.locator('.row');
    await expect(row.locator('.badge')).toContainText('成功', { timeout: 30_000 });
    // 下载并检查 dc:title / dc:creator
    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('link', { name: '下载 .docx' }).click();
    const download = await downloadPromise;
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    const coreXml = new TextDecoder().decode(files['docProps/core.xml']);
    expect(coreXml).toContain('<dc:title>端到端元数据标题</dc:title>');
    expect(coreXml).toContain('端到端作者');
  });
});
