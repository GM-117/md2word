import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// M4 打包配套（docs/M4-Electron开发任务计划.md §M4-4）：离线过滤器路径必须可被宿主注入——
// desktop 打包后 core 位于 asar 内，pandoc 子进程读不到虚拟路径。
// 用 mock 捕获 convertMarkdown 传给 runPandoc 的 argv，判别 env 覆盖是否生效。
const runPandocSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/pandoc.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPandoc: runPandocSpy,
  resolvePandocInfo: vi.fn(async () => ({ path: '/fake/pandoc', version: '3.12', source: 'bundled' })),
}));

import { convertMarkdown } from '../../src/convert.js';

function fakeRunFailure() {
  runPandocSpy.mockResolvedValue({
    code: 1,
    stdout: '',
    stdoutBytes: Buffer.alloc(0),
    stderr: 'simulated failure',
    timedOut: false,
    signal: null,
  });
}

describe('convertMarkdown 离线过滤器路径注入（MD2WORD_LUA_FILTER）', () => {
  afterEach(() => {
    delete process.env.MD2WORD_LUA_FILTER;
    runPandocSpy.mockReset();
  });

  it('设置 env 时 --lua-filter 使用注入路径', async () => {
    fakeRunFailure();
    process.env.MD2WORD_LUA_FILTER = '/Resources/filters/offline-images.lua';
    const dir = mkdtempSync(join(tmpdir(), 'md2word-env-'));
    try {
      const md = join(dir, 'in.md');
      writeFileSync(md, '# t\n\ntext\n', 'utf8');
      await convertMarkdown(md, { offline: true });
      const args = runPandocSpy.mock.calls[0]?.[1] as string[];
      expect(args).toEqual(expect.arrayContaining(['--lua-filter', '/Resources/filters/offline-images.lua']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未设置 env 时回退 core 内置资产路径', async () => {
    fakeRunFailure();
    const dir = mkdtempSync(join(tmpdir(), 'md2word-env-'));
    try {
      const md = join(dir, 'in.md');
      writeFileSync(md, '# t\n\ntext\n', 'utf8');
      await convertMarkdown(md, { offline: true });
      const args = runPandocSpy.mock.calls[0]?.[1] as string[];
      const idx = args.indexOf('--lua-filter');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toMatch(/assets[\\/]offline-images\.lua$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('offline=false 时无论 env 与否都不加 --lua-filter', async () => {
    fakeRunFailure();
    process.env.MD2WORD_LUA_FILTER = '/Resources/filters/offline-images.lua';
    const dir = mkdtempSync(join(tmpdir(), 'md2word-env-'));
    try {
      const md = join(dir, 'in.md');
      writeFileSync(md, '# t\n\ntext\n', 'utf8');
      await convertMarkdown(md, {});
      const args = runPandocSpy.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain('--lua-filter');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
