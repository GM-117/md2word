import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * sidecar 打包校验（M4 DoD 硬项）：对解包产物断言
 * ① pandoc 可执行且 --version 与 lock 一致 ② THIRD-PARTY-LICENSES.md 在位且含 GPL 文本特征 + 源码链接
 * ③ 内置模板 / Lua 过滤器 / renderer 产物在位 ④ app.asar 存在且非空
 * 用法：node scripts/verify-dist.mjs <appBundleDir> [--win]
 *   mac: release/macos-arm64/md2word.app ；win: release/win-unpacked
 */

const [, , targetArg, winFlag] = process.argv;
if (!targetArg) {
  console.error('用法：node scripts/verify-dist.mjs <appDir> [--win]');
  process.exit(2);
}

const isWin = winFlag === '--win';
const checks = [];
const add = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// 路径布局：mac .app/Contents/Resources | win <dir>/resources
const appRoot = isWin ? targetArg : join(targetArg, 'Contents');
const resDir = isWin ? join(appRoot, 'resources') : join(appRoot, 'Resources');

const exe = isWin ? 'pandoc.exe' : 'pandoc';
const pandocPath = join(resDir, 'pandoc', exe);
add('pandoc sidecar 在位', existsSync(pandocPath), pandocPath);

// 期望架构：win 固定 x64；mac 按产物目录名（release/mac → x64，release/mac-arm64 → arm64）。
// 必须断言架构本身：x64 pandoc 在 arm64 mac 上可经 Rosetta 执行 --version，仅运行检查发现不了错配。
const expectedArch = isWin ? 'x64' : /arm64/.test(targetArg) ? 'arm64' : 'x64';
function pandocArch() {
  if (isWin) {
    // PE 头 machine 字段：0x8664=x64，0xAA64=arm64
    const b = readFileSync(pandocPath);
    const peOff = b.readUInt32LE(0x3c);
    const machine = b.readUInt16LE(peOff + 4);
    return machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `0x${machine.toString(16)}`;
  }
  // Mach-O：lipo -archs 输出 arm64 / x86_64
  const out = execFileSync('lipo', ['-archs', pandocPath], { encoding: 'utf8' }).trim();
  return out.split(' ').includes('x86_64') ? 'x64' : out;
}

if (existsSync(pandocPath)) {
  // Windows 产物在 mac/linux 上无法执行 → 校验 PE 头（MZ）；本机产物正常执行 --version
  const canRun = isWin === (process.platform === 'win32');
  if (!canRun) {
    const head = readFileSync(pandocPath).subarray(0, 2).toString();
    add('pandoc 可执行（PE 头 MZ，交叉构建校验）', head === 'MZ', `${head} ${Math.round(statSync(pandocPath).size / 1024 / 1024)}MB`);
  } else {
    let version = '';
    try {
      version = execFileSync(pandocPath, ['--version'], { encoding: 'utf8' }).split('\n')[0] ?? '';
      add('pandoc 可执行（--version）', /pandoc\s+3\.12/.test(version), version.trim());
    } catch (err) {
      add('pandoc 可执行（--version）', false, err instanceof Error ? err.message : String(err));
    }
  }
  let archOk = false;
  let archDetail = '';
  try {
    const actual = pandocArch();
    archOk = actual === expectedArch;
    archDetail = `实际 ${actual} / 期望 ${expectedArch}`;
  } catch (err) {
    archDetail = err instanceof Error ? err.message : String(err);
  }
  add('pandoc 架构与目标匹配', archOk, archDetail);
}

const licensePath = join(resDir, 'THIRD-PARTY-LICENSES.md');
add('GPL 声明文件在位', existsSync(licensePath));
if (existsSync(licensePath)) {
  const text = readFileSync(licensePath, 'utf8');
  add('GPL-2.0 完整文本特征', text.includes('GNU GENERAL PUBLIC LICENSE') && text.includes('Version 2, June 1991'));
  add('pandoc 源码地址在位', text.includes('github.com/jgm/pandoc'));
  add('锁定版本说明在位', text.includes('3.12'));
}

add('内置中文模板在位', existsSync(join(resDir, 'templates', 'reference-zh.docx')));
add('Lua 离线过滤器在位', existsSync(join(resDir, 'filters', 'offline-images.lua')));
add('renderer 产物在位', existsSync(join(resDir, 'renderer', 'index.html')));

const asarPath = isWin ? join(resDir, 'app.asar') : join(resDir, 'app.asar');
const asarOk = existsSync(asarPath) && statSync(asarPath).size > 1024 * 1024;
add('app.asar 存在且非空', asarOk, asarOk ? `${Math.round(statSync(asarPath).size / 1024 / 1024)}MB` : asarPath);

const failed = checks.filter((c) => !c.ok);
console.log(`\nverify-dist: ${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error('失败项：', failed.map((f) => f.name).join('；'));
  process.exit(1);
}
