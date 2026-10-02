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
    await expect(tplSelect.locator('option', { hasText: '内置中文模板' })).toHaveCount(1);
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
