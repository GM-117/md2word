# Markdown → Word(.docx) 转换工具调研报告

> 调研日期：2026-09-29
> 调研方法：三路并行检索（GitHub API 深度检索 / 官方文档与商业服务官网 / Stack Overflow 与中文技术社区），并**在本地实测**了两个代表性工具（pandoc 3.12、npm markdown-docx 1.7.0），对输出 docx 解包 OOXML 逐元素验证。
> 数据可信度说明：除标注【未验证】外，星标数、版本、许可证、下载量等均为调研当日通过 GitHub API / npm / PyPI registry / 官方文档直接核实的数据；本地实测部分均有 XML 级证据。

---

## 一、执行摘要

1. **现有工具完全能满足 Markdown→Word 转换需求，不存在"必须从零自制"的情形。** 该领域已高度成熟：pandoc 是事实标准（46,445 星、当天仍在发版），JS/Python 生态各有可直接嵌入的生产级库。
2. **质量天花板 = pandoc**：唯一原生支持「LaTeX 公式 → Word 可编辑公式（OMML）」「词法级代码高亮」「reference.docx 样式模板」「TOC 域」的方案，且 GPL 许可允许以独立进程方式调用而不传染。
3. **纯库方案（许可证干净、易部署）**：Node 首选 `markdown-docx`（vace/markdown-docx，MIT）或插件化更强的 `mdast2docx`；Python 侧无同等成熟度的一站式库，通常 `markdown-it-py/mistune + python-docx` 自行映射。
4. **自制建议**：不要手写 OOXML 映射层（公式、TOC 域、表格样式、CJK 字体四座大山，重复造轮子且质量必然低于 pandoc）；正确姿势是「**pandoc 子进程（质量优先）或现有库封装（部署优先）**」做一层薄封装，投入 0.5～5 天即可得到生产可用能力；只有当需求是"浏览器端零上传转换"或"深度定制样式引擎"时，才值得做真正的自研（1～2 个月量级）。
5. **两个容易踩的坑，已在实测中证实**：① 中文文件路径会使 `markdown-docx` 的 CLI 报错（其 issue #29），以字符串入参 + buffer 出参可绕过；② `--toc` 生成的目录是 Word 域，打开后需手动"更新域"才显示页码——这是所有工具的共性，不是缺陷。

---

## 二、现有工具系统性评估

工具分四类：**转换引擎（CLI）**、**编程库（嵌入用）**、**编辑器/插件（人用）**、**在线服务（零安装）**。

### 2.1 转换引擎类

#### Pandoc（jgm/pandoc）— 事实标准，推荐首选

| 维度 | 评估 |
|---|---|
| 活跃度 | 46,445 星 / 5,207 fork / Haskell；最新版 **3.12（2026-09-29，即调研当日发布）**，月度级发版节奏 |
| 许可证 | **GPL-2.0-or-later**（唯一主要约束，见 §4.2 的边界分析） |
| 语法覆盖 | GFM 全集 + 脚注 + 表格 + 数学公式 + YAML 元数据 + 引文；覆盖面为所有方案之最 |
| 转换质量 | 自有 AST → 原生 OOXML writer。公式经 texmath 库输出**可编辑的 Word 原生公式**；代码高亮由内置 skylighting 引擎按 token 着色；样式映射到命名 Word 样式（Heading 1–9、Source Code、Block Text、Verbatim Char、Caption 等） |
| 定制能力 | `--reference-doc` 样式模板（内容被忽略、只继承样式表与页面设置）；`--highlight-style`；`--toc`、`--number-sections`；**Lua 过滤器**在 AST 层任意改写（pandoc 内置 Lua 5.4，实测开销仅 +2%） |
| 性能 | 本地实测：1.2KB 中文混排样例 **0.082 秒** 出 docx。3.12 是官方性能专项版（HTML reader 提速 33%、图片密集文档提速、Org 表格 O(n²)→O(n)） |
| 已知短板 | 复杂表格（合并单元格）不支持（文档模型所限，官方明言有损）；TOC 域需在 Word 中手动更新；社区无第三方质量基准 |

