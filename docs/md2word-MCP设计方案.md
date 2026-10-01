# md2word MCP 设计方案（Agent 工具封装）

> 版本：v0.9（待评审）｜日期：2026-09-29
> 前置：《Markdown转Word工具调研报告》（技术结论）、《md2word开发计划方案》（架构与 core 接口，本文引用其 §2.6）
> 状态：设计稿已随开发计划移交 md2word 仓库 `docs/`；实施排在主计划 M1（core 冻结）之后，启动需在 md2word 工作区下发任务

---

## 1. 适配性分析：该能力适合封装为 MCP 吗？

**结论：适合，且价值显著。** 逐条对照 MCP 工具的适配判据：

| 判据 | 分析 | 结论 |
|---|---|---|
| 能力原子性 | "md→docx" 输入输出清晰（文件/文本 → 文件路径 + 统计），一次调用一个明确结果 | ✓ |
| 可无人值守 | 纯本地子进程转换，无弹窗、无交互、确定性执行 | ✓ |
| Agent 价值密度 | "AI 写作 → 交付 Word" 是高频链路：写报告/总结/论文初稿后一句"转成 Word 交给我"即可闭环，无需用户手动操作 | ✓ 高 |
| 参数可枚举 | TOC/编号/高亮/模板均为有限枚举，适合 JSON Schema 约束，LLM 不易用错 | ✓ |
| 与宿主能力的关系 | ZCode 内置 documents:docx skill 可覆盖本机场景；但 **MCP 是跨 Agent 通用形态**——Claude Desktop、Cursor 等宿主没有该 skill，封装为 MCP 后一处开发、处处可用，且可分发给他人 | ✓ |
| 边际成本 | core 层（§2.6 接口）与桌面端共用，MCP server 仅是薄封装，约 1 人日 | ✓ 低 |

**不适合放进 MCP 的部分**（留在桌面 GUI）：模板可视化选择、拖拽交互、批量进度浏览——这些天然是人的交互，不是 Agent 的。

**形态决策**：stdio 传输的本地 MCP server（Node/TS + `@modelcontextprotocol/sdk`）。理由：stdio 是所有主流 Agent 宿主（ZCode、Claude Desktop、Cursor…）的通用底座，零端口暴露、零网络面；对比 HTTP/SSE 形态，个人场景无服务器常驻需求。

---

## 2. 组件总览

```
Agent(ZCode / Claude Desktop / Cursor …)
   │  MCP 协议（JSON-RPC over stdio）
   ▼
md2word-mcp（本设计，packages/mcp-server）
   ├─ tools: md2word_convert / md2word_read_docx / md2word_list_options
   ├─ 校验：参数 JSON Schema、目录白名单、大小/超时限制
   ├─ 复用 packages/core（pandoc spawn、预校验、原子写、stderr 分类）
   └─ 日志 → stderr（协议通道独占 stdout）
   ▼
pandoc sidecar（extraResources）或 PANDOC_PATH 指定的系统 pandoc
```

- Server 名：`md2word`；协议版本跟随 SDK（2025-06 当前主流）；Node ≥ 22。
- **stdout 只走 MCP 协议**，一切日志/进度走 stderr——stdio 形态最常见的集成事故点，实现时以 lint 规则禁止 `console.log`。
- 并发模型：内部串行队列（pandoc 单次 0.1s 级，无需并发，防 Agent 并发轰炸）。

---

## 3. 工具接口定义

### 3.1 `md2word_convert` —— Markdown → Word 转换（核心工具）

**描述**（供 LLM 选择工具时阅读）：将 Markdown 文件或文本转换为 .docx（pandoc 引擎，支持表格/代码高亮/可编辑公式/脚注）。返回输出路径、内容统计与警告。默认输出到源文件同目录、同名 `.docx`。

**输入 Schema**：

