import { describe, expect, it } from 'vitest';
import { buildPandocArgs, resolveOutputPath } from '../../src/convert.js';
import type { ConvertOptions } from '../../src/types.js';

// Windows 路径断言归一化（分隔符统一 + 去盘符）：resolveOutputPath 在 Windows 上
// 返回 'D:\a\b\doc.docx'，与 POSIX 形式同义（D39 三平台 CI 首次真跑暴露）
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');

// M1 DoD①：参数构建器快照测试——锁定 argv 全序列（禁 shell:true，§4.1）
const BASE = {
  inputMd: '/tmp/in.md',
  outputDocx: '/tmp/out.docx',
  sourceDir: '/tmp',
};

describe('buildPandocArgs 参数构建器快照', () => {
  it('默认参数：固定基底，无可选项', () => {
    expect(buildPandocArgs(BASE, {})).toEqual([
      '/tmp/in.md',
      '--from', 'markdown',
      '--to', 'docx',
      '--output', '/tmp/out.docx',
      '--resource-path', '/tmp',
    ]);
  });

  it('toc + 自定义层级', () => {
    const opts: ConvertOptions = { toc: true, tocDepth: 5 };
    expect(buildPandocArgs(BASE, opts)).toEqual([
      '/tmp/in.md',
      '--from', 'markdown',
      '--to', 'docx',
      '--output', '/tmp/out.docx',
      '--resource-path', '/tmp',
      '--toc',
      '--toc-depth', '5',
    ]);
  });

  it('toc 未指定层级时不输出 --toc-depth（pandoc 默认 3）', () => {
    const args = buildPandocArgs(BASE, { toc: true });
    expect(args).toContain('--toc');
    expect(args).not.toContain('--toc-depth');
  });

  it('toc=false 不产生任何 toc 参数', () => {
    const args = buildPandocArgs(BASE, { toc: false, tocDepth: 2 });
    expect(args.join(' ')).not.toContain('toc');
  });

  it('numberSections / highlightStyle 全量组合', () => {
    const args = buildPandocArgs(BASE, { numberSections: true, highlightStyle: 'zenburn' });
    expect(args).toEqual([
      '/tmp/in.md',
      '--from', 'markdown',
      '--to', 'docx',
      '--output', '/tmp/out.docx',
      '--resource-path', '/tmp',
      '--number-sections',
      '--highlight-style', 'zenburn',
    ]);
  });

  it('模板与离线过滤器', () => {
    const args = buildPandocArgs(
      { ...BASE, referenceDocx: '/ref/zh.docx', offlineFilterPath: '/assets/offline-images.lua' },
      { offline: true },
    );
    expect(args).toContain('--reference-doc');
    expect(args).toEqual(expect.arrayContaining(['--reference-doc', '/ref/zh.docx', '--lua-filter', '/assets/offline-images.lua']));
  });

  it('offline=true 但无过滤器路径时不加 --lua-filter', () => {
    const args = buildPandocArgs(BASE, { offline: true });
    expect(args).not.toContain('--lua-filter');
  });

  it('metadata title/author → --metadata key=value（值含冒号安全，已实证）', () => {
    const args = buildPandocArgs(BASE, { metadata: { title: '我的: 标题', author: '张三' } });
    expect(args).toEqual(expect.arrayContaining(['--metadata', 'title=我的: 标题', '--metadata', 'author=张三']));
  });

  it('完整选项组合快照（顺序锁定）', () => {
    const args = buildPandocArgs(
      {
        inputMd: '/data/中文 目录/文档.md',
        outputDocx: '/data/输出/文档.docx',
        sourceDir: '/data/中文 目录',
        referenceDocx: '/templates/zh.docx',
        offlineFilterPath: '/core/assets/offline-images.lua',
      },
      {
        toc: true,
        tocDepth: 4,
        numberSections: true,
        highlightStyle: 'kate',
        metadata: { title: 'T', author: 'A' },
        offline: true,
      },
    );
    expect(args).toEqual([
      '/data/中文 目录/文档.md',
      '--from', 'markdown',
      '--to', 'docx',
      '--output', '/data/输出/文档.docx',
      '--resource-path', '/data/中文 目录',
      '--toc',
      '--toc-depth', '4',
      '--number-sections',
      '--highlight-style', 'kate',
      '--reference-doc', '/templates/zh.docx',
      '--metadata', 'title=T',
      '--metadata', 'author=A',
      '--lua-filter', '/core/assets/offline-images.lua',
    ]);
  });
});

describe('resolveOutputPath 输出路径推导', () => {
  it('缺省与源同目录、同名 .docx', () => {
    expect(norm(resolveOutputPath('/a/b/doc.md'))).toBe(norm('/a/b/doc.docx'));
  });

  it('支持 .markdown/.mdown/.mkd 与大小写', () => {
    expect(norm(resolveOutputPath('/a/b/doc.MARKDOWN'))).toBe(norm('/a/b/doc.docx'));
    expect(norm(resolveOutputPath('/a/b/doc.mdown'))).toBe(norm('/a/b/doc.docx'));
  });

  it('outputDir 覆盖输出目录（相对路径按 cwd 解析）', () => {
    expect(norm(resolveOutputPath('/a/b/doc.md', '/out'))).toBe(norm('/out/doc.docx'));
  });

  it('中文字符与空格路径原样保留', () => {
    expect(norm(resolveOutputPath('/a/中文 目录/测试 文件.md'))).toBe(norm('/a/中文 目录/测试 文件.docx'));
  });
});
