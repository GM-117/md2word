# UI 体验优化（第二批）回归报告

> 执行日期：2026-10-03。背景：用户完成 M4 人工冒烟（M1–M11 全过）后，针对新界面提出 4 项进一步优化（含 1 项功能一致性缺陷）。
> 关联：[UI体验优化回归报告.md](UI体验优化回归报告.md)（第一批）、[M4-冒烟清单.md](M4-冒烟清单.md)。

## 1. 反馈与处理对照

| # | 用户反馈 | 分析与处理 | 结果 |
|---|---|---|---|
| 1a | "高亮风格"作用范围不明确 | **它仅作用于标注了语言的围栏代码块**（pandoc `--highlight-style`，决定代码块的语法高亮配色方案）；行内代码、正文、标题均不受影响。已在选项下方加提示文案明确此范围 | ✅ |
| 1b | 高亮风格样式与其他选项不一致，像无父级的子选项，层级不清晰 | 取消 `indent` 缩进，升为与其他转换选项同级的顶层行；标签改为**"代码块高亮风格"**直接点明作用对象；下加作用范围提示 | ✅ |
| 2a | "导入 reference.docx 模板"按钮突兀 | 降调为**次级轻量样式**（虚线边框、灰字、小尺寸），hover 才显示主题色；与概览卡的视觉权重分离 | ✅ |
| 2b | "需保留 12 项必需样式"未列明 | 面板内新增可折叠清单**列出全部 12 项样式名与用途**（Source Code/Verbatim Char/Block Text/Footnote Text/Hyperlink/Table/Heading 1/First Paragraph/Body Text/Compact/Image Caption/Table Caption），并附操作指引（Word 样式窗格核对 / 基于内置模板修改）；清单与 core `REQUIRED_STYLES`（M1 冻结）保持一致 | ✅ |
| 3 | 最近文件需"一键清空" + 防误操作 | 最近文件条右侧新增**「清空」按钮**：悬停变红色（危险标识），点击弹**原生确认框**（"确定清空全部 N 条记录？（仅清除记录，不影响已转换的文件）"），确认后即时持久化、刷新/重启仍为空 | ✅ |
| 4 | **网页版与桌面版行为不一致**：网页"打开/打开所在文件夹"指向 md 源文件目录，桌面版正确指向 docx | **确认为 web-host 真缺陷（D30）**：打开路由把上传名拼到作业目录，指向的是 staged 的 `.md` 副本（且 macOS file 模式误用 `open -R` 定位文件而非打开）。修复：`JobManager.findOutputPath(jobId, name)` 按上传名解析**产物 docx 路径**；"打开"= 系统默认程序打开 docx，"打开所在文件夹"= **在文件管理器中定位该 docx**（mac `open -R` / Win `explorer /select,`）；Windows 下 explorer 返回码 1 误判失败一并修正。修复后两形态行为一致 | ✅ |

**网页/桌面同步说明**：①②③ 均在共享的 renderer 层实现，两形态天然一致；④ 属 web-host 路由修复（桌面版此前已正确）。

## 2. 实现 touched

| 文件 | 内容 |
|---|---|
| `packages/web-host/src/lib/jobs.ts` | `findOutputPath()`；`openPath` 语义重构（file=打开 / reveal=定位）；Windows explorer 退出码兼容 |
| `packages/web-host/src/server.ts` | `/api/open` 路由改为解析产物路径；404 人话错误（"未找到该文件的转换产物"） |
| `packages/renderer/src/App.tsx` | ①②③ UI；12 项样式清单（与 core REQUIRED_STYLES 注释锚定）；`clearRecent`（confirm 确认） |
| `packages/renderer/src/styles.css` | `.tpl-import`（降调）、`.tpl-styles`（折叠清单）、`.recent-clear`（危险悬停） |
| 测试 | web-smoke +1（清空）、desktop e2e U5（清空+持久化）、U2 选择器适配、web-host api.test 增 findOutputPath/404 断言 |
| 文档 | `使用手册.md`（选项表/打开行为/最近文件清空） |

## 3. 测试结果

| 套件 | 数量 | 结果 |
|---|---|---|
| vitest（core 62+29 / desktop 21+31 / web-host 18） | 161 | ✅ 全过（web-host 新增 D30 断言：findOutputPath 解析产物路径 + 未产生物 404 人话错误） |
| Web E2E（新增"一键清空并持久化"） | 11 | ✅ 全过 |
| 桌面 E2E（新增 U5 清空；U2 适配新标签） | 23 | ✅ 全过（含 U1–U5、T/R 系列、打包冒烟、截图） |
| lint / typecheck（4 包） | — | ✅ 0 错误 |
| verify-dist（mac .app + win-unpacked，重建后复验） | 20 | ✅ 10/10 ×2 |

**用例总账：195 例（vitest 161 + E2E 34）+ 打包校验 20 项，0 失败。**

## 4. 缺陷记录

| # | 级别 | 处理 |
|---|---|---|
| D30（真实缺陷 · 中 · 已修复） | web-host 打开行为：`/api/open` 打开的是 staged 的 `.md`（macOS 下 `open -R` 表现为"跳到源文件目录"），与桌面版不一致 | 路由改按上传名解析产物 docx；`openPath` 语义重构为 file（打开）/ reveal（定位）；explorer 退出码兼容。网页版与桌面版行为现已一致（均打开/定位 .docx） |

## 5. 遗留与移交

- 三平台安装包已用本轮代码**重建并复验**（含全部优化 + D30 修复）：`release/md2word-0.1.0-arm64.dmg / -x64.dmg / Setup 0.1.0.exe`——Windows 虚拟机冒烟请使用此版 exe。
- M4 人工冒烟：macOS M1–M11 ✅（用户 2026-10-03）；Windows W1–W7 待执行 → 全过后 M4 计 DoD 完成。