```jsonc
{
  "type": "object",
  "required": ["source"],
  "properties": {
    "source": {
      "oneOf": [
        { "type": "object", "required": ["kind", "path"],
          "properties": { "kind": { "const": "file" },
                          "path": { "type": "string", "description": "md 文件绝对路径" } } },
        { "type": "object", "required": ["kind", "content"],
          "properties": { "kind": { "const": "text" },
                          "content": { "type": "string", "description": "Markdown 全文" },
                          "title":   { "type": "string" } } }
      ]
    },
    "outputPath": { "type": "string", "description": "输出 .docx 绝对路径；须在白名单目录内；缺省 <源目录>/<同名>.docx" },
    "options": {
      "type": "object",
      "properties": {
        "toc":             { "type": "boolean", "default": false, "description": "插入目录域（Word 中需更新域显示页码）" },
        "tocDepth":        { "type": "integer", "minimum": 1, "maximum": 6, "default": 3 },
        "numberSections":  { "type": "boolean", "default": false, "description": "章节自动编号" },
        "highlightStyle":  { "type": "string", "enum": ["pygments","tango","espresso","zenburn","kate","monochrome"], "default": "pygments" },
        "referenceDocx":   { "type": "string", "description": "样式模板绝对路径；缺省用内置中文模板" },
        "title":           { "type": "string }, "author": { "type": "string" },
        "offlineImages":   { "type": "boolean", "default": false, "description": "true 时不抓取远程图片（留占位并入 warnings）" },
        "overwrite":       { "type": "boolean", "default": false }
      }
    },
    "includeContent": { "type": "boolean", "default": false,
      "description": "true 时结果附带 contentMarkdown（转换产物的可读文本），便于 Agent 自检" }
  }
}
```

**输出 Schema**：

```jsonc
{
  "success": true,
  "outputPath": "/abs/path/报告.docx",
  "fileSizeBytes": 13660,
  "durationMs": 82,
  "documentStats": { "headings": 9, "tables": 1, "images": 1, "math": 2,
                     "footnotes": 1, "codeBlocks": 1, "plainCodeBlocks": 0 },
  "warnings": [ { "code": "W_PLAIN_CODEBLOCK", "message": "1 个代码块未标注语言，Word 中无高亮" } ],
  "refreshHint": "已启用目录：在 Word 中全选后按 F9（Mac: Cmd+A → Fn+F9）更新域以显示页码",
  "contentMarkdown": "…（仅 includeContent=true 时返回；pandoc docx→gfm 反向提取，供 Agent 校对）"
}
```

**失败输出**：`{ "success": false, "error": { "code": "...", "message": "人话", "stderrTail": "≤500字符" } }`

**错误码表**（与桌面端共用 core 分类）：

| 码 | 触发 | Agent 处置建议 |
|---|---|---|
| E_SOURCE_NOT_FOUND | 文件不存在 | 核对路径 |
| E_SOURCE_TOO_LARGE | 输入 > 20MB | 拆分文档 |
| E_OUTPUT_FORBIDDEN | 输出路径不在白名单 | 改用白名单目录，勿重试同路径 |
| E_OUTPUT_EXISTS | 同名且 overwrite=false | 带 overwrite:true 重试或换名 |
| E_TEMPLATE_INVALID | 模板 zip 损坏或缺必需样式 | 换内置模板 |
| E_PANDOC_MISSING | sidecar 缺失且未配置 PANDOC_PATH | 报告用户安装/配置 |
| E_PANDOC_FAILED | pandoc 退出码非 0 | 读 message/stderrTail 修正输入（如公式语法） |
| E_TIMEOUT | 超 60s（可调） | 拆分或去掉大图 |

### 3.2 `md2word_read_docx` —— 文档内容输出（反向提取）

**描述**：读取 .docx 并输出可读内容（Markdown 或纯文本），用于转换后校验、内容摘要、或把已有 Word 文档喂给 Agent。

```jsonc
// 输入
{ "path": "string（白名单内 .docx 绝对路径）",
  "format": { "enum": ["markdown", "plain"], "default": "markdown" },
  "maxChars": { "type": "integer", "default": 20000, "description": "超出截断并标记 truncated" } }
// 输出
{ "content": "…", "truncated": false,
  "metadata": { "title": "…", "author": "…", "wordCount": 1234 } }
```

实现：`pandoc -f docx -t gfm`（markdown）/ `-t plain`（纯文本），同一 sidecar，无新依赖。

### 3.3 `md2word_list_options` —— 能力自描述（可选，P1）

无参数。返回：pandoc 版本、内置模板清单（路径 + 说明）、`highlightStyle` 枚举、白名单目录。供 Agent 在不确定参数时自发现（LLM 友好的"帮助页"）。

---

## 4. 安全与资源约束

