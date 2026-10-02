import { app } from 'electron';
import { join } from 'node:path';

/**
 * sidecar 环境注入（副作用模块，必须最先 import——core 首次 resolvePandocInfo 后缓存定位结果）。
 * 打包态：pandoc 二进制与 Lua 过滤器都在 extraResources（真实文件系统，pandoc 子进程可读）；
 * 开发态：不注入，core 走既有四级定位（开发缓存 assets/bin）。
 */
if (app.isPackaged) {
  const exe = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  process.env.MD2WORD_PANDOC_BIN = join(process.resourcesPath, 'pandoc', exe);
  process.env.MD2WORD_LUA_FILTER = join(process.resourcesPath, 'filters', 'offline-images.lua');
}
