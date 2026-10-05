# md2word —— 个人跨平台 Markdown→Word 转换工具 · 可执行开发计划

> 版本：v1.0（已确认）｜日期：2026-09-29｜状态：**评审通过，四项决策已并入（见 §8）；开发任务由 md2word 工作区（`01_code/md2word`）下发**
> 架构基线：方案 A（pandoc 子进程 + reference.docx 样式模板），沿用《Markdown转Word工具调研报告》的实测结论与数据。
> 本文档为唯一开发依据；与调研报告冲突时以本文档为准。

---

## 1. 需求分析

### 1.1 产品定位

给本人使用的桌面工具：**把 .md 文件变成排版合格的 .docx，全程零命令行**。质量对齐 pandoc（公式可编辑、代码高亮、中文样式），离线可用、隐私零上传。

### 1.2 用户故事（验收视角）

| # | 用户故事 | 验收口径 |
|---|---|---|
| US1 | 我把一个 .md 拖进窗口，1 秒后得到同名 .docx，点"打开"直接进 Word | 含中文文件名/路径 |
| US2 | 我选一个文件夹，把里面所有 .md（含子目录）批量转换，看到逐个的成功/失败清单 | 失败不中断队列 |
| US3 | 我第一次打开软件就能用：pandoc 已内置，默认中文样式模板已就绪 | 不装任何依赖 |
| US4 | 我可以勾选"生成目录/章节编号/换高亮风格"，或导入自己的 reference.docx 模板 | 选项即时生效 |
| US5 | 失败时我看到人话原因（图片缺失/公式解析失败/pandoc 报错原文），并能一键导出日志 | 不是裸 stderr |
| US6 | 设置和最近文件下次打开还在 | 本地持久化 |

### 1.3 功能需求分级

- **P0（首版必须）**：单文件转换（拖拽 + 文件选择）；pandoc sidecar 内置免安装；进度与结果反馈；打开文件/打开所在文件夹；基础选项（TOC 开关、目录层级、章节编号、高亮风格、输出目录、覆盖策略）；中文路径全链路支持；结构化错误展示与日志导出；设置持久化。
- **P1（v1.1，已确认延后但需求保留）**：~~文件夹递归批量转换~~（**已于 2026-10-04 经用户指令上移，作为 M6 实施，见 §8 决策 #5**）；模板管理（导入/选择/另存默认）；YAML 元数据（标题/作者）面板透传；最近文件列表；日志查看器。
- **P2（按需）**：监视文件夹自动转换；electron-updater 自动更新；多语言。（轻量版安装包方案已评审否决，不再排期）

### 1.4 非功能需求

| 维度 | 指标 |
|---|---|
| 平台 | macOS 12+（arm64 + x64）、Windows 10/11（x64） |
| 性能 | 1MB 级 md 转换 < 2s；10MB 级 < 15s；转换全程不冻结 UI |
| 隐私 | 完全离线；无遥测、无崩溃上报（日志仅本地） |
| 合规 | 捆绑 pandoc（GPL-2.0+）须随包附许可证文本与源码链接（见 §2.4） |
| 可靠性 | pandoc 崩溃/超时不拖垮应用；输出原子写（临时文件 + 改名），不产生半成品文件 |
| 健壮性 | 中文/空格/emoji/超长路径专项通过；单文件损坏不影响批量队列 |

---

## 2. 总体架构与技术选型

### 2.1 架构图（方案 A 落地形态）

```
┌──────────────────── Electron 桌面应用 ────────────────────┐
│ Renderer（React + Vite）                                   │
│   拖拽区 / 批量列表 / 选项面板 / 结果与日志                  │
│        ↕  contextBridge IPC（类型安全，白名单通道）          │
│ Main（Node，业务唯一入口）                                   │
│   ├─ core/preprocess  图片路径绝对化、输入规范化             │
│   ├─ core/pandoc      sidecar 定位、spawn（参数数组）、超时  │
│   ├─ core/validate    产物校验：zip 完整性 + document.xml    │
│   │                   元素断言 + 统计 + stderr 分类          │
│   ├─ core/template    reference.docx 模板注册/校验           │
│   └─ core/queue       串行队列 + 原子落盘                   │
└──────────────┬─────────────────────────────────────────────┘
               │ spawn（独立进程，GPL "arm's length" 边界）
        ┌──────▼───────────────┐
        │ pandoc 3.12.x sidecar │（extraResources，版本锁定 + SHA-256）
        └──────────────────────┘
```

