# md2word — 项目协作上下文（AI 助手必读）

个人跨平台（macOS/Windows）Markdown→Word 桌面工具。架构为方案 A：**pandoc 3.12.x sidecar 子进程**（GPL-2.0+，捆绑分发必须随包附 GPL 许可证文本与源码链接 github.com/jgm/pandoc；定制只走命令行参数 / reference.docx / Lua 过滤器，不改 pandoc 本体）。

## 文档索引（docs/，本仓库内）

- `md2word开发计划方案.md` —— **唯一开发依据（v1.0 已确认）**：需求分级、架构、M0–M6 里程碑与 DoD、测试策略、发布流程
- `md2word-MCP设计方案.md` —— Agent 工具封装设计；实施排在主计划 M1（core 冻结）之后
- `Markdown转Word工具调研报告.md` —— 选型证据与实测数据（pandoc 3.12 二进制解包 183MB；黄金样例 + OOXML 结构断言的测试方法出自此报告）

## 已确认决策（2026-09-29 评审，详见计划 §8）

1. **Web 先行**：renderer 为纯网页；M2 先交付功能完整的网页版（packages/web-host，Fastify 桥接 core），M4 再用 Electron 包装，UI 代码零改动（HTTP 桥 → IPC 仅换传输层适配器）。
2. **捆绑 pandoc 开箱即用**：接受安装包约 140MB；轻量版/首启下载方案已否决，不要再提。
3. **批量转换延后至 v1.1（M6，P1）**：需求保留在路线图，不得删除。
4. **packages/core 为纯 TS 库（不 import Electron）**：desktop / web-host / mcp-server 均只是宿主。

## 协作约定

- 开发任务以用户在 md2word 工作区下发的指令为准；里程碑 DoD 全部通过才算完成。
- 范围变更（新增功能、延后项上移、里程碑调整）须先更新 `docs/` 计划文档并征得用户确认，再动工。
- pandoc 版本锁定于 `packages/core/assets/pandoc.lock.json`（含 SHA-256）；升级须跑黄金样例集 diff 并走独立 PR。
- 测试基线：`samples/` 黄金样例集 + `document.xml` 元素断言（`<w:tbl>`/`<m:oMath>`/`<w:drawing>`/脚注/`instrText TOC`/命名样式）。
- 中文/空格/emoji 路径为一等公民：spawn 一律参数数组（禁 `shell:true`），专项用例进 CI。
- 当前仓库尚未 `git init`（截至 2026-10-01）；首次提交前先初始化并建 `main` 保护约定。
