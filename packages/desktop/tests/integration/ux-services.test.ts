import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServices, type AppServices } from '../../src/main/context.js';
import { DEFAULT_SETTINGS, type KvStore } from '../../src/main/services/settings.js';
import { validateTemplate } from '@md2word/core';
import { summarizeTemplate } from '../../src/main/services/templates.js';

/**
 * UX 优化回归——服务层（docs/tests/UI体验优化回归报告.md §4）：
 * 模板样式概览提取 + recentPaths 登记与裁剪。
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const BUILTIN = join(REPO, 'packages', 'core', 'assets', 'reference-zh.docx');

class MemoryKvStore implements KvStore {
  data: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  all(): Record<string, unknown> {
    return { ...this.data };
  }
  set(patch: Record<string, unknown>): void {
    this.data = { ...this.data, ...patch };
  }
}

let workspace: string;
let services: AppServices;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'md2word-ux-svc-'));
  services = await createServices(
    { userDataDir: join(workspace, 'userdata'), resourcesDir: workspace, isPackaged: false },
    { kvStore: new MemoryKvStore() },
  );
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('模板样式概览（summarizeTemplate / describeTemplate）', () => {
  it('内置中文模板：宋体正文 12pt、黑体标题、Consolas 代码、1.5 倍行距', () => {
    const s = summarizeTemplate(BUILTIN);
    expect(s.normal?.eastAsia).toBe('SimSun');
    expect(s.normal?.sizePt).toBe(12);
    expect(s.heading?.eastAsia).toBe('SimHei');
    expect(s.code?.font).toBe('Consolas');
    expect(s.lineSpacing).toBe(1.5);
  });

  it('describeTemplate：builtin-zh 带 label；未知用户模板返回 null', async () => {
    const s = await services.templates.describeTemplate('builtin-zh');
    expect(s?.label).toBe('内置中文模板');
    expect(s?.normal?.eastAsia).toBe('SimSun');
    expect(await services.templates.describeTemplate('不存在的模板')).toBeNull();
  });

  it('describeTemplate：pandoc-default 走导出缓存并给出概览', async () => {
    const s = await services.templates.describeTemplate('pandoc-default');
    expect(s?.label).toBe('pandoc 默认样式');
    expect(s?.normal?.font).toBeTruthy();
  });

  it('非 docx 内容：返回空概览不抛错（渲染层降级为纯文案）', () => {
    const bad = join(workspace, 'bad.docx');
    writeFileSync(bad, 'not a zip');
    expect(summarizeTemplate(bad)).toEqual({});
  });
});

describe('pandoc-default 导出闭环（D32）', () => {
  it('导出的 pandoc 默认模板通过 validateTemplate（含注入的 Source Code）', async () => {
    const resolved = await services.templates.resolveTemplatePath('pandoc-default');
    expect(resolved).toBeTruthy();
    expect(validateTemplate(resolved!.path)).toEqual({ ok: true, missingStyles: [] });
  });

  it('导出 → 再导入闭环：add() 接受导出的文件', async () => {
    const resolved = await services.templates.resolveTemplatePath('pandoc-default');
    const r = services.templates.add('pandoc 自定义.docx', new Uint8Array(readFileSync(resolved!.path)));
    expect(r).toMatchObject({ ok: true, name: 'pandoc 自定义' });
    expect(services.templates.list().user.map((t) => t.name)).toContain('pandoc 自定义');
  });
});

describe('recentPaths 登记（最近文件点击重转的数据源）', () => {
  it('path 模式转换后登记 name→源路径，且裁剪到 recentFiles 列表内', async () => {
    const srcDir = join(workspace, 'src');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'a.md');
    writeFileSync(mdPath, '# a\n', 'utf8');
    services.settings.set({ recentFiles: ['a.md'] });
    await services.convert.run([{ name: 'a.md', path: mdPath }], {});
    expect((services.settings.all.recentPaths as Record<string, string>)['a.md']).toBe(mdPath);
  });

  it('recentFiles 中不存在的名字不登记（与渲染层删除chip的持久化保持一致）', async () => {
    const srcDir = join(workspace, 'src2');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'b.md');
    writeFileSync(mdPath, '# b\n', 'utf8');
    services.settings.set({ recentFiles: ['other.md'] });
    await services.convert.run([{ name: 'b.md', path: mdPath }], {});
    expect(services.settings.all.recentPaths).toEqual({});
  });

  it('bytes 模式不登记（staged 临时文件无意义）', async () => {
    services.settings.set({ recentFiles: ['staged.md'] });
    await services.convert.run([{ name: 'staged.md', bytes: new Uint8Array(readFileSync(BUILTIN)).slice(0, 0) }], {}).catch(() => undefined);
    // bytes 模式走转换；无论成败都不应产生 recentPaths
    expect(services.settings.all.recentPaths).toBeUndefined();
  });
});
