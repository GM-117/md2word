import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServices, type AppServices } from '../../src/main/context.js';
import { DEFAULT_SETTINGS, type KvStore } from '../../src/main/services/settings.js';
import { scanFolderForConvert } from '../../src/main/services/scan.js';
import { parseResourceUrl } from '../../src/main/services/resourceUrl.js';

/**
 * M6 集成测试：文件夹批量转换全链路（真实 pandoc，直驱 services 层）。
 * 覆盖开发计划 M6 DoD：US2（选文件夹 → 全部 .md 含子目录 → 逐个成功/失败清单）、
 * 单文件失败不中断队列、重名产物唯一登记键、重试语义（覆盖开关后重转成功）。
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SAMPLE = join(REPO, 'samples', 'basic-zh.md');

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
  workspace = mkdtempSync(join(tmpdir(), 'md2word-m6-int-'));
  services = await createServices(
    { userDataDir: join(workspace, 'userdata'), resourcesDir: workspace, isPackaged: false },
    { kvStore: new MemoryKvStore() },
  );
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** 构造文件夹批量测试树：两个子目录各有一个同名 a.md，另有隐藏/非 md/node_modules 噪声 */
function buildTree(): string {
  const root = join(workspace, 'notes');
  for (const dir of ['a 目录', 'a 目录/sub', 'b 目录', 'a 目录/node_modules/pkg']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync(SAMPLE, join(root, 'a 目录', '中文 报告.md'));
  copyFileSync(SAMPLE, join(root, 'a 目录', 'sub', '中文 报告.md'));
  copyFileSync(SAMPLE, join(root, 'b 目录', 'overview.md'));
  writeFileSync(join(root, 'b 目录', '附录.txt'), 'not markdown');
  writeFileSync(join(root, '.隐藏.md'), '# hidden');
  writeFileSync(join(root, 'a 目录', 'node_modules', 'pkg', 'readme.md'), '# dep');
  return root;
}

describe('scanFolderForConvert（扫描服务）', () => {
  it('递归收集 .md，排除隐藏/非 md/node_modules；relPath 以 / 分隔且有序', () => {
    const root = buildTree();
    const r = scanFolderForConvert(root);
    expect(r.truncated).toBe(false);
    expect(r.files.map((f) => f.relPath)).toEqual([
      'a 目录/sub/中文 报告.md',
      'a 目录/中文 报告.md',
      'b 目录/overview.md',
    ]);
  });

  it('非法输入抛人话错误：路径不存在 / 非文件夹 / 目录内无 md', () => {
    const root = buildTree();
    expect(() => scanFolderForConvert(join(workspace, 'nope'))).toThrow(/文件夹不存在/);
    expect(() => scanFolderForConvert(join(root, 'b 目录', '附录.txt'))).toThrow(/不是文件夹/);
    const empty = join(workspace, 'empty');
    mkdirSync(empty);
    expect(() => scanFolderForConvert(empty)).toThrow(/没有找到 \.md/);
  });
});

describe('ConvertService 文件夹批量（path 模式 + M6 语义）', () => {
  it('relPath 展示名保留；同名产物登记键唯一；失败不中断队列', async () => {
    const root = buildTree();
    const scan = scanFolderForConvert(root);
    // 模拟"扫描后、转换前源文件被删除"的竞态：额外附加一个不存在的源
    const entries = scan.files.map((f) => ({ name: f.relPath, path: f.path }));
    entries.push({ name: 'ghost.md', path: join(root, 'ghost.md') });

    const job = await services.convert.run(entries, {});
    expect(job.items).toHaveLength(4);

    const names = job.items.map((i) => i.name);
    expect(names).toEqual(['a 目录/sub/中文 报告.md', 'a 目录/中文 报告.md', 'b 目录/overview.md', 'ghost.md']);

    // 失败不中断队列：ghost 报 E_SOURCE_NOT_FOUND，其余全部成功
    const ghost = job.items[3]!;
    expect(ghost.ok).toBe(false);
    expect(ghost.error?.code).toBe('E_SOURCE_NOT_FOUND');
    const okItems = job.items.slice(0, 3);
    for (const item of okItems) expect(item.ok).toBe(true);

    // 重名产物（两个 中文 报告.md）：登记键唯一（N- 前缀），产物各写各的源目录
    const [first, second] = okItems;
    expect(first!.outputKey).toBe('中文 报告.docx');
    expect(second!.outputKey).toBe('2-中文 报告.docx');
    expect(first!.outputPath).toBe(join(root, 'a 目录', 'sub', '中文 报告.docx'));
    expect(second!.outputPath).toBe(join(root, 'a 目录', '中文 报告.docx'));

    // downloadUrl 互不相同且可解析（open/download 白名单共用登记键）
    const urls = okItems.map((i) => parseResourceUrl(i.downloadUrl!));
    for (const u of urls) expect(u?.kind).toBe('download');
    expect(new Set(okItems.map((i) => i.downloadUrl)).size).toBe(3);
    expect(services.registry.resolveKey(job.jobId, first!.outputKey!)).toBe(first!.outputPath);
    expect(services.registry.resolveKey(job.jobId, second!.outputKey!)).toBe(second!.outputPath);
  });

  it('重试语义：覆盖开关关闭时重转全部 E_OUTPUT_EXISTS，开启后重转成功', async () => {
    const root = buildTree();
    const scan = scanFolderForConvert(root);
    const entries = scan.files.map((f) => ({ name: f.relPath, path: f.path }));

    const first = await services.convert.run(entries, {});
    for (const item of first.items) expect(item.ok).toBe(true);

    // 重试第 1 次（覆盖关闭）：产物已存在 → 全部失败但队列完整返回
    const retry = await services.convert.run(entries, {});
    expect(retry.items).toHaveLength(entries.length);
    for (const item of retry.items) {
      expect(item.ok).toBe(false);
      expect(item.error?.code).toBe('E_OUTPUT_EXISTS');
    }

    // 用户勾选"覆盖同名输出"后重试 → 成功
    services.settings.set({ overwrite: true });
    const retry2 = await services.convert.run(entries, {});
    for (const item of retry2.items) expect(item.ok).toBe(true);
  });
});