**实测证据**（pandoc 3.12，macOS arm64 官方二进制）：
- `<w:tbl>` 表格 ×1、`<m:oMath>` 原生公式 ×2（行内+独立）、`<w:drawing>` 图片 ×1、脚注正文存于 `word/footnotes.xml` ✓
- TOC 域指令 `TOC \o "1-2" \h \z \u` 存在 ✓
- 段落级命名样式：Heading1/Heading2、SourceCode、BlockText（引用）、FirstParagraph、Compact（列表）、CaptionedFigure、ImageCaption、TOCHeading 全部正确应用 ✓
- 代码高亮为**词法级**：`def` → `KeywordTok`（样式定义 `w:b` + `w:color w:val="007020"`）、`str` → `BuiltInTok`、`->` → `OperatorTok`，Word 中显示彩色 ✓
- `styles.xml` 含 `eastAsia="zh-CN"` 语言标记 ✓

#### 其他引擎

| 工具 | 说明 | 许可证 | 评估 |
|---|---|---|---|
| Quarto / R Markdown | 均走 pandoc docx writer；Quarto 自带捆绑 pandoc（约 3.6.3，滞后上游【未验证】） | GPL 系 | 学术出版场景好，作为通用引擎无额外优势 |
| markdown-exporter（bowenliang123，PyPI `md-exporter`） | 270 星 / Apache-2.0 / 2026-08 仍活跃；pandoc 封装 + 自带 DOCX 模板，打包为 CLI 和 Agent Skill | Apache-2.0 | 适合 AI Agent/自动化流水线直接采用 |
| nokonoko1203/md2docx（Rust） | 87 星，日文文档场景，自动编号做得细 | **无许可证** | 无许可证 = 法律上不可采用 |
| wangqiqi/md2docx（Python） | 50 星 / MIT / 2026-09 活跃，论文场景，中文文档 | MIT | 小众可用 |

### 2.2 编程库类（嵌入到产品中用）

#### ① markdown-docx（npm，vace/markdown-docx）— Node 首选一站式

> 勘误：检索中发现常被引用的 `dream2023/markdown-docx` **实际不存在**（GitHub API 返回 404）；npm 包 `markdown-docx`（v1.7.0，作者 Vace）的真实仓库是 **vace/markdown-docx**。

| 维度 | 评估 |
|---|---|
| 活跃度 | 372 星 / MIT / 最近推送 2026-06-29 / 仅 5 个开放 issue；npm 周下载约 2.9 万；在线演示 md-docx.vace.me |
| 架构 | marked 解析（GFM 默认开启）→ dolanmiu/docx 生成；Node 与浏览器同构，可完全离线 |
| 覆盖 | 标题/段落/强调/列表/任务列表/表格/链接/图片（可自动下载远程图、`![alt](src "600x400")` 指定尺寸）/引用/代码块/脚注/行内 HTML；**数学公式走 KaTeX → MathML → OMML**，带 LibreOffice 兼容开关；主题 API 可定制各级标题颜色字号、页边距等 |
| 实测证据 | 表格 ✓、`<m:oMath>` ×2 ✓、脚注引用 ✓、任务列表/删除线/中文内容 ✓、标题样式带 `outlineLvl`（Word 导航窗格可用）✓；**相对路径图片在"传字符串"用法下未嵌入**（`<w:drawing>` ×0，警告对象指向 `test_img.png`；用 CLI/传文件路径可规避）|
| 短板 | 无 TOC 域、无 reference.docx 式模板（只有主题对象）、代码块无 token 级高亮（官网亦未宣称）；**issue #29：CLI 转换中文路径文件报错**；issue #30：有序列表含公式块渲染异常 |

#### ② mdast2docx（npm，@m2d/*，md2docx org）— 插件化架构，最新代码

40 星 / **MPL-2.0** / 最近推送 2026-09-28（非常活跃）。unified/remark 的 MDAST → docx.js，模块化：`@m2d/core` + 按需插件（`@m2d/image`、`@m2d/table`、math 等），Node/浏览器同构，定位"AI 生成内容 → DOCX"。社区小但架构最干净，**适合需要深度定制转换规则的团队**。

#### ③ html-to-docx（npm，privateOmega）— HTML 中间路线