分层原则：**packages/core 为纯 TypeScript 库（不 import Electron）**。core 之上挂三种宿主：`desktop`（Electron，最终产品）、`web-host`（Fastify 本地服务 + 浏览器访问——**已确认的"Web 先行"路径**，M2 先交付功能完整的网页版，M4 换 Electron 壳时 UI 代码零改动，仅把 HTTP 桥替换为 IPC）、`mcp-server`（Agent 工具，详见《MCP设计方案》）。

### 2.2 技术选型（含否决理由）

| 项 | 选型 | 理由 |
|---|---|---|
| 应用壳 | **Electron（启动日最新稳定版，锁定大版本）** | 生态与资料最全、electron-builder 一键出双平台安装包、纯 TS 无第二工具链；磁盘代价已量化（§2.3），个人场景可接受 |
| 浏览器模式 | **packages/web-host（Fastify 桥接 core + 静态托管 renderer 产物）** | 已确认的 Web 先行路径：renderer 本就是纯网页，经本地 HTTP 桥即可在浏览器中功能完整地跑通转换；同一组能力以 REST 形态暴露（`/api/convert` 等），M4 切 IPC 时前端仅替换传输层适配器 |
| 备选 | Tauri 2 | 安装后省约 200MB、内存更小；代价是 Rust 工具链与更高的打包调试成本。**core 层纯 TS 可整体迁移**，如评审时更在意体积可切换，不影响本计划其他章节 |
| 否决 | PySide6+PyInstaller | 需双端分别构建、macOS 公证链路繁琐、Windows 杀软对 PyInstaller 误报率高 |
| 否决 | pandoc-wasm 纯网页 | 大文件与浏览器兼容风险高，无 file 系统级批量能力 |
| 语言/构建 | TypeScript 5.x + Vite（renderer）+ tsc/esbuild（main、core） | — |
| UI | React 18 + 少量自绘组件（无重型组件库） | 界面面积极小，拖一个列表 + 表单即可 |
| 打包 | electron-builder（dmg / NSIS） | 双平台产物、自动更新接口预留 |
| 测试 | Vitest（单元/集成）+ Playwright `_electron`（E2E） | 唯一同时覆盖 Electron 双平台的方案 |
| pandoc | 3.12.x（版本锁定，升级走独立 PR） | 调研当日最新，性能专项版本 |

### 2.3 体积账（实测数据，评审关注点）

pandoc 3.12 macOS arm64 二进制解包实测 **183MB**（zip 42MB，压缩比约 4.4:1）。由此估算：

| 产物 | 估算 |
|---|---|
| Electron 应用本体（dmg） | ~85–95MB |
| + 捆绑 pandoc 后安装包 | **~130–150MB（dmg）** |
| 安装后占用 | ~380–430MB（Electron ~250MB + pandoc 183MB） |

**策略（已确认）：捆绑 sidecar，开箱即用**（离线可靠、无首启失败路径）；接受上述体积，轻量版/首启下载方案评审否决、不再排期。

### 2.4 GPL 合规策略（方案 A 的既定边界）

pandoc 以独立二进制子进程调用（arm's length，FSF 通行解读：自有代码不被传染）。捆绑分发时随包履行最低义务：

1. 安装包与"关于"页内含 `THIRD-PARTY-LICENSES.md`：pandoc GPL-2.0 完整文本 + 官方源码地址（github.com/jgm/pandoc）+ 锁定版本号与变更说明；
2. 不静态链接、不修改 pandoc 本体（一切定制走命令行参数、reference.docx、Lua 过滤器）；
3. 提供设置项允许用户改用系统自装 pandoc（`PANDOC_PATH`），保持"用户可自行获取源码等价物"的通道。

### 2.5 目录结构

```
md2word/
├─ package.json                  # npm workspaces
├─ packages/
│  ├─ core/                      # 纯 TS 转换核心（可被 desktop 与 mcp-server 复用）
│  │  ├─ src/{types,pandoc,preprocess,convert,validate,template,queue}.ts
│  │  ├─ assets/reference-zh.docx        # 内置中文模板（pandoc 默认模板改样式生成）
│  │  └─ test/
│  ├─ desktop/                   # Electron 壳
│  │  ├─ src/main/  src/preload/  src/renderer/
│  │  ├─ resources/              # electron-builder extraResources（pandoc 放此）
│  │  └─ electron-builder.yml
│  └─ mcp-server/                # 见《MCP设计方案》（M1 后实施，1 人日）
├─ samples/                      # 黄金样例集（§6.2）
├─ scripts/                      # 结构断言、性能基准脚本
└─ .github/workflows/{ci,release}.yml
```

