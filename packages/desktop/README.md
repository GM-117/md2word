# @md2word/desktop（Electron 壳）

**状态：M4 实施前占位。** 依据已确认决策 #1（Web 先行）：renderer 为纯网页，M2 先交付
`packages/web-host` 功能完整的网页版；M4 用 Electron 包装既有 renderer（HTTP 桥 → IPC
仅替换传输层适配器，UI 代码零改动），pandoc sidecar 以 extraResources 捆绑
（版本锁定见 `packages/core/assets/pandoc.lock.json`，GPL 合规见开发计划 §2.4）。

本包在 M4 时包含：

```
src/main/       # Node 主进程：业务唯一入口，白名单 IPC 通道
src/preload/    # contextBridge，类型安全 API（contextIsolation: true）
src/renderer/   # 复用 @md2word/renderer 构建产物
resources/      # electron-builder extraResources（pandoc 二进制、THIRD-PARTY-LICENSES.md）
electron-builder.yml
```