486 星 / MIT / 最近推送 2025-04（放缓），106 个开放 issue。生成原生 OOXML（明确不用 altChunk），输出兼容 Word 2007+/LibreOffice/WPS/Google Docs；支持页眉页脚页码、分页、列表样式。短板：仅 Node、需自备 HTML 渲染层（marked/rehype），issue #130 在处理 markdown 渲染产物时崩溃、#41 图片渲染问题、README 自述"not a complete solution"。**结论：能用，但不如直连方案可靠。**

#### ④ html-docx-js — 不推荐（反面教材）

1,155 星但 2021 年起停更。采用 **MHT altChunk** 技巧：把 HTML 塞进 docx，靠 Word 打开时自行转换。自身 README 承认 **LibreOffice / Google Docs 打不开**、仅支持 base64 图片。只在"保证 Word 桌面版打开"的场景可用。

#### ⑤ 积木层（用于自研映射）

| 库 | 版本/活跃度 | 许可证 | 关键能力与缺口 |
|---|---|---|---|
| dolanmiu/docx（npm） | 9.8.1（2026-09-28 发版），5,920 星，周下载约 669 万 | MIT | 声明式 API；**内置 `TableOfContents`（含 `updateFields` 打开提示刷新）和 `latexToMath`（LaTeX→OMML）**、页眉页脚、脚注、图表。自研 JS 映射层的最佳目标 |
| python-docx | 1.2.0（2025-06），5,729 星 | MIT | 段落/样式/表格（含合并单元格）/图片/页眉页脚/超链接；**无 TOC API（issue #36 挂了 12 年）、无公式 API、`run.font.name` 不设中文字体（issue #346，需手工 `w:rFonts w:eastAsia`）**——三座大山都要手写 XML |
| flexmark-java | 2,641 星 / BSD-2 / 2025-04 | BSD-2 | Java 唯一较完整的 MD→DOCX 模块 |
| DocSharp（.NET） | 68 星 / MIT / 2026-08 活跃 | MIT | Markdig 自定义 renderer 直出 DOCX，.NET 首选 |
| docx4j / Apache POI / Open XML SDK | Java / Java / .NET | Apache-2 / Apache-2 / MIT | 底层 OOXML 操作；POI XWPF 官方自述"moderately functional"（冻结开发） |

#### ⑥ Markdown 解析层（自研时选择）

| 解析器 | 生态 | 许可证 | 特点 |
|---|---|---|---|
| markdown-it（JS） | 周下载约 3,200 万 | MIT | token 流（非真 AST），渲染器可按 token 类型替换——官方文档明确支持输出 HTML 以外格式 |
| marked（JS） | 37,200 星 | MIT | markdown-docx 所用；lexer 产 token 树 |
| remark/unified（JS） | 150+ 插件 | MIT | **真 JSON AST（mdast）**，`remark-gfm` 一个插件补齐表格/删除线/任务列表/脚注/自动链接，遍历最舒服 |
| markdown-it-py（Python） | 4.2.0（2026-05） | MIT | JS 版忠实移植，配 `mdit-py-plugins` |
| mistune 3.x（Python） | 3.3.4 | BSD-3 | 零依赖；内置 table/strikethrough/footnotes/**math**/task_lists/ruby（东亚注音）插件，自研 Python 转换器的推荐解析层 |
| Python-Markdown | 3.11 | BSD-3 | 维护模式（不再加新扩展），无删除线/任务列表内置 |

### 2.3 编辑器 / 插件类（人用，非集成）

| 工具 | 价格 | 依赖 | 说明 |
|---|---|---|---|
| Typora | $14.99 一次性（3 台） | **DOCX 导出必须本机装 pandoc**（官方支持页明确） | 本质是 pandoc 图形前端；中文社区评价"最稳组合" |
| Writage | Personal $29+VAT 一次性 | Word 加载项 | 在 Word 内直接读写 .md，双向转换，本地不上云，宣传支持公式与 AI 粘贴保留格式 |
| Obsidian | 免费 | obsidian-pandoc 插件（907 星，2024-05 后停更但可用）或 obsidian-enhancing-export | 需自装 pandoc |
| VS Code | 免费 | vscode-pandoc（195,213 安装，2026-09 更新）、Markdown Preview Enhanced（1,036 万安装，内置 pandoc 导出）、Markdown Docx（34,936 安装） | 生态主流是 pandoc 前端；纯 JS 直转插件规模小 |

