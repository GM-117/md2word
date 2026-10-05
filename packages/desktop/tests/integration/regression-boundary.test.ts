import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServices, type AppServices } from '../../src/main/context.js';
import { DEFAULT_SETTINGS, type KvStore } from '../../src/main/services/settings.js';
import { buildDownloadUrl, parseResourceUrl } from '../../src/main/services/resourceUrl.js';
import { unzipSync } from 'fflate';

/**
 * M4 回归测试——边界条件与异常场景（docs/tests/M4回归测试报告.md §4）。
 * 覆盖：CJK/emoji 路径、多文件顺序、元数据/TOC 透传、20MB 上限、取消语义、
 * 模板名穿越清洗、缺失模板回退、空文件、downloadUrl 往返。
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
  workspace = mkdtempSync(join(tmpdir(), 'md2word-m4-reg-'));
  services = await createServices(
    { userDataDir: join(workspace, 'userdata'), resourcesDir: workspace, isPackaged: false },
    { kvStore: new MemoryKvStore() },
  );
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function readDocxXml(docxPath: string, entry: string): string {
  const files = unzipSync(new Uint8Array(readFileSync(docxPath)));
  const xml = files[entry];
  if (!xml) throw new Error(`docx 内缺少 ${entry}`);
  return new TextDecoder().decode(xml);
}

describe('回归 · 路径与文件名边界（中文/空格/emoji 一等公民）', () => {
  it('CJK + 空格 + emoji 深层路径转换：产物名与位置精确', async () => {
    const srcDir = join(workspace, '测试 目录', '子 目录 🎉');
    mkdirSync(srcDir, { recursive: true });
    const mdPath = join(srcDir, '中文 文档 😊.md');
    writeFileSync(mdPath, '# 标题\n\n正文内容。\n', 'utf8');
    const job = await services.convert.run([{ name: '中文 文档 😊.md', path: mdPath }], {});
    const item = job.items[0]!;
    expect(item.ok).toBe(true);
    expect(item.outputPath).toBe(join(srcDir, '中文 文档 😊.docx'));
    expect(existsSync(item.outputPath!)).toBe(true);
  });

  it('downloadUrl 对空格/中文/emoji/百分号文件名编解码往返无损', () => {
    const names = ['a b.docx', '中文 文档.docx', 'doc 😊.docx', '100% 完成.docx', 'a#b?c.docx'];
    const jobId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
    for (const name of names) {
      const parsed = parseResourceUrl(buildDownloadUrl(jobId, name));
      expect(parsed).toEqual({ kind: 'download', jobId, name });
    }
  });

  it('空文件（0 字节 md）可正常转换', async () => {
    const srcDir = join(workspace, 'src-empty');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'empty.md');
    writeFileSync(mdPath, '', 'utf8');
    const job = await services.convert.run([{ name: 'empty.md', path: mdPath }], {});
    expect(job.items[0]!.ok).toBe(true);
    expect(existsSync(job.items[0]!.outputPath!)).toBe(true);
  });
});

describe('回归 · 多文件作业与选项透传', () => {
  it('3 文件作业：items 顺序与输入严格一致（渲染层按索引映射依赖此契约）', async () => {
    const srcDir = join(workspace, 'src-multi');
    mkdirSync(srcDir);
    const names = ['甲.md', '乙.md', '丙.md'];
    const entries = names.map((name, i) => {
      const p = join(srcDir, name);
      writeFileSync(p, `# 文件 ${i}\n\n内容 ${i}。\n`, 'utf8');
      return { name, path: p };
    });
    const job = await services.convert.run(entries, {});
    expect(job.items.map((i) => i.name)).toEqual(names);
    expect(job.items.every((i) => i.ok && i.outputPath!.startsWith(srcDir))).toBe(true);
  });

  it('元数据透传：metaTitle/metaAuthor 写入 docProps/core.xml（dc:title / dc:creator）', async () => {
    const srcDir = join(workspace, 'src-meta');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'meta.md');
    writeFileSync(mdPath, '# t\n\n正文。\n', 'utf8');
    services.settings.set({ metaTitle: '回归标题甲', metaAuthor: '回归作者乙' });
    const job = await services.convert.run([{ name: 'meta.md', path: mdPath }], {});
    expect(job.items[0]!.ok).toBe(true);
    const coreXml = readDocxXml(job.items[0]!.outputPath!, 'docProps/core.xml');
    expect(coreXml).toContain('<dc:title>回归标题甲</dc:title>');
    expect(coreXml).toContain('回归作者乙');
  });

  it('TOC 选项透传：toc=true + tocDepth=2 → document.xml 含 TOC 域指令（\\o "1-2"）', async () => {
    const srcDir = join(workspace, 'src-toc');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'toc.md');
    writeFileSync(mdPath, '# 一\n\n## 二\n\n### 三\n', 'utf8');
    services.settings.set({ toc: true, tocDepth: 2 });
    const job = await services.convert.run([{ name: 'toc.md', path: mdPath }], {});
    expect(job.items[0]!.ok).toBe(true);
    const documentXml = readDocxXml(job.items[0]!.outputPath!, 'word/document.xml');
    expect(documentXml).toMatch(/TOC \\o &quot;1-2&quot;/);
  });

  it('离线选项：bytes 模式远程图跳过 → 人话警告含被跳过的 URL', async () => {
    const srcDir = join(workspace, 'src-offline');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'remote.md');
    writeFileSync(mdPath, '# t\n\n![r](https://example.invalid/pic.png)\n', 'utf8');
    services.settings.set({ offline: true });
    const job = await services.convert.run([{ name: 'remote.md', path: mdPath }], {});
    const item = job.items[0]!;
    expect(item.ok).toBe(true);
    const warn = item.warnings.find((w) => w.code === 'W_IMAGE_OFFLINE');
    expect(warn?.message).toContain('https://example.invalid/pic.png');
  });
});

describe('回归 · 异常与安全边界', () => {
  it('超过 20MB 源文件 → E_SOURCE_TOO_LARGE（阈值边界 +1MB 取样）', async () => {
    const srcDir = join(workspace, 'src-big');
    mkdirSync(srcDir);
    const mdPath = join(srcDir, 'big.md');
    const chunk = '段落内容行。\n\n'.repeat(1024); // ~14KB
    let size = 0;
    const parts: string[] = [];
    while (size < 20 * 1024 * 1024 + 1024 * 1024) {
      parts.push(chunk);
      size += chunk.length;
    }
    writeFileSync(mdPath, parts.join(''), 'utf8');
    const job = await services.convert.run([{ name: 'big.md', path: mdPath }], {});
    expect(job.items[0]!.ok).toBe(false);
    expect(job.items[0]!.error?.code).toBe('E_SOURCE_TOO_LARGE');
  }, 30_000);

  it('转换中途 cancelAll：在跑任务被杀 + 等待队列清空，全部失败且统一 E_CANCELLED 口径（D35）', async () => {
    const srcDir = join(workspace, 'src-cancel');
    mkdirSync(srcDir);
    // ~4MB 段落文（典型密度 ≈ 数秒），保证取消窗口充足
    const big = '# 大文件\n\n' + '这是一个足够长的段落用于拖慢转换速度。\n\n'.repeat(60_000);
    const entries = ['c1.md', 'c2.md'].map((name) => {
      const p = join(srcDir, name);
      writeFileSync(p, big, 'utf8');
      return { name, path: p };
    });
    const jobPromise = services.convert.run(entries, {});
    await new Promise((r) => setTimeout(r, 300)); // 让首个任务进入在跑状态
    const cancelled = services.convert.cancelAll();
    expect(cancelled).toBeGreaterThanOrEqual(1);
    const job = await jobPromise;
    expect(job.items).toHaveLength(2);
    for (const item of job.items) {
      expect(item.ok).toBe(false);
      // 在跑任务（core abort）与待执行任务（队列拒绝）统一映射为 E_CANCELLED「转换已被取消。」
      expect(item.error?.code).toBe('E_CANCELLED');
      expect(item.error?.message).toBe('转换已被取消。');
    }
    // 队列清空后可继续接受新作业（取消不损坏服务）
    const next = await services.convert.run([{ name: 'after.md', path: join(srcDir, 'c1.md') }], {});
    expect(next.items[0]!.ok).toBe(true);
  }, 60_000);

  it('D34：启动清扫 userData/jobs 历史作业目录（注册表内存态，重启后不可达即垃圾）', async () => {
    const jobsRoot = join(workspace, 'userdata', 'jobs');
    const stale = join(jobsRoot, 'stale-job');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'a.docx'), 'PK');
    writeFileSync(join(jobsRoot, 'loose-file.txt'), 'x');
    // beforeEach 已创建过一次 services（此刻清扫空目录）；重建以验证清扫真实生效
    const fresh = await createServices(
      { userDataDir: join(workspace, 'userdata'), resourcesDir: workspace, isPackaged: false },
      { kvStore: new MemoryKvStore() },
    );
    expect(readdirSync(jobsRoot)).toEqual([]);
    expect(fresh.convert.pendingCount).toBe(0);
  });

  it('D34：纯 path 模式转换不创建作业目录（不再留空 UUID 目录）', async () => {
    const srcDir = join(workspace, 'src-nodir');
    mkdirSync(srcDir);
    copyFileSync(SAMPLE, join(srcDir, 'basic-zh.md'));
    const job = await services.convert.run([{ name: 'basic-zh.md', path: join(srcDir, 'basic-zh.md') }], {});
    expect(job.items[0]!.ok).toBe(true);
    // 无 bytes 条目 → 连 jobs 根目录都不需要创建
    expect(existsSync(join(workspace, 'userdata', 'jobs'))).toBe(false);
  });

  it('template:add 穿越名清洗：../evil.docx 与 a/b.docx 均落 templates 根目录', () => {
    const BUILTIN = join(REPO, 'packages', 'core', 'assets', 'reference-zh.docx');
    const bytes = new Uint8Array(readFileSync(BUILTIN));
    const r1 = services.templates.add('../evil.docx', bytes);
    expect(r1.ok).toBe(true);
    expect((r1 as { name: string }).name).toBe('evil');
    const r2 = services.templates.add('sub/dir.docx', bytes);
    expect(r2.ok).toBe(true);
    expect((r2 as { name: string }).name).toBe('dir');
    // 全部落在 userData/templates 根，未逃逸
    expect(services.templates.list().user.map((t) => t.name).sort()).toEqual(['dir', 'evil']);
    expect(existsSync(join(workspace, 'evil.docx'))).toBe(false);
  });

  it('defaultTemplate 指向不存在的模板 → 回退内置中文模板（不报错）', async () => {
    services.settings.set({ defaultTemplate: '不存在的模板' });
    const resolved = await services.templates.resolveTemplate();
    expect(resolved).toMatch(/reference-zh\.docx$/);
  });

  it('open 白名单：伪造 jobId / 未登记 name 均拒绝（resolve 返回 null）', () => {
    const reg = services.registry;
    const jobId = reg.createJob(join(workspace, 'jobs-x'));
    expect(reg.resolve('not-a-job', 'a.md')).toBeNull();
    expect(reg.resolve(jobId, '未登记.md')).toBeNull();
    expect(reg.resolveKey(jobId, 'whatever.docx')).toBeNull();
  });
});
