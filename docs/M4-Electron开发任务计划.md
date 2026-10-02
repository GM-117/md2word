# M4 Electron 开发任务计划

> 依据：[md2word开发计划方案.md](md2word开发计划方案.md) §3 M4 行、§2.1/2.4/2.5、§5 测试策略；[项目进展记录.md](../项目进展记录.md) M4 待办行。
> 制定日期：2026-10-02。本文档是 M4 的执行分解，完成后随测试报告一并归档。

---

## 1. 任务目标（对齐开发计划 §3 M4 行）

| 项 | 内容 |
|---|---|
| 里程碑 | **M4 Electron 包装与分发**（计划人日 2） |
| 内容 | ① Electron 壳接入既有 renderer：HTTP 桥 → IPC，**前端仅换传输层适配器，UI 代码零改动**；② electron-builder 双平台产物 + sidecar 打包校验（产物内 pandoc 可执行、GPL 声明文件在位）；③ 全新虚拟机冒烟清单 |
| DoD | 三平台安装包在干净系统安装→转换→卸载全流程通过；Gatekeeper/SmartScreen 解除指引写入 README |

**版本锁定（启动日 2026-10-02）**：Electron **44.x**（当前最新稳定 44.5.1，锁定大版本，季度升级）；electron-builder 26.x；electron-store 11.x（ESM）。

## 2. 功能模块划分

### M4-1 desktop 应用壳（packages/desktop）

```
packages/desktop/
├─ src/main/            # 主进程（ESM，tsc 编译）
│  ├─ index.ts          # app 入口：单实例锁、BrowserWindow、导航封锁、md2word:// 拦截
│  ├─ sidecar.ts        # 环境注入：MD2WORD_PANDOC_BIN / MD2WORD_LUA_FILTER（打包后 extraResources 路径）
│  ├─ bridge.ts         # ipcMain.handle 白名单通道注册（唯一 IPC 入口）
│  └─ services/         # 纯逻辑服务（不 import electron，可被 vitest 直测）
│     ├─ settings.ts    # electron-store 封装 + 写入校验（白名单键，与 web-host 校验一致）
│     ├─ templates.ts   # 模板列表/导入/删除（core validateTemplate；userData/templates）
│     ├─ convert.ts     # 转换服务：settings 合并 + 模板解析链 + SerialQueue + 作业注册表
│     ├─ jobs.ts        # 作业注册表：jobId → 产物绝对路径（open 白名单的唯一事实源）
│     ├─ resourceUrl.ts # md2word://download/... / md2word://log 解析与白名单校验
│     └─ logger.ts      # 环形缓冲（2000 条）+ 落盘（userData/logs/md2word.log）
├─ src/preload/index.ts # contextBridge 暴露 window.md2word（contextIsolation: true, sandbox: true）
├─ tests/unit/          # vitest 单元测试
├─ tests/integration/   # vitest 集成测试（真实 pandoc，直驱 services 层）
├─ e2e/                 # Playwright _electron 用户故事路径
├─ scripts/             # prepare-resources / verify-dist / dev 启动
├─ build/               # 提交物：THIRD-PARTY-LICENSES.md、icon.icns、electron-builder 资源
└─ electron-builder.yml
```

安全基线（Electron 官方清单）：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`setWindowOpenHandler` 全拒（md2word:// 转交处理器）、`will-navigate` 仅放行 md2word://、单实例锁、无远程内容加载。

### M4-2 IPC 白名单通道（对齐计划 §2.1 末尾清单）

计划清单：`convert:file`、`convert:batch`、`convert:cancel`、`open:path`（仅 .docx 所在目录）、`settings:get/set`、`template:list/add`。renderer 的 `ApiTransport` 接口（M2 冻结、UI 零改动的前提）要求全部方法可达，故实际白名单如下——**超出计划清单的 4 条均标注依据**：