### 2.4 在线服务类（零安装，注意隐私）

| 服务 | 文件去向 | 免费额度 | API | 备注 |
|---|---|---|---|---|
| CloudConvert | 上传服务器 | 10 credits/天，单文件 1GB | 有（按 credit 计费） | 通用转换商 |
| Aspose Words | 上传，24h 删除 | 10MB/次、10 个/次 | Aspose.Words Cloud：**免费 150 次/月**，后 $30/月起 | 网页版称保留标题/表格/链接；本地 SDK 约 $1,199–$5,999【未验证】 |
| GroupDocs | 上传，24h 删除 | 3 个文件/天 | 有（Cloud REST） | Aspose 同源 |
| Convertio | 上传（称即转即删、24h 自动删） | 100MB | 付费 | 300+ 格式 |
| 专用小站（firsto MD2Word、md-to.com、convertpk 等） | 部分宣称"纯浏览器本地"【宣称未实测，可断网验证】 | 免费 | 无 | 宣传支持 GFM/LaTeX/Mermaid，质量参差 |

**结论**：在线服务仅适合非敏感、低频、小文件场景；生产集成应走本地库/引擎。

### 2.5 综合对比总表

| 工具 | 类型 | 语法覆盖 | 公式 | TOC | 代码高亮 | 样式定制 | 中文支持 | 许可证 | 活跃度 | 集成难度 |
|---|---|---|---|---|---|---|---|---|---|---|
| **pandoc 3.12** | CLI 引擎 | ★★★★★ | 原生 OMML ✓ | ✓（域） | token 级 ✓ | reference.docx + Lua | ✓（模板设 eastAsia 字体） | **GPL-2.0+** | 极高 | 低（子进程） |
| markdown-docx (npm) | JS 库 | ★★★★ | KaTeX→OMML ✓ | ✗ | ✗（仅块级样式） | 主题 API | ⚠ CLI 中文路径 bug | MIT | 中 | 极低 |
| mdast2docx (npm) | JS 库 | ★★★★（插件） | 插件 ✓ | 插件 | 插件 | docx.js 全量 | ✓ | MPL-2.0 | 高 | 低-中 |
| html-to-docx (npm) | JS 库（HTML 中转） | ★★★（取决于 HTML 层） | ✗ | ✗ | 取决于 HTML | CSS 有限映射 | ✓ | MIT | 中（放缓） | 中 |
| markdown-it-py + python-docx | Python 自组 | 取决于自研映射 | 手工（latex2mathml+XSLT） | 手工 XML 注入 | 手工（Pygments→run） | python-docx styles | 需手工 eastAsia | MIT/BSD | 高 | 高 |
| dolanmiu/docx（积木） | JS 库 | —（纯生成） | `latexToMath` ✓ | ✓ | —（自接 highlight.js） | 全量 | ✓ | MIT | 极高 | — |
| DocSharp (.NET) | .NET 库 | ★★★ | 部分 | ? | ? | 有限 | ? | MIT | 中 | 低 |
| Typora / Writage / 插件 | 桌面应用 | 同 pandoc | ✓ | ✓ | ✓ | 模板 | ✓ | 商业 | — | 不适用 |
| 在线服务 | SaaS | 参差 | 参差 | ✗ | 参差 | ✗ | 参差 | 商业 | — | 极低（隐私风险） |

---

## 三、社区口碑与高频问题（按出现频率归纳）

**推荐共识**：Stack Overflow 与中文社区（CSDN/知乎/掘金/腾讯云开发者社区）**一边倒推荐 pandoc**——"由于 Pandoc 实在过于强大，有 Markdown 转 Word 需求的话也就不用特地考虑其他选择"（中文社区代表性评价）。编辑器与 AI 工作流本质都是 pandoc 前端。新趋势是「AI 生成内容（md+LaTeX+表格+代码）→ 可交付 DOCX」的工程化方案。

**高频坑（都会在集成时遇到，附对策）**：