| 项 | 规则 |
|---|---|
| 目录白名单 | 启动参数 `--allow-dir <dir>`（可多个，默认当前工作区）。**读写均限白名单内**；越界一律 E_OUTPUT_FORBIDDEN，杜绝 Agent 把文件写到任意位置 |
| 输入上限 | 20MB（超限 E_SOURCE_TOO_LARGE） |
| 超时 | 60s 默认，kill 进程树；防止大图递归抓取拖死会话 |
| 网络面 | 仅 pandoc 抓取远程图片一种出网行为；`offlineImages:true` 可完全离线。不执行任何文档内代码（docx 无执行面） |
| 原子性 | 临时文件 + rename，任何失败不产生半成品 |
| 隐私 | 无遥测；日志仅 stderr 本地输出 |

---

## 5. 标准调用流程（时序）

```
用户："把 samples/报告.md 转成 Word，带目录和章节编号"
  1 Agent 选择工具 md2word_convert，组参：
     { source:{kind:"file",path:"…/报告.md"},
       options:{ toc:true, tocDepth:3, numberSections:true } }
  2 MCP client（宿主）→ stdio JSON-RPC tools/call → md2word-mcp
  3 server：Schema 校验 → 白名单检查 → core 预处理（图片路径绝对化）
  4 core.spawn pandoc：--toc --toc-depth=3 --number-sections
      --highlight-style=pygments --reference-doc=assets/reference-zh.docx
  5 core.validate：zip 完整性 + document.xml 断言（w:tbl/m:oMath/…）+ 统计
  6 原子落盘 → 返回 { outputPath, documentStats, warnings, refreshHint }
  7（可选自检）Agent 再调 md2word_read_docx { path: outputPath, maxChars: 2000 }
     核对标题/结构 → 向用户汇报"已生成 …/报告.docx，含目录 9 节、1 表、2 公式；
     Word 中更新域后可见页码"
```

---

## 6. 集成指南

### 6.1 ZCode

**工作区级**（仅本项目自动连接，配置进版本库可共享）：`<repo>/.zcode/config.json`

```json
{
  "mcp": {
    "servers": {
      "md2word": {
        "command": "node",
        "args": ["/absolute/path/to/md2word/packages/mcp-server/dist/index.js",
                 "--allow-dir", "/Users/gaomeng/Documents"],
        "env": { "PANDOC_PATH": "" }
      }
    }
  }
}
```

**用户级**（所有工作区可用）：同一结构写入 `~/.zcode/cli/config.json` 的 `mcp.servers` 键（同名 server 用户级覆盖工作区级）。两处配置的服务器均被信任并在会话启动时自动连接；状态可在 **Settings → MCP** 查看。

- `PANDOC_PATH` 留空 = 使用随包 sidecar；填系统 pandoc 路径则优先使用。
- 开发期本地调试：`args` 指向 `tsx watch src/index.ts` 等价命令即可热更。

### 6.2 其他宿主（同一 server，零改动）

Claude Desktop（`claude_desktop_config.json`）：

```json
{ "mcpServers": { "md2word": {
    "command": "node",
    "args": ["/path/to/md2word/packages/mcp-server/dist/index.js", "--allow-dir", "/Users/me/Documents"] } } }
```

Cursor 等：均在各自 MCP 设置中以相同 `command/args/env` 声明 stdio server。

### 6.3 导入验收清单（全部通过 = "成功导入并标准化调用" 达成）

1. 宿主工具列表出现 `md2word_convert` / `md2word_read_docx`，描述可读；
2. `source.kind=text` 传一段含表格与公式的 md → 返回 outputPath，文件可被 Word 正常打开；
3. `source.kind=file` 传中文路径文件 → 成功；
4. `includeContent:true` → 返回的 contentMarkdown 与源文结构一致；
5. 输出到白名单外目录 → 返回 E_OUTPUT_FORBIDDEN（而非写入）；
6. 对话自然语言触发："把这份报告转成 Word" → Agent 自主选工具、正确组参、汇报结果；
7. stderr 日志不污染协议（tools 列表在日志开启时仍正常）。

---

## 7. 实施里程碑（挂接主计划）

| 项 | 内容 | 人日 | 依赖 |
|---|---|---|---|
| MCP-1 | SDK 接入 + stdio server 骨架 + `md2word_convert`（复用 core） | 0.5 | 主计划 M1（core 冻结） |
| MCP-2 | `md2word_read_docx` + 白名单/限额/错误码 + stderr 日志规范 | 0.25 | MCP-1 |
| MCP-3 | ZCode 实测验收（§6.3 清单）+ Claude Desktop 冒烟 + README 集成文档 | 0.25 | MCP-2 |

可与主计划 M2（GUI）并行；若评审选择"MCP 先行"，可在仅完成主计划 M0+M1 后先发布 MCP（1 人日内），桌面端随后。