| IPC 通道 | 映射 ApiTransport 方法 | 说明 |
|---|---|---|
| `app:health` | `health()` | 窗口头部健康状态（计划清单未列，接口必需） |
| `convert:batch` | `convert(File[], options)` | 文件条目 = {name, path?}（path 优先）或 {name, bytes}（虚拟文件回退） |
| `convert:file` | 同上（单文件别名） | 保持计划命名；与 batch 共用实现 |
| `convert:cancel` | `cancel()` | 队列 cancelAll + 进程树 kill（core 既有） |
| `settings:get` / `settings:set` | `getSettings()` / `saveSettings()` | 校验规则与 web-host PUT 一致（highlightStyle/tocDepth/recentFiles 截断） |
| `open:path` | `open(jobId, name, folder)` | **白名单 = 作业注册表内产物**；path 模式仅允许打开本次转换的 .docx（对齐"仅 .docx 所在目录"） |
| `template:list` / `template:add` | `listTemplates()` / `uploadTemplate()` | add 走字节通道；缺样式拒绝并返回 missingStyles |
| `template:delete` | `deleteTemplate()` | **超出计划清单**：ApiTransport 接口含此方法；仅限删除 userData/templates 下文件 |
| `dialog:exportLog` | `exportLogUrl()` 配套 | 存盘对话框写出日志 txt（渲染层仍是无副作用的 URL 字符串） |

### M4-3 renderer 传输适配器切换（唯一 renderer 改动 = lib/transport.ts）

- 新增 `IpcTransport implements ApiTransport`：经 `window.md2word` 桥调用 IPC；`File` → `webUtils.getPathForFile()` 取真实路径（path 模式），取不到路径（Playwright setInputFiles 等虚拟文件）时回退读字节（bytes 模式，与 web-host 上传等价）。
- 导出选择器：`window.md2word ? new IpcTransport() : new HttpTransport()`。**App.tsx / styles.css 零改动**（以 git diff 为证）。
- "下载 .docx"与"导出日志"两个锚点在桌面端指向 `md2word://` URL：主进程在 `will-navigate` / `setWindowOpenHandler` 拦截 → 弹出**存盘对话框**（默认文件名 = 产物名 / md2word-log.txt）→ 复制/写出文件。页面不跳转、无窗口打开。
- 桌面端语义：转换输出**直接写在源 .md 同目录**（core `resolveOutputPath` 默认），尊重"覆盖同名输出"开关（冲突报 E_OUTPUT_EXISTS 人话错误）；"打开"= 系统默认程序打开 .docx，"打开所在文件夹"= 定位该文件。path 模式下"下载 .docx"= 存一份副本到用户指定位置。

### M4-4 sidecar 与 core 注入点

- 打包后 pandoc 经 extraResources 落在 `Resources/pandoc/pandoc(.exe)`，主进程启动时设 `MD2WORD_PANDOC_BIN`（core 定位第 2 级"宿主注入"，**core 零改动**）。
- **core 一处 1 行内部改动**：`convert.ts` 离线过滤器路径支持 `MD2WORD_LUA_FILTER` 环境变量覆盖（缺省仍为 `CORE_ROOT/assets/offline-images.lua`）。依据：打包后 core 位于 app.asar 内，pandoc 是外部进程**读不到 asar 虚拟路径**，Lua 过滤器必须落真实文件系统；该改动沿用 pandoc.ts 既有 env 注入模式，公开接口（ConvertOptions/返回值）不变，补单元测试锁定。
- 内置中文模板 reference-zh.docx 同样以 extraResources 分发（`Resources/templates/`），desktop 模板解析链在打包态用它替代 core 内置路径（asar 内 docx 传给 pandoc 同样不可读）。开发态仍用 core 仓库内文件。

### M4-5 打包与分发

- `electron-builder.yml`：`appId: com.md2word.app`，产物 dmg（arm64/x64）+ NSIS（x64）；`asar: true`；extraResources 五项（renderer 产物 / pandoc sidecar / 内置模板 / lua 过滤器 / THIRD-PARTY-LICENSES.md）。
- `scripts/prepare-resources.mjs`：构建时从 core 缓存/lock 提取**目标平台** pandoc 二进制 + 汇集各资源到 resources/ 暂存目录（支持在 macOS 交叉出 Windows 包：从 downloads 缓存解包 win32-x64 zip）。
- `scripts/verify-dist.mjs`：**sidecar 打包校验**（DoD 硬项）——对解包产物断言：pandoc 可执行且 `--version` == `pandoc.lock.json` 版本；THIRD-PARTY-LICENSES.md 在位且含 GPL-2.0 文本特征与源码链接；reference-zh.docx / offline-images.lua 在位；asar 内含 dist 与 @md2word/core。CI release.yml 接线（tag → 三平台 dist → verify → 上传）。
- GPL 合规（§2.4）：THIRD-PARTY-LICENSES.md = pandoc GPL-2.0 完整文本 + 源码地址 github.com/jgm/pandoc + 锁定版本 3.12 与 lock SHA-256 摘录；随包进 Resources；关于面板 credits 指引（macOS）。