1. **reference.docx 理解成本高**：模板"内容被忽略、只继承样式"——logo/页眉版式无法靠它继承（SO q/14249811，93 赞）。对策：`pandoc -o custom-reference.docx --print-default-data-file reference.docx` 导出默认模板后在 Word 里改样式；页眉页脚直接做进模板文档属性。注意旧 flag `--reference-docx` 已改名。
2. **表格是重灾区**：docx 表格边框样式难看且难改（SO q/17858598，36 赞）；合并单元格 GFM/pandoc 均不支持；列宽不自适应。对策：模板定义 "Table" 样式或 Lua 过滤器改 `tblPr`；合并单元格需求需换 OpenXML 后处理。
3. **代码块不标语言则高亮消失**（pandoc 与各库同理）。
4. **图片**：相对路径/图床链接在转换上下文中易丢（实测 markdown-docx 传字符串时即丢图）。对策：预处理为绝对路径或 base64；pandoc 用 `--extract-media`。
5. **中文字体**：英文模板直接用会导致中文回退字体难看，需在模板预设宋体/微软雅黑（`w:rFonts w:eastAsia`）。python-docx 需手工设置（issue #346）。
6. **公式**：pandoc 的 OMML 原生输出口碑最好（可编辑）；直接复制粘贴不经转换则公式必乱——这是"AI 内容转 Word 乱"的主因。
7. **TOC**：所有工具生成的都是 Word 域，**打开后需手动更新域**（或用 dolanmiu/docx 的 `updateFields: true` 让 Word 打开时提示刷新）。
8. **大文件性能**：无任何公开的 md→docx 第三方基准【未找到】；间接证据：remark 建议输入上限 ~500KB（防 AST 内存滥用），pandoc 3.12 专项优化说明此前大文档确有瓶颈。

---

## 四、自制工具可行性分析

### 4.1 总判断

**"从零实现 Markdown→OOXML 映射"不可取；"基于现有引擎/库做产品化封装"完全可行且成本低。** 判断依据：

- pandoc 一个项目维护了 15+ 年才做到目前的覆盖度与正确性（46k 星、月度发版、上千 open issue 仍在修边角）；npm `md2docx`（PyPI）这类 2016 年的个人项目 10 年前就停在 hobby 规模——这是该领域自研难度的历史注脚。
- 四大技术难点（§4.3）每一个都有成熟解法，但**没有一个是半天能写对的**，全部自研约等于重写一个 pandoc docx writer。
- 反过来，"调用 pandoc 子进程"或"npm install markdown-docx"在半天内即可上线，剩余工作量集中在**样式模板调优与验收测试**——这部分无论用哪个方案都省不掉。

### 4.2 法律边界：pandoc 的 GPL 怎么处理

FSF GPL FAQ 的通行解读（非法律意见）：

- **以独立进程 + 命令行参数/管道调用**：属于"mere aggregation / arm's length"，**你的代码不被传染 GPL**。代价是部署环境需要独立安装 pandoc（Typora 即采用此模式：不捆绑、要求用户自装）。
- **捆绑分发**（把 pandoc 二进制打进你的安装包，如 `pypandoc_binary` 的做法）：需要随分发履行 GPL 义务（提供 pandoc 的许可证文本与源码获取方式）；你的自有代码仍可保持原许可证。
- **静态链接其 Haskell 库**：整个组合被 GPL 传染。避免。

### 4.3 技术方案对比（三种主流架构）

