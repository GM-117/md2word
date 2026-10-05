// 生成发布资产 SHA-256 清单（release.yml 用）。
// 用法：node release-sha256.mjs <资产目录> → 目录内写出 SHA256SUMS.txt（sha256sum 标准两空格格式）
// 仅收 .dmg/.exe（矩阵各 runner 只持本平台产物，清单由矩阵完成后的独立 job 统一汇总生成）。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('[sha256] 用法：node release-sha256.mjs <资产目录>');
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((f) => /\.(dmg|exe)$/i.test(f))
  .sort();

if (files.length === 0) {
  console.error(`[sha256] 目录中无 .dmg/.exe 资产：${dir}`);
  process.exit(1);
}

const lines = files.map((name) => {
  const hash = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  console.log(`[sha256] ${hash}  ${name}`);
  return `${hash}  ${name}`;
});

writeFileSync(join(dir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(`[sha256] 就绪：${join(dir, 'SHA256SUMS.txt')}（共 ${lines.length} 项）`);
