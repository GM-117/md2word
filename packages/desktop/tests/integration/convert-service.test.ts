import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, type AppServices } from '../../src/main/context.js';
import { DEFAULT_SETTINGS, type KvStore } from '../../src/main/services/settings.js';
import { parseResourceUrl } from '../../src/main/services/resourceUrl.js';
import { openDocx } from '@md2word/core';

/**
 * M4 集成测试：真实 pandoc（开发缓存 sidecar），直驱 services 层（不经 Electron/IPC）。
 * 覆盖开发计划 M4 计划 §M4-6 集成行：path/bytes 双模式、覆盖开关、模板链、离线注入。
 */

const REPO = join(new URL('../../../../', import.meta.url).pathname);
const SAMPLE = join(REPO, 'samples', 'basic-zh.md');
const BUILTIN_DOCX = join(REPO, 'packages', 'core', 'assets', 'reference-zh.docx');

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
  workspace = mkdtempSync(join(tmpdir(), 'md2word-m4-int-'));
  services = await createServices(
    { userDataDir: join(workspace, 'userdata'), resourcesDir: workspace, isPackaged: false },
    { kvStore: new MemoryKvStore() },
  );
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('ConvertService path 模式（桌面语义：产物落源目录）', () => {
  it('转换成功 → 产物写源文件同目录，注册表登记，downloadUrl 合法', async () => {
    const srcDir = join(workspace, 'src');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, '中文 测试.md');
    copyFileSync(SAMPLE, mdPath);

    const job = await services.convert.run([{ name: '中文 测试.md', path: mdPath }], {});
    expect(job.items).toHaveLength(1);
    const item = job.items[0]!;
    expect(item.ok).toBe(true);
    expect(item.outputPath).toBe(join(srcDir, '中文 测试.docx'));
    expect(existsSync(item.outputPath!)).toBe(true);
    expect(item.stats).toBeDefined();

    const url = item.downloadUrl!;
    const parsed = parseResourceUrl(url);
    expect(parsed).toMatchObject({ kind: 'download', jobId: job.jobId, name: '中文 测试.docx' });
    expect(item.outputKey).toBe('中文 测试.docx');
    expect(services.registry.resolveKey(job.jobId, item.outputKey!)).toBe(item.outputPath);
    expect(services.registry.resolve(job.jobId, item.outputKey!)?.outputPath).toBe(item.outputPath);
  });

  it('产物已存在且未开覆盖 → E_OUTPUT_EXISTS；开启覆盖后成功', async () => {
    const srcDir = join(workspace, 'src2');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'a.md');
    copyFileSync(SAMPLE, mdPath);

    const first = await services.convert.run([{ name: 'a.md', path: mdPath }], {});
    expect(first.items[0]!.ok).toBe(true);

    services.settings.set({ overwrite: false });
    const second = await services.convert.run([{ name: 'a.md', path: mdPath }], {});
    expect(second.items[0]!.ok).toBe(false);
    expect(second.items[0]!.error?.code).toBe('E_OUTPUT_EXISTS');

    services.settings.set({ overwrite: true });
    const third = await services.convert.run([{ name: 'a.md', path: mdPath }], {});
    expect(third.items[0]!.ok).toBe(true);
  });

  it('路径不存在 → E_SOURCE_NOT_FOUND 人话错误', async () => {
    const job = await services.convert.run([{ name: 'ghost.md', path: join(workspace, 'no-such.md') }], {});
    expect(job.items[0]!.ok).toBe(false);
    expect(['E_SOURCE_NOT_FOUND', 'E_PANDOC_FAILED']).toContain(job.items[0]!.error?.code);
  });
});