### 2.6 核心接口（M1 冻结）

```ts
export interface ConvertOptions {
  toc?: boolean;                 // → --toc
  tocDepth?: 1|2|3|4|5|6;        // → --toc-depth（默认 3）
  numberSections?: boolean;      // → --number-sections
  highlightStyle?: 'pygments'|'tango'|'espresso'|'zenburn'|'kate'|'monochrome';
  referenceDocx?: string;        // 模板绝对路径；缺省 assets/reference-zh.docx
  outputDir?: string;            // 缺省与源文件同目录
  overwrite?: boolean;           // 默认 false：同名存在→报 E_OUTPUT_EXISTS
  metadata?: { title?: string; author?: string };
  timeoutMs?: number;            // 默认 60_000
}
export interface ConvertResult {
  ok: boolean;
  outputPath?: string;
  durationMs: number;
  stats?: { headings:number; tables:number; images:number; math:number; footnotes:number; codeBlocks:number; plainCodeBlocks:number };
  warnings: Warning[];           // 分类见 §6.3
  error?: { code: ErrorCode; message: string; stderrTail?: string };
}
export declare function convertMarkdown(srcPath: string, opts?: ConvertOptions): Promise<ConvertResult>;
export declare function* convertBatch(srcPaths: string[], opts: ConvertOptions): AsyncGenerator<ConvertResult>;
```

IPC 通道（白名单）：`convert:file`、`convert:batch`、`convert:cancel`、`open:path`（仅 .docx 所在目录）、`settings:get/set`、`template:list/add`。渲染进程无 Node 权限（`contextIsolation: true`）。

---

## 3. 开发里程碑（首版约 9 人日，含 30% buffer ≈ 12 人日；业余时间日历周期约 3 周；v1.1 批量转换另计 +1 人日）

| 里程碑 | 内容 | 人日 | 完成定义（DoD，全部可验证） |
|---|---|---|---|
| **M0 骨架** 0.5d | workspaces + TS 配置 + Electron/Vite 起步窗口 + CI 矩阵骨架（macos-14 / macos-13 / windows-2022） | 0.5 | 三平台 CI 空跑绿灯；`pnpm dev` 出窗口 |
| **M1 转换核心** | core 全模块：pandoc spawn（参数数组、UTF-8、进程树超时 kill）；选项→flag 映射；stderr 分类；zip+XML 校验与统计；原子写；串行队列 | 1.5 | ① 参数构建器快照测试通过；② 黄金样例集（§6.2）结构断言 100% 通过；③ 中文/空格/emoji 路径用例通过；④ 10MB 样例 < 15s |
| **M2 Web UI MVP** | web-host（Fastify 桥接 core + 静态托管）+ 渲染层：拖拽/选择 → 队列 → 进度/结果 → 打开；P0 选项面板；设置持久化（web-host 落盘 JSON，Electron 阶段换 electron-store，格式一致）；错误人话化与日志导出 | 2.5 | 浏览器中 US1/US4/US5/US6 验收通过；Playwright Web 冒烟（选文件→转换→结果出现）通过 |
| **M3 模板与元数据** | 模板导入/选择/校验（zip 合法性 + 必需样式存在性）；内置 reference-zh.docx 制作；YAML 元数据面板透传；最近文件列表 | 1.5 | US3 验收通过；无效模板被拒并给出缺哪些样式的提示 |
| **M4 Electron 包装与分发** | Electron 壳接入既有 renderer（HTTP 桥 → IPC，前端仅换传输层适配器）；electron-builder 双平台产物 + sidecar 打包校验（产物内 pandoc 可执行、GPL 声明文件在位）；全新虚拟机冒烟清单 | 2 | 三平台安装包在干净系统安装→转换→卸载全流程通过；Gatekeeper/SmartScreen 解除指引写入 README |
| **M5 发布 v0.1.0** | 文档（README/使用手册/FAQ）、tag + GitHub Release（CI 自动附三平台产物）、pandoc 许可证与源码链接随包 | 1 | Release 资产齐全；按 §5 全量回归通过后打 tag |
| **M6 批量转换（已上移实施，2026-10-04）** | 文件夹递归扫描（排除隐藏/非 .md）；批量结果列表与重试 | 1 | US2 验收通过；单文件失败不中断队列 |

