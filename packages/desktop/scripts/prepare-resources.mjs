import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 打包资源暂存（dist.mjs 编排，electron-builder extraResources 引用 resources/）：
 * - renderer 构建产物 → resources/renderer
 * - 目标平台 pandoc sidecar（优先取 core 缓存，跨平台目标从 downloads 缓存 zip 解包）→ resources/pandoc
 * - 内置中文模板 → resources/templates；Lua 离线过滤器 → resources/filters
 * GPL 声明不入暂存：electron-builder 直接取 build/THIRD-PARTY-LICENSES.md（提交物）。
 */

const HERE = new URL('.', import.meta.url).pathname;
const DESKTOP = join(HERE, '..');
const REPO = join(DESKTOP, '..', '..');
const CORE_ASSETS = join(REPO, 'packages', 'core', 'assets');
const RESOURCES = join(DESKTOP, 'resources');

/** 解析目标平台：dist.mjs 传入 --arm64 / --x64 / --win 标记；默认当前平台（--win 隐含 x64） */
export function resolveTarget(argv) {
  let platform = process.platform;
  let arch = process.arch;
  if (argv.includes('--win')) {
    platform = 'win32';
    if (!argv.includes('--arm64')) arch = 'x64';
  }
  if (argv.includes('--arm64')) arch = 'arm64';
  if (argv.includes('--x64')) arch = 'x64';
  return { platform, arch };
}

const PLATFORM_DIR = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'win32-x64': 'win32-x64' };

/** 从 lock 指定的 zip 解包出 pandoc 可执行（跨平台交叉打包场景） */
function extractPandocFromZip(zipPath, destDir, exeName) {
  const tmp = join(destDir, '.extract');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  if (process.platform === 'win32') {
    execSync(`tar -xf "${zipPath}" -C "${tmp}"`); // Windows 10+ bsdtar 支持 zip
  } else {
    execSync(`unzip -q -o "${zipPath}" -d "${tmp}"`);
  }
  // zip 内目录名 pandoc-3.12-<platform>/bin/pandoc
  const found = findFile(tmp, exeName);
  if (!found) throw new Error(`zip 内未找到 ${exeName}：${zipPath}`);
  copyFileSync(found, join(destDir, exeName));
  if (process.platform !== 'win32') execSync(`chmod +x "${join(destDir, exeName)}"`);
  rmSync(tmp, { recursive: true, force: true });
}

function findFile(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

export function prepareResources(argv = []) {
  const { platform, arch } = resolveTarget(argv);
  const key = PLATFORM_DIR[`${platform}-${arch}`];
  if (!key) throw new Error(`不支持的目标平台：${platform}-${arch}（v1.0 矩阵：darwin-arm64/darwin-x64/win32-x64）`);

  rmSync(RESOURCES, { recursive: true, force: true });
  mkdirSync(join(RESOURCES, 'pandoc'), { recursive: true });
  mkdirSync(join(RESOURCES, 'templates'), { recursive: true });
  mkdirSync(join(RESOURCES, 'filters'), { recursive: true });

  // renderer
  const rendererDist = join(REPO, 'packages', 'renderer', 'dist');
  if (!existsSync(join(rendererDist, 'index.html'))) {
    throw new Error('renderer 未构建：先运行 pnpm --filter @md2word/renderer build');
  }
  cpSync(rendererDist, join(RESOURCES, 'renderer'), { recursive: true });

  // pandoc sidecar：当前平台优先取已解包缓存；否则从 downloads zip 解包（SHA-256 校验由 fetch 脚本负责）
  const exe = platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  const cached = join(CORE_ASSETS, 'bin', '3.12', key, exe);
  if (existsSync(cached)) {
    copyFileSync(cached, join(RESOURCES, 'pandoc', exe));
    if (platform !== 'win32') execSync(`chmod +x "${join(RESOURCES, 'pandoc', exe)}"`);
  } else {
    const zipName = {
      'darwin-arm64': 'pandoc-3.12-arm64-macOS.zip',
      'darwin-x64': 'pandoc-3.12-x86_64-macOS.zip',
      'win32-x64': 'pandoc-3.12-windows-x86_64.zip',
    }[key];
    const zipPath = join(CORE_ASSETS, 'downloads', zipName);
    if (!existsSync(zipPath)) {
      throw new Error(`pandoc 缓存缺失：${zipPath}（先运行 pnpm setup 下载）`);
    }
    extractPandocFromZip(zipPath, join(RESOURCES, 'pandoc'), exe);
  }

  // 模板与过滤器
  copyFileSync(join(CORE_ASSETS, 'reference-zh.docx'), join(RESOURCES, 'templates', 'reference-zh.docx'));
  copyFileSync(join(CORE_ASSETS, 'offline-images.lua'), join(RESOURCES, 'filters', 'offline-images.lua'));

  console.log(`[prepare-resources] target=${platform}-${arch} → resources/ ✓`);
}

if (process.argv[1] && process.argv[1].endsWith('prepare-resources.mjs')) {
  prepareResources(process.argv.slice(2));
}
