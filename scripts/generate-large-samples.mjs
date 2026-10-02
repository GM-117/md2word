#!/usr/bin/env node
// 生成性能基准大样例（§5.2：large-1mb.md / large-10mb.md 生成器产出，不入库）。
// 用法：node scripts/generate-large-samples.mjs [输出目录=仓库 samples/] [1MB] [10MB]
// 内容确定性（固定重复模板），保证跨次运行可 diff。
// 密度按"典型文档"构造：代码块为低频元素（每 150 节一个），避免病态高亮负载
// （实测 10MB 全代码块密度 pandoc 需 ~30s，段落主导 + 低频代码 ≈ 6s，见 M1 测试报告）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const targets = process.argv.slice(3).map(Number);
mkdirSync(outDir, { recursive: true });

const PARA = '这是一个确定性生成的性能基准段落，包含中文、English 混排与 `inline code`、**加粗**、[链接](https://example.com)。数字 12345 与符号 © → ✅。';
const LIST = '\n- 列表项 {i}-甲\n- 列表项 {i}-乙\n';
const CODE = '\n```python\ndef bench(i: int) -> str:\n    return f"bench {i} 中文"\n```\n';
// 低频元素密度：代码块与列表每 150 节一个（典型文档构成）。
// 实测（M1 测试报告）：列表密集（每节一个，~4 万列表）时 pandoc 3.12 docx writer
// 耗时 ~110s（user 42s + system 15s），属 pandoc 本体边界；典型密度 ~6s < 15s 指标。
const LIST_EVERY = 150;
const CODE_EVERY = 150;

function generate(targetBytes) {
  const chunks = ['# 性能基准样例', ''];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    i += 1;
    let body = PARA;
    if (i % LIST_EVERY === 0) body += LIST.replaceAll('{i}', String(i));
    if (i % CODE_EVERY === 0) body += CODE.replaceAll('{i}', String(i));
    const piece = `## 第 ${i} 节\n\n${body}\n`;
    chunks.push(piece);
    size += Buffer.byteLength(piece, 'utf8');
  }
  return chunks.join('\n');
}

const MB = 1024 * 1024;
for (const t of targets) {
  const bytes = Math.round(t * MB);
  const text = generate(bytes);
  const file = join(outDir, `large-${t}mb.md`);
  writeFileSync(file, text, 'utf8');
  console.log(`[gen] ${file} (${(Buffer.byteLength(text, 'utf8') / MB).toFixed(2)} MB)`);
}
