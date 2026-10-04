import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SCAN_FILES, scanMarkdownFiles } from '../../src/scan.js';
import { hasHiddenSegment, isBatchMarkdownPath, isMarkdownName } from '../../src/mdfilter.js';

/**
 * M6 单元测试：文件夹递归扫描口径（开发计划 M6 行）——
 * 递归收集 .md（含子目录），排除隐藏文件/目录、非 .md、node_modules；
 * 符号链接不跟随；结果按 relPath 确定性排序。
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md2word-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const touch = (relPath: string, content = '# t\n'): void => {
  const p = join(root, relPath);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
};

describe('scanMarkdownFiles', () => {
  it('递归收集全部 .md（含子目录），relPath 用 / 分隔并按字典序排序', () => {
    touch('a.md');
    touch('sub/b.markdown');
    touch('sub/deep/c.mdown');
    touch('zh/中文 文件.mkd');

    const r = scanMarkdownFiles(root);
    expect(r.truncated).toBe(false);
    expect(r.files.map((f) => f.relPath)).toEqual([
      'a.md',
      'sub/b.markdown',
      'sub/deep/c.mdown',
      'zh/中文 文件.mkd',
    ]);
    expect(r.files[0]!.path).toBe(join(root, 'a.md'));
  });

  it('排除隐藏文件/隐藏目录、非 .md 与 node_modules', () => {
    touch('keep.md');
    touch('.hidden-file.md');
    touch('.hid-dir/inner.md');
    touch('sub/.DS_Store');
    touch('sub/notes.txt');
    touch('sub/no-ext');
    touch('node_modules/pkg/readme.md');
    touch('sub/node_modules/pkg2/x.md');

    const r = scanMarkdownFiles(root);
    expect(r.files.map((f) => f.relPath)).toEqual(['keep.md']);
  });

  it('空目录/无 md 目录返回空列表', () => {
    mkdirSync(join(root, 'empty'));
    const r = scanMarkdownFiles(root);
    expect(r.files).toEqual([]);
    expect(r.scannedDirs).toBeGreaterThanOrEqual(1);
  });

  it('不跟随符号链接（目录防环、文件不越界）', () => {
    touch('real.md');
    const outside = mkdtempSync(join(tmpdir(), 'md2word-scan-out-'));
    writeFileSync(join(outside, 'outer.md'), '# outer\n');
    touch('linked-place.md');
    try {
      symlinkSync(join(outside, 'outer.md'), join(root, 'link-file.md'), 'file');
      symlinkSync(outside, join(root, 'link-dir'), 'dir');
    } catch {
      // 个别环境不允许 symlink：跳过本用例
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    const r = scanMarkdownFiles(root);
    const rels = r.files.map((f) => f.relPath);
    expect(rels).toContain('real.md');
    expect(rels).not.toContain('link-file.md');
    expect(rels.some((p) => p.startsWith('link-dir/'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('命中上限时截断并标记 truncated', () => {
    for (let i = 0; i < 12; i += 1) touch(`f${i}.md`);
    const r = scanMarkdownFiles(root, 5);
    expect(r.files).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(MAX_SCAN_FILES).toBeGreaterThan(0);
  });
});

describe('mdfilter 共享过滤口径（渲染层 webkitdirectory 与扫描器同源）', () => {
  it('isMarkdownName 覆盖四种扩展名且大小写不敏感', () => {
    for (const n of ['a.md', 'b.MD', 'c.Markdown', 'd.mdown', 'e.mkd']) {
      expect(isMarkdownName(n)).toBe(true);
    }
    for (const n of ['a.txt', 'b.mdx', 'md', 'a.markdownn']) {
      expect(isMarkdownName(n)).toBe(false);
    }
  });

  it('isBatchMarkdownPath 排除隐藏段/跳过目录段，接受正常嵌套', () => {
    expect(isBatchMarkdownPath('sub/a.md')).toBe(true);
    expect(isBatchMarkdownPath('.x/a.md')).toBe(false);
    expect(isBatchMarkdownPath('sub/.b.md')).toBe(false);
    expect(isBatchMarkdownPath('node_modules/a.md')).toBe(false);
    expect(isBatchMarkdownPath('sub/a.txt')).toBe(false);
    expect(hasHiddenSegment('a\\b.md')).toBe(false); // win 分隔符普通段
    expect(hasHiddenSegment('.x\\b.md')).toBe(true); // win 分隔符隐藏段
  });
});