### M4-6 测试（对齐 §5 分层）

| 层 | 范围 | 门禁 |
|---|---|---|
| 单元（vitest） | 设置校验、作业注册表白名单、md2word:// 解析拒绝穿越、模板链解析、lua env 覆盖（core 侧） | 全绿；core 既有 106 例不回归 |
| 集成（vitest + 真实 pandoc） | services 层全链路：path 模式（输出落源目录、覆盖开关）、bytes 模式（staged）、模板链（内置/用户/pandoc-default）、离线过滤 env 生效、取消 | 全绿 |
| E2E（Playwright `_electron`） | P0 用户故事路径：启动→health 显示 bundled pandoc→选文件转换→结果卡与统计→设置持久化（重启窗口恢复）→模板导入→失败路径人话错误 | 全绿 |
| 打包校验 | verify-dist.mjs 对 `--dir` 产物断言（本机可执行） | 全过 |
| 安装冒烟 | macOS 本机：安装 dmg→启动→转换→打开 docx→卸载；干净虚拟机清单见 docs/tests/M4-冒烟清单.md | macOS 本机过；虚拟机项待人工 |

### M4-7 文档与验收

- 根 `README.md`（M4 DoD）：安装步骤（dmg/NSIS）、**Gatekeeper 解除指引**（右键打开 / `xattr -cr`）、**SmartScreen "仍要运行"指引**、卸载步骤、PANDOC_PATH 改用系统 pandoc、构建方法。
- `docs/tests/M4测试报告.md`（逐项证据 + 缺陷记录）、`docs/tests/M4-冒烟清单.md`（三平台干净虚拟机 checklist，含缺网络启动项）、`项目进展记录.md` 更新。

## 3. 与既定计划的偏差声明（实现细节级，均不改变范围/接口）

1. **IPC 白名单扩充 4 条**（app:health / template:delete / dialog:exportLog / convert:file 与 batch 并存）——由"UI 零改动"约束的 ApiTransport 接口决定，见 §M4-2 表。
2. **core 1 行内部改动**（MD2WORD_LUA_FILTER env）——打包态 asar 路径对外部进程不可见的唯一解，见 §M4-4。
3. **下载/日志导出实现为"导航拦截 + 存盘对话框"**而非 HTTP 端点——桌面端无本地服务，锚点 URL 语义保真。
4. Windows 安装包图标暂用 electron-builder 默认图标（不涉 DoD；自绘 .ico 列为 M5 打磨项）。

## 4. DoD 对照与本次交付边界

| DoD 项 | 本次交付 | 状态 |
|---|---|---|
| Electron 壳 + IPC 换传输层、UI 零改动 | desktop 包全量 + renderer 仅 transport.ts/index.html | ✅ 本机交付 |
| electron-builder 双平台产物 | macOS dmg（arm64/x64）本机构建 + Windows NSIS 交叉构建尝试；release.yml 三平台接线 | ✅/🔶（Windows 产物以 CI/交叉构建结果为准） |
| sidecar 打包校验（pandoc 可执行 + GPL 声明在位） | verify-dist.mjs + 接入 release.yml | ✅ 本机交付 |
| 三平台干净系统安装→转换→卸载 | macOS 本机全流程实测；**干净虚拟机冒烟为人工项**，清单随包交付 | 🔶 待人工执行（与进展记录 M4 行前置条件一致） |
| Gatekeeper/SmartScreen 指引写入 README | 根 README.md 新增 | ✅ 本机交付 |

> 按协作约定"M4 DoD 全部通过才算完成"：本次交付后 M4 状态记为 **🔶 代码完成（本机验证通过），三平台虚拟机冒烟待人工执行**，不计入"完成"。