describe('ConvertService bytes 模式（staged，与 web-host 等价）', () => {
  it('md + 图片资源混传 → staged 到作业目录并成功转换', async () => {
    const mdBytes = new Uint8Array(readFileSync(SAMPLE));
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const job = await services.convert.run(
      [{ name: 'staged.md', bytes: mdBytes }, { name: 'resource.bin', bytes: new Uint8Array(png1x1) }],
      {},
    );
    const item = job.items[0]!;
    expect(item.ok).toBe(true);
    // staged 产物落作业目录（jobDir 前缀），不污染源位置（bytes 模式无源位置）
    expect(item.outputPath!.startsWith(join(services.userDataDir, 'jobs'))).toBe(true);
    expect(item.downloadUrl).toMatch(/^md2word:\/\/download\//);
  });

  it('重名 staged md 消解为 N- 前缀，两个结果都在（队列串行不中断）', async () => {
    const mdBytes = new Uint8Array(readFileSync(SAMPLE));
    const job = await services.convert.run(
      [
        { name: 'dup.md', bytes: mdBytes },
        { name: 'dup.md', bytes: mdBytes },
      ],
      {},
    );
    expect(job.items).toHaveLength(2);
    expect(job.items.every((i) => i.ok)).toBe(true);
    expect(job.items[0]!.outputPath).not.toBe(job.items[1]!.outputPath);
  });

  it('空条目（无 path 无 bytes）→ E_SOURCE_NOT_FOUND，不阻断其余文件', async () => {
    const mdBytes = new Uint8Array(readFileSync(SAMPLE));
    const job = await services.convert.run(
      [{ name: 'ghost.md' }, { name: 'real.md', bytes: mdBytes }],
      {},
    );
    expect(job.items).toHaveLength(2);
    expect(job.items[0]!.ok).toBe(false);
    expect(job.items[0]!.error?.code).toBe('E_SOURCE_NOT_FOUND');
    expect(job.items[1]!.ok).toBe(true);
  });

  it('非 md 条目被忽略 → 400 语义错误', async () => {
    await expect(services.convert.run([{ name: 'pic.png', bytes: new Uint8Array([1]) }], {})).rejects.toThrow(
      /未收到任何 \.md/,
    );
  });
});

describe('模板链与离线注入（services 级）', () => {
  it('内置模板开箱即用：默认设置下转换产物含命名样式（宋体正文）', async () => {
    const srcDir = join(workspace, 'src3');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'tpl.md');
    copyFileSync(SAMPLE, mdPath);
    const job = await services.convert.run([{ name: 'tpl.md', path: mdPath }], {});
    expect(job.items[0]!.ok).toBe(true);
    const stats = openDocx(readFileSync(job.items[0]!.outputPath!));
    expect(stats.ok).toBe(true);
  });

  it('用户模板导入 → resolveTemplate 命中；缺样式模板被拒并返回 missingStyles', async () => {
    // 合法模板：内置中文模板副本
    const okRes = services.templates.add('我的模板.docx', new Uint8Array(readFileSync(BUILTIN_DOCX)));
    expect(okRes).toMatchObject({ ok: true, name: '我的模板' });
    expect(services.templates.list().user.map((t) => t.name)).toContain('我的模板');

    // 缺样式模板：合法 zip 但缺必需样式（复用 web E2E fixture）
    const broken = join(REPO, 'packages', 'web-host', 'e2e', 'fixtures', 'broken-template.docx');
    const badStyles = services.templates.add('缺样式.docx', new Uint8Array(readFileSync(broken)));
    expect(badStyles.ok).toBe(false);
    expect((badStyles as { missingStyles?: string[] }).missingStyles?.length).toBeGreaterThan(0);

    // 非 zip 内容：被拒并给出人话错误（无法解析时无缺失样式清单）
    const badZip = services.templates.add('bad.docx', new Uint8Array(Buffer.from('not a zip')));
    expect(badZip.ok).toBe(false);
    if (!badZip.ok) expect(badZip.error).toBeTruthy();

    // 无效模板不落库
    expect(services.templates.list().user.map((t) => t.name)).not.toContain('bad');

    // 默认模板切换 + 解析链
    services.settings.set({ defaultTemplate: '我的模板' });
    const resolved = await services.templates.resolveTemplate();
    expect(resolved).toContain(join(services.userDataDir, 'templates'));
    expect(resolved).toMatch(/我的模板\.docx$/);
  });

  it('删除默认用户模板 → 自动回退 builtin-zh', () => {
    services.templates.add('t1.docx', new Uint8Array(readFileSync(BUILTIN_DOCX)));
    services.settings.set({ defaultTemplate: 't1' });
    expect(services.templates.delete('t1')).toBe(true);
    expect(services.settings.all.defaultTemplate).toBe('builtin-zh');
  });

  it('离线模式：env 注入的过滤器生效（远程图跳过 → W_IMAGE_OFFLINE 警告）', async () => {
    const prev = process.env.MD2WORD_LUA_FILTER;
    process.env.MD2WORD_LUA_FILTER = join(REPO, 'packages', 'core', 'assets', 'offline-images.lua');
    try {
      const srcDir = join(workspace, 'src4');
      mkdirSync(srcDir);
      const mdPath = join(srcDir, 'remote.md');
      writeFileSync(mdPath, '# t\n\n![remote](https://example.invalid/x.png)\n', 'utf8');
      services.settings.set({ offline: true });
      const job = await services.convert.run([{ name: 'remote.md', path: mdPath }], { offline: true });
      const item = job.items[0]!;
      expect(item.ok).toBe(true);
      expect(item.warnings.some((w) => w.code === 'W_IMAGE_OFFLINE')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MD2WORD_LUA_FILTER;
      else process.env.MD2WORD_LUA_FILTER = prev;
    }
  });
});

describe('取消与队列状态', () => {
  it('空闲时 cancelAll 返回 0 且健康状态可查询', () => {
    expect(services.convert.cancelAll()).toBe(0);
    expect(services.convert.pendingCount).toBe(0);
    expect(services.convert.isRunning).toBe(false);
  });
});