> MCP 轨道（并行，见另文）：M1 冻结 core 接口后即可实施，+1 人日，不占关键路径。

### 签名策略（分两阶段，避免阻塞首发）

- 阶段一（v0.1.0 起）：不购买证书。macOS 提供一行解除指引（`xattr -cr /Applications/md2word.app` 或右键打开）；Windows 说明 SmartScreen"仍要运行"路径。
- 阶段二（可选）：Apple Developer ID（$99/年）+ 公证，Windows 证书——走 electron-builder 现成配置，预算 0.5 人日 + 年费。

---

## 4. 关键实现决策（踩坑预防，均来自调研实证）

1. **spawn 一律参数数组**（禁 `shell:true`）：规避 Windows 引号/空格转义与编码问题；pandoc 对 UTF-8 路径原生支持（npm markdown-docx 的中文路径 bug 是其自身实现问题，非 pandoc）。
2. **text 来源走临时文件**：pandoc 二进制格式输出必须落盘，不依赖 stdin 管道（pandoc 输出二进制时 stdout 行为有坑）。
3. **图片预处理**：转换前把相对路径解析为绝对路径；远程图片默认允许 pandoc 抓取（docx 内联），设置项"离线模式"开启时跳过远程图并计入 warnings（不静默失败）。
4. **代码块高亮缺失检测**：无语言标注的 fenced block 在 pandoc 下无高亮——校验阶段统计 `plainCodeBlocks` 并生成 warning 提示用户补语言。
5. **TOC 域提示**：启用 TOC 的转换结果在 UI 与 warning 中固定提示"Word 中需更新域（Ctrl/Cmd+A → F9）显示页码"——pandoc 生成的是域指令而非静态目录，属预期行为。
6. **公式**：默认开启 pandoc 原生 TeX→OMML（可编辑公式），无额外参数；`--math-method` 保持默认。
7. **版本锁定**：pandoc 二进制 + SHA-256 记录在 `packages/core/assets/pandoc.lock.json`；升级 = 替换二进制 + 跑黄金样例集 diff + 独立 PR。

---

## 5. 测试策略

### 5.1 测试分层与门禁

| 层 | 工具 | 范围 | 门禁 |
|---|---|---|---|
| 单元 | Vitest | flag 映射快照、路径处理、stderr 分类、队列、模板校验 | 覆盖率 core ≥ 85% |
| 集成 | Vitest + 真实 pandoc | 黄金样例集全量转换 + XML 断言 + round-trip | 100% 通过（CI 三平台） |
| E2E | Playwright `_electron` | 拖拽（DataTransfer 模拟）、批量流程、错误展示、设置持久化 | P0 用户故事路径全覆盖 |
| 互操作 | 人工清单 | Word(macOS/Windows)、WPS、LibreOffice、Pages(导入) 打开渲染 | M4 前 each 一次，留存截图 |
| 性能 | 基准脚本 | 1KB/100KB/1MB/10MB 四档计时与内存 | 相对基线回归阈值 2× |
| 安装冒烟 | 干净虚拟机 | 安装→转换→卸载；缺网络环境启动 | M4 清单全过 |

### 5.2 黄金样例集（samples/，M1 起随用随增）

`basic-zh.md`（调研实测样例直接复用：标题/行内/列表/任务列表/表格/代码/引用/脚注/公式/图片）、`tables-complex.md`、`math-heavy.md`、`images-local.md`、`images-remote.md`、`code-lang-missing.md`、`yaml-metadata.md`、`no-heading.md`、`empty.md`、`large-1mb.md`、`large-10mb.md`（生成器产出）、`cjk-path 目录/中文 文件名.md`。每个样例配 `expected.json`（元素断言：`<w:tbl>`/`<m:oMath>`/`<w:drawing>`/脚注/`instrText TOC`/命名样式命中数）。

### 5.3 错误分类表（stderr → 人话）

