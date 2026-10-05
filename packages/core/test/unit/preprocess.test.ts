import { describe, expect, it } from 'vitest';
import { absolutizeImagePaths, countFencedCodeBlocks, mapOutsideCode, normalizeImageRef } from '../../src/preprocess.js';

// Windows 路径断言归一化（分隔符统一 + 去盘符）：绝对化结果在 Windows 上带
// 'D:\' 前缀与反斜杠，与 POSIX 形式同义（D39 三平台 CI 首次真跑暴露）
const norm = (s: string) => s.replace(/\\/g, '/').replace(/^[A-Za-z]:/g, '');

describe('absolutizeImagePaths 图片路径绝对化', () => {
  const SRC = '/src 带空格/doc.md';

  it('相对路径 → 绝对路径（源目录含空格 → 尖括号包裹）', () => {
    const r = absolutizeImagePaths('![a](img.png)', SRC);
    expect(norm(r.text)).toBe(norm('![a](</src 带空格/img.png>)'));
    expect(r.rewrittenImages.map(norm)).toEqual(['/src 带空格/img.png']);
  });

  it('无特殊字符的绝对安全路径裸写不包裹', () => {
    const r = absolutizeImagePaths('![a](img.png)', '/src/doc.md');
    expect(norm(r.text)).toBe(norm('![a](/src/img.png)'));
  });

  it('中文名称的图片包裹尖括号（裸空格目标属非法 Markdown，尖括号输入）', () => {
    const r = absolutizeImagePaths('![图](<图片 一.png>)', '/src/doc.md');
    expect(norm(r.text)).toBe(norm('![图](</src/图片 一.png>)'));
  });

  it('远程 URL 原样保留', () => {
    const text = '![a](https://example.com/x.png) ![b](http://x/y.png) ![c](data:image/png;base64,AAA)';
    const r = absolutizeImagePaths(text, '/src/doc.md');
    expect(r.text).toBe(text);
    expect(r.rewrittenImages).toHaveLength(0);
  });

  it('已是绝对路径且无特殊字符 → 原样', () => {
    const r = absolutizeImagePaths('![a](/abs/img.png)', '/src/doc.md');
    expect(r.text).toBe('![a](/abs/img.png)');
  });

  it('百分号编码解码后解析', () => {
    const r = absolutizeImagePaths('![a](sub/my%20img.png)', '/src/doc.md');
    expect(norm(r.text)).toBe(norm('![a](</src/sub/my img.png>)'));
  });

  it('引用定义 [id]: path 一并绝对化', () => {
    const r = absolutizeImagePaths('![a][ref]\n\n[ref]: images/pic.png "标题"', '/src/doc.md');
    expect(norm(r.text)).toContain(norm('[ref]: /src/images/pic.png'));
    expect(r.rewrittenImages.map(norm)).toEqual(['/src/images/pic.png']);
  });

  it('带标题的行内图片保留 title', () => {
    const r = absolutizeImagePaths('![a](img.png "图片标题")', '/src/doc.md');
    expect(norm(r.text)).toBe(norm('![a](/src/img.png "图片标题")'));
  });

  it('fenced code block 内的示例语法不改写', () => {
    const text = '真实图片：![a](real.png)\n\n```markdown\n![示例](not-real.png)\n```\n';
    const r = absolutizeImagePaths(text, '/src/doc.md');
    expect(r.text).toContain('![示例](not-real.png)');
    expect(norm(r.text)).toContain(norm('/src/real.png'));
    expect(r.rewrittenImages.map(norm)).toEqual(['/src/real.png']);
  });

  it('行内代码 span 内不改写', () => {
    const r = absolutizeImagePaths('用 `![x](y.png)` 表示语法', '/src/doc.md');
    expect(r.text).toBe('用 `![x](y.png)` 表示语法');
  });
});

describe('normalizeImageRef', () => {
  it('data/https/ftp 视为远程', () => {
    expect(normalizeImageRef('https://a/b', '/s/doc.md')).toBe('https://a/b');
    expect(normalizeImageRef('ftp://a/b', '/s/doc.md')).toBe('ftp://a/b');
    expect(normalizeImageRef('data:image/png;base64,AA', '/s/doc.md')).toBe('data:image/png;base64,AA');
  });
});

describe('countFencedCodeBlocks', () => {
  it('统计总数与带语言数', () => {
    const md = '```python\na=1\n```\n\n```\nplain\n```\n\n~~~\ntilde plain\n~~~\n';
    expect(countFencedCodeBlocks(md)).toEqual({ total: 3, withLanguage: 1 });
  });

  it('未闭合 fence 只计一次', () => {
    expect(countFencedCodeBlocks('```js\nunclosed')).toEqual({ total: 1, withLanguage: 1 });
  });

  it('缩进 ≤3 空格的 fence 有效，4 空格为代码块缩进', () => {
    expect(countFencedCodeBlocks('   ```\nx\n   ```\n').total).toBe(1);
  });

  it('反引号 fence info 含反引号不算 fence', () => {
    expect(countFencedCodeBlocks('``` `weird`\nx\n```\n').total).toBe(1);
  });
});

describe('mapOutsideCode', () => {
  it('保留 fence 行原样，仅变换外部片段', () => {
    const md = 'a\n```js\nb\nc\n```\nd\n';
    const out = mapOutsideCode(md, (chunk) => chunk.toUpperCase());
    expect(out).toBe('A\n```js\nb\nc\n```\nD\n');
  });
});
