import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { prepareResources } from './prepare-resources.mjs';

/**
 * 打包编排：解析 electron-builder 目标参数 → 按目标暂存资源（含跨平台 pandoc）→ 执行 electron-builder。
 * 用法：node scripts/dist.mjs [--arm64 | --x64 | --win]（参数原样透传给 electron-builder）。
 */
const args = process.argv.slice(2);
prepareResources(args);

// electron-builder 的 bin 是 shell shim（跨 spawn 不可靠），直接以 node 运行其 CLI 入口。
// 路径一律走 fileURLToPath：URL.pathname 在 Windows 产出 '/D:/...'（D40）
const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)));
const cliPath = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [cliPath, ...args], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
