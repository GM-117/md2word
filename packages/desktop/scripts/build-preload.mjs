import { build } from 'esbuild';

/**
 * 预加载脚本构建：sandboxed preload 必须是 CJS。
 * electron 保持外部依赖（运行时由 Electron 注入，不能打包进去）。
 */
await build({
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'inline',
});
console.log('[desktop] preload → dist/preload/index.cjs');
