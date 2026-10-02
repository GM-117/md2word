# @md2word/desktop（Electron 壳）

md2word 的桌面形态：Electron 主进程以**白名单 IPC 通道**桥接 `@md2word/core`，复用
`@md2word/renderer` 构建产物（UI 零改动，仅传输适配器换成 IPC——见
`packages/renderer/src/lib/transport.ts` 的 `IpcTransport`）。pandoc 3.12 以
extraResources sidecar 捆绑（GPL 合规见包内 `THIRD-PARTY-LICENSES.md`）。

## 结构

```
src/main/           # 主进程（ESM）
  index.ts          # app 入口：单实例锁、窗口、导航封锁、md2word:// 拦截
  sidecar.ts        # 环境注入：MD2WORD_PANDOC_BIN / MD2WORD_LUA_FILTER（打包态）
  bridge.ts         # ipcMain.handle 白名单通道（app:health / convert:* / settings:* / open:path / template:*）
  context.ts        # 服务装配（不 import electron，可被 vitest 直测）
  services/         # settings(electron-store) / templates / convert / jobs(白名单注册表) / resourceUrl / logger
src/preload/        # contextBridge 暴露 window.md2word（contextIsolation + sandbox）
tests/unit/         # vitest 单元（纯逻辑）
tests/integration/  # vitest 集成（真实 pandoc，直驱 services）
e2e/                # Playwright _electron 桌面 E2E
scripts/            # dist.mjs 编排 / prepare-resources / verify-dist / make-icon / build-preload / run-electron-dev
build/              # 提交物：THIRD-PARTY-LICENSES.md、icon.icns、icon.ico
resources/          # 构建暂存（gitignored，prepare-resources 产出）
release/            # 安装包输出（gitignored）
```

## 常用命令

```bash
pnpm --filter @md2word/desktop build          # 主进程 tsc + preload(esbuild→CJS)
pnpm --filter @md2word/desktop dev            # 连接 renderer dev server（5173）启动 Electron
pnpm --filter @md2word/desktop test           # 单元
pnpm --filter @md2word/desktop test:integration  # 集成（真实 pandoc）
pnpm --filter @md2word/desktop e2e            # Playwright _electron（自动先 build）
pnpm --filter @md2word/desktop dist           # electron-builder 安装包（dmg/NSIS）
pnpm --filter @md2word/desktop dist:dir       # 解包产物（供 verify-dist）
node scripts/verify-dist.mjs <appDir> [--win] # sidecar/GPL/renderer 在位校验
```

跨平台交叉打包：`node scripts/dist.mjs --win`（Windows NSIS，pandoc 从 downloads 缓存解包）；
`--x64` 出 Intel dmg。CI 由 release.yml 三平台矩阵接线。

## 关键设计约束

- **渲染层零改动**：renderer 仅 `lib/transport.ts` 增加 IpcTransport + 环境自动选择；App.tsx/styles.css 未动。
- **pandoc 与 Lua 过滤器必须在 asar 之外**（pandoc 是外部进程，读不了 asar 虚拟路径）：
  sidecar 与 offline-images.lua 走 extraResources，经 `MD2WORD_PANDOC_BIN` / `MD2WORD_LUA_FILTER` 注入。
- **open:path 白名单**：只有作业注册表登记过的产物可打开/定位；用户输入不参与路径拼接。
- **下载/导出 = 导航拦截 + 存盘对话框**：`md2word://download/<jobId>/<name>` 与 `md2word://log/export`。
