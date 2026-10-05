#!/usr/bin/env node
// 下载并校验 pandoc sidecar 二进制（版本锁定见 assets/pandoc.lock.json）。
// 产物落位：packages/core/assets/bin/<version>/<platform>/pandoc(.exe)
// 任何宿主（web-host / desktop / mcp-server）经 core 的 resolvePandocPath() 定位该产物。
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(coreRoot, 'assets', 'pandoc.lock.json'), 'utf8'));

// 平台键默认取当前进程平台；可显式指定（如 `darwin-x64`）用于交叉打包
// （例：macos-14 arm64 runner 上构建 x64 dmg，release.yml 的 x64 作业调用）
const requested = process.argv[2];
const platformKey = requested ?? `${process.platform}-${process.arch}`;
const entry = lock.platforms[platformKey];
if (!entry) {
  console.error(`[fetch-pandoc] lock 中无平台 ${platformKey}，可用：${Object.keys(lock.platforms).join(', ')}`);
  process.exit(1);
}
const targetPlatform = platformKey.split('-')[0];

const downloadsDir = join(coreRoot, 'assets', 'downloads');
mkdirSync(downloadsDir, { recursive: true });
const zipPath = join(downloadsDir, entry.zip);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

if (!existsSync(zipPath) || sha256(readFileSync(zipPath)) !== entry.sha256) {
  console.log(`[fetch-pandoc] 下载 ${entry.url}`);
  const res = await fetch(entry.url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`[fetch-pandoc] 下载失败：HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== entry.sha256) {
    console.error(`[fetch-pandoc] SHA-256 不匹配！\n  期望 ${entry.sha256}\n  实际 ${actual}`);
    process.exit(1);
  }
  writeFileSync(zipPath, buf);
  console.log(`[fetch-pandoc] SHA-256 校验通过 (${entry.sha256.slice(0, 12)}…, ${statSync(zipPath).size} bytes)`);
} else {
  console.log('[fetch-pandoc] 命中本地缓存且校验和一致，跳过下载');
}

// 解包（内存中）并提取 pandoc 可执行文件
const zipBuf = new Uint8Array(readFileSync(zipPath));
const files = unzipSync(zipBuf);
const binName = targetPlatform === 'win32' ? 'pandoc.exe' : 'pandoc';
const hit = Object.keys(files).find((n) => n.endsWith('/' + binName) || n === binName);
if (!hit) {
  console.error(`[fetch-pandoc] zip 中未找到 ${binName}，包含：${Object.keys(files).join(', ')}`);
  process.exit(1);
}

const outDir = join(coreRoot, 'assets', 'bin', lock.version, platformKey);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, binName);
const tmpPath = outPath + '.tmp';
writeFileSync(tmpPath, files[hit]);
// Windows 上目标被占用（如残留进程）时 rename 会失败，先尝试删除
try { unlinkSync(outPath); } catch { /* 不存在即忽略 */ }
renameSync(tmpPath, outPath);
if (targetPlatform !== 'win32') chmodSync(outPath, 0o755);
console.log(`[fetch-pandoc] 就绪：pandoc ${lock.version} → ${outPath}`);