| 模式 | 错误码 | UI 文案示例 |
|---|---|---|
| Could not fetch resource | W_IMAGE_FETCH | "图片 X 下载失败，已保留占位（可开启离线模式跳过）" |
| Could not convert TeX math | W_MATH | "第 N 个公式解析失败，已按原文输出" |
| 退出码非 0 + 模板相关 | E_TEMPLATE_INVALID | "模板缺少必需样式：Source Code（请基于默认模板修改）" |
| 退出码非 0（其他） | E_PANDOC_FAILED | "转换失败（pandoc 原因摘要 + 查看完整日志）" |
| 超时 | E_TIMEOUT | "转换超过 60s 已终止（文件过大或图片过多）" |
| 输入问题 | E_SOURCE_NOT_FOUND / E_SOURCE_TOO_LARGE(>20MB) / E_OUTPUT_EXISTS | 相应人话提示 |

---

## 6. 部署与发布流程

1. **分支模型**：`main`（保护，CI 全绿方可合并）+ 短命 feature 分支；发版 = 打 `v*` tag。
2. **CI**（ci.yml）：三平台矩阵跑 lint + typecheck + 单元 + 集成（真实 pandoc，runner 上 `gh release download` 或缓存二进制）+ E2E（仅 macOS/Windows 各一档）。额度经济性（2026-10-06）：文档类改动（根目录 `*.md` / `docs/**`）不触发；同分支新推送自动取消在跑的 run（concurrency，release.yml 同）。
3. **Release**（release.yml）：tag 触发 → electron-builder 产出 `md2word-<版本>-arm64.dmg`、`md2word-<版本>-x64.dmg`、`md2word.Setup.<版本>.exe`（GitHub 资产名将空格转为点）→ 附到 GitHub Release（含 SHA-256 清单与变更日志）。
4. **更新**：各版本均手动下载安装（首版 v0.1.0，见 §8 决策 #6）；P2 接入 electron-updater + GitHub Releases 通道。
5. **回滚**：Release 历史全保留；pandoc 升级独立于应用版本，出问题按 §4.7 流程回退二进制。

## 7. 风险清单

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| 未签名包被 Gatekeeper/SmartScreen 拦截 | 高/中 | §3 两阶段签名策略 + 解除指引写入首次使用文档 |
| pandoc 升级引入输出回归 | 中/高 | 版本锁定 + 黄金样例 diff 门禁 |
| 中文/特殊字符路径（尤 Windows） | 中/高 | 参数数组 spawn + 专项样例进 CI |
| 捆绑体积超预期（183MB 实测） | 已量化/低 | 已确认接受（开箱即用优先） |
| Electron 依赖 CVE | 低/中 | 启动日锁定版本，季度升级一次；个人场景风险面小 |
| 复杂表格（合并单元格）转换不完美 | 确定/低 | GFM 语法本身不支持，FAQ 声明边界，不列为缺陷 |

---

## 8. 决策记录（2026-09-29 评审确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 应用壳 | 最终形态 Electron；开发采用 **Web 先行**路径——renderer 为纯网页，M2 先交付功能完整的网页版（Fastify 本地桥接 core），M4 再用 Electron 包装，UI 代码零改动 |
| 2 | 体积策略 | **捆绑 pandoc 开箱即用**，接受安装包约 140MB；轻量版/首启下载方案否决，不实施 |
| 3 | 批量转换 | 确认延后至 v1.1（M6，P1），**需求保留在路线图，不得删除** |
| 4 | 仓库 | `/Users/gaomeng/vibe-coding/zcode/01_code/md2word`；本计划、《MCP设计方案》《调研报告》与种子样例已移交仓库（`docs/`、`samples/`） |
| 5 | M6 上移（2026-10-04） | 经用户指令，M6 批量转换从 v1.1 上移至当前里程碑实施（M4 三平台安装包已产出、macOS 冒烟通过后启动）；范围仍按本表 M6 行：文件夹递归扫描（排除隐藏/非 .md 与 node_modules）+ 批量结果列表与重试，DoD 不变 |
| 6 | 发布版本号（2026-10-05） | 经用户确认：GitHub 发布自 **v0.1.0** 起（与包内 package.json 全线 0.1.0 一致），便于后续小功能/页面优化走 0.x 迭代；**v1.0 留待功能完整后发布**（届时提醒用户） |

后续开发任务自 md2word 工作区下发；建议首个任务 = M0 + M1。