| | 方案 A：pandoc 子进程 | 方案 B：Node 库直转 | 方案 C：Python 自组映射 |
|---|---|---|---|
| 技术栈 | 任意语言 + pandoc 二进制（pypandoc 1.17 可 `pip install pypandoc_binary` 直接带二进制） | markdown-docx 或 remark+@m2d/*（基于 dolanmiu/docx 9.8.1） | markdown-it-py 4.2 / mistune 3.3.4 + python-docx 1.2 |
| 转换质量 | ★★★★★（公式/高亮/TOC/模板全有） | ★★★★（缺 TOC 域、token 高亮） | ★★★（全靠自研映射） |
| 许可证 | pandoc GPL-2.0+（进程隔离可用）；自有代码任意 | MIT / MPL-2.0 干净 | MIT/BSD 干净 |
| 部署 | 需带 42MB 二进制或用户自装；无 Node/Python 依赖 | `npm install` 即用，可浏览器端 | pip 安装，轻 |
| 定制深度 | reference.docx 模板 + Lua 过滤器（不改源码即可改 AST 行为） | 主题 API / 插件（mdast2docx） | 无限（但要自己写） |
| MVP 工期 | **0.5–1 天**（封装 + 参数化） | **0.5–1 天**（库即用）+ 1–2 天主题调优 | **1.5–2 周**（表格/图片/高亮/样式映射全自写） |
| 完整工期（含模板与验收） | 2–5 天 | 1–2 周 | 4–8 周 |
| 适用 | 质量优先、服务端 | 许可证敏感、浏览器端、中等质量可接受 | 已有 Python 栈、需求简单可控 |

> 另有方案 D（HTML 中转：marked/markdown-it → html-to-docx）：灵活但多一层失真，html-to-docx 维护放缓、106 个开放 issue，仅当已有成熟 HTML 渲染管线时考虑。

### 4.4 核心功能模块规划（若走自研/深定制路线）

```
┌─ Markdown 解析层（remark/mdast 或 mistune AST；GFM 全集 + 数学 + 脚注）
├─ 转换核心（AST 遍历 → Word 元素映射）
│   ├─ 块级：标题(H1-H6→Heading 1-9)/段落/列表(含任务列表)/引用/HR/代码块/表格/图片
│   ├─ 行内：粗斜删/行内代码/链接/换行
│   └─ 扩展：脚注 / 公式(LaTeX→OMML) / YAML 元数据→文档属性 / TOC 域
├─ 样式引擎（Word 命名样式注册 + 主题/模板映射 + eastAsia 字体处理）
├─ 资源处理（图片下载/本地化、尺寸 DPI、base64 内联）
└─ 输出层（Buffer/流式写出、CLI、批量、进度回调）
```

### 4.5 技术难点与已知解法（均有开源实现佐证）

| 难点 | 已验证解法 | 成本 |
|---|---|---|
| LaTeX→OMML | pandoc/texmath 原生；docx npm `latexToMath`；markdown-docx 走 KaTeX→MathML→OMML（带 LibreOffice 兼容开关）；Python 走 latex2mathml + MML2OMML.XSL（**该 XSL 随 Office 发行，独立再分发权利存疑【未验证】**） | 高（自研）/ 零（用库） |
| 代码高亮 | pandoc `--highlight-style`（skylighting，KDE 语法定义）；Pygments tokens→着色 run（无现成轮子，手写 ~200 行）；highlight.js→docx npm | 中 |
| TOC 域 | OOXML `fldSimple/instrText TOC \o "1-3"` + `w:dirty="true"` 打开刷新；dolanmiu/docx 的 `TableOfContents` + `updateFields`；python-docx 需 OxmlElement 手工注入 | 低-中 |
| CJK 字体 | `w:rFonts w:eastAsia` 显式设置（run 或 style 级）；reference.docx 预设中文字体 | 低（但必踩） |
| 表格列宽/边框 | 模板 "Table" 样式 / 后处理 `tblPr`；合并单元格超出 GFM 能力，需原生 OOXML 层 | 中-高 |
| 图片尺寸 | pandoc `--dpi`（默认 96，图片自带 DPI 优先）；python-docx 按 72 DPI 兜底需显式传 width | 低 |

### 4.6 测试策略与质量保证

1. **黄金样例集**：构建覆盖全部语法的样例矩阵（本项目实测用的 8 节中文样例可直接复用，见附件 sample.md），含边界用例：空文档、深层嵌套列表、特殊字符/emoji、超长单词、10MB 级大文件。
2. **结构断言**：解包 docx 对 `document.xml` 做元素断言（`<w:tbl>`、`<m:oMath>`、`<w:drawing>`、脚注、TOC instrText、命名样式命中）——本次实测即采用此法，可完全自动化。
3. **渲染级回归**：docx → PDF/图片（LibreOffice headless）后做视觉快照对比，防"XML 对但看不见"的回归。
4. **互操作矩阵**：输出在 Word(Win/Mac)、WPS、LibreOffice、Word Online 至少四端打开验证——altChunk 类方案在这一步直接出局。
5. **性能基准**：自建 100KB/1MB/10MB 三档基准文档，记录耗时与内存（社区无现成基准，只能自建）。
6. **差分测试**：同一输入跑 pandoc 与自研实现，结构断言 diff 定位缺口。

### 4.7 工期与资源估算汇总

| 路线 | MVP | 生产可用（含模板+测试） | 人力 |
|---|---|---|---|
| A：pandoc 封装 | 0.5–1 天 | 2–5 天 | 1 人 |
| B：Node 库封装 | 0.5–1 天 | 1–2 周 | 1 人 |
| C：Python 自组 | 1.5–2 周 | 4–8 周 | 1 人 |
| D：全保真自研（含公式/TOC/样式引擎） | 1 个月 | 2–3 个月 | 1–2 人（**不推荐**） |

---

## 五、推荐方案与实施建议

### 5.1 分场景决策

- **个人/一次性使用** → 直接 `pandoc input.md -o output.docx --toc`（+ Achuan-2/pandoc_docx_template 现成中文模板，1,079 星）。零开发。
- **集成到产品（服务端转换 API）** → **方案 A（pandoc 子进程）为主推荐**：质量天花板、性能好、语言无关。以"外部依赖 + 用户自装或独立下载"方式规避 GPL 顾虑；若必须捆绑，履行 pandoc 许可证文本与源码提供的义务即可。
- **许可证强敏感（商业闭源分发、不愿碰 GPL）或需要浏览器端零上传** → **方案 B：Node + markdown-docx（或 mdast2docx 插件化）**；接受"无 TOC 域、无 token 级高亮"的两处降级，或用 dolanmiu/docx 的 `TableOfContents`/`latexToMath` 自补（+2~4 天）。
- **已有 Python 技术栈且需求轻** → pypandoc（二进制 wheel）先行；需求确实轻时 mistune+python-docx 自组亦可。
- **明确不要**：html-docx-js（altChunk，LibreOffice/Google Docs 打不开）、无许可证项目（nokonoko1203/md2docx）、2016 年代的 md2docx(PyPI)、以及任何"从零手写 OOXML"路线。
- **在线服务**：仅限非敏感小文件；Aspose.Words Cloud 的 150 次/月免费额度适合原型验证。

### 5.2 实施清单（以方案 A 为例）

1. 服务内封装 `pandoc -f markdown -t docx --reference-doc=brand.docx --toc --highlight-style=pygments`；二进制随 CI 产物独立分发（不入主包）。
2. 制作中文品牌模板：`pandoc -o reference.docx --print-default-data-file reference.docx` → Word 中改 Heading/正文/Source Code/Table 样式 + `w:eastAsia` 中文字体 + 页眉页脚 → 归档为版本化资产。
3. 预处理：图片路径绝对化/内联化；公式规范化为 `$$`/`$`（社区验证的最佳实践）。
4. 复杂需求挂 Lua 过滤器（如表格样式、自定义 div 映射），不改 pandoc 本体。
5. 按 §4.6 建黄金样例集 + XML 结构断言的回归测试；TOC 交互（打开更新域）写入用户文档。
6. 已知不可为项提前声明：合并单元格表格、Word 域页码即时计算（需 Word/Word Automation Services）。

---

## 六、主要参考来源

**官方/一手**：pandoc 手册与 Releases（pandoc.org/MANUAL.html、github.com/jgm/pandoc/releases）、pandoc COPYING.md、FSF GPL FAQ、python-docx 文档与 issues #36/#346/#723、dolanmiu/docx demos（table-of-contents.ts、latex.ts）、vace/markdown-docx README 与 issue #29/#30、Typora 官方支持页（Install-and-Use-Pandoc）、writage.com/pricing、CloudConvert/Aspose/GroupDocs 官方定价页、VS Code Marketplace Gallery API。

**社区**：Stack Overflow q/14249811（93 赞）、q/17858598（36 赞）、q/67588992；CSDN《Markdown 编辑器实战指南》(2026-09)、阿里云社区《Markdown 转 Word 工程化实践》、掘金、知乎相关专题。

**本地实测**：pandoc 3.12（macOS arm64 官方二进制，/tmp 沙箱）与 markdown-docx 1.7.0（npm，Node v22）对同一份中文全语法样例的转换输出解包验证；样例与产物保留于 `/tmp/md2word-test/`。

> 附：检索中发现 GitHub 上星标最高的 "markdown docx" 相关项目（microsoft/markitdown 18.7 万星、MinerU、docling 等）均为 **docx→markdown 反方向**工具，与本需求方向相反，已排除。
