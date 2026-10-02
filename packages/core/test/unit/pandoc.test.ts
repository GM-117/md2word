import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resolvePandocInfo, resetPandocCache } from '../../src/pandoc.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// sidecar 定位与版本查询（postinstall fetch 已保证二进制在位）
const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEV_BIN = join(CORE_ROOT, 'assets', 'bin', '3.12', `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetPandocCache();
  for (const k of ['PANDOC_PATH', 'MD2WORD_PANDOC_BIN']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPandocCache();
});

describe('resolvePandocInfo sidecar 定位', () => {
  it('默认命中开发缓存（bundled），版本与 lock 一致', async () => {
    const info = await resolvePandocInfo();
    expect(info).not.toBeNull();
    expect(info!.version).toBe('3.12');
    expect(info!.source).toBe('bundled');
    expect(info!.path).toBe(DEV_BIN);
  });

  it('PANDOC_PATH 优先于内置缓存', async () => {
    process.env.PANDOC_PATH = DEV_BIN;
    const info = await resolvePandocInfo();
    expect(info!.source).toBe('env');
  });

  it('MD2WORD_PANDOC_BIN（宿主注入）次优先', async () => {
    process.env.MD2WORD_PANDOC_BIN = DEV_BIN;
    const info = await resolvePandocInfo();
    expect(info!.source).toBe('bundled');
    expect(info!.path).toBe(DEV_BIN);
  });

  it('无效 PANDOC_PATH 自动跳过，回退缓存', async () => {
    process.env.PANDOC_PATH = '/nonexistent/pandoc';
    const info = await resolvePandocInfo();
    expect(info!.source).toBe('bundled');
  });

  it('缓存生效：二次调用不重复查询', async () => {
    const a = await resolvePandocInfo();
    const b = await resolvePandocInfo();
    expect(b).toBe(a);
  });

  it('lock 文件包含三平台 SHA-256（§4.7 版本锁定）', () => {
    const lock = JSON.parse(readFileSync(join(CORE_ROOT, 'assets', 'pandoc.lock.json'), 'utf8'));
    expect(lock.version).toBe('3.12');
    for (const key of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      expect(lock.platforms[key].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
