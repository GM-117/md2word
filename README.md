# md2word — Markdown 转 Word 桌面工具

个人跨平台（macOS / Windows）Markdown → Word 转换工具。pandoc 3.12 作为独立 sidecar 子进程
（GPL-2.0+，arm's length 调用，合规声明随包），本地转换、零上传。

## 安装与使用

### macOS

1. 下载 `md2word-<版本>-arm64.dmg`（Apple Silicon）或 `md2word-<版本>-x64.dmg`（Intel）；
2. 打开 dmg，把 **md2word** 拖入 Applications；
3. 首次启动若提示"无法验证开发者"（Gatekeeper 拦截），任选其一：
   - **右键点击** Applications 中的 md2word → 「打开」→ 再点「打开」；
   - 或终端执行 `xattr -cr /Applications/md2word.app` 后正常双击打开；
4. 把 `.md` 拖入窗口（或点击选择文件）→ 转换 → 产物 `.docx` 生成在**源文件同目录**。

### Windows

1. 下载 `md2word Setup <版本>.exe`，双击安装（可自定义安装目录）；
2. 首次启动若被 **SmartScreen** 拦截（"Windows 已保护你的电脑"）：
   点「更多信息」→「仍要运行」；
3. 使用方式同上：拖入 `.md` → 转换 → 打开或定位 `.docx`。

### 卸载

- **macOS**：把 Applications 中的 md2word 移到废纸篓；用户数据在
  `~/Library/Application Support/md2word/`，可一并删除。
- **Windows**：设置 → 应用 → md2word → 卸载（或控制面板卸载）；用户数据在
  `%APPDATA%/md2word/`，可一并删除。

### 改用系统自装的 pandoc（可选）

设置环境变量 `PANDOC_PATH` 指向自装 pandoc 可执行文件即可（默认使用应用内置的
pandoc 3.12，无需任何配置）。pandoc 源码：https://github.com/jgm/pandoc 。

## 功能

- Markdown → docx（表格 / 代码高亮 / 公式 OMML / 脚注 / 任务列表 / YAML 元数据）
- 转换选项：目录 TOC、章节编号、高亮风格、离线模式（跳过远程图）、覆盖同名输出
- 批量转换（M6）：选择文件夹递归转换全部 .md（含子目录，跳过隐藏文件与 node_modules），
  逐个给出成功/失败清单，失败项可单条或一键重试
- 文档模板：内置中文模板（宋体正文/黑体标题/Consolas 代码），支持导入自定义 reference.docx
  （12 项必需样式校验，缺样式拒绝并给出清单）
- 元数据面板：标题/作者写入 Word 文档属性
- 串行队列、失败不中断、警告人话化、日志导出、最近文件、设置持久化（重启恢复）
- 浏览器模式（可选）：`pnpm dev` 起 web-host + renderer，浏览器访问 http://localhost:5173

## 开发

```bash
pnpm install && pnpm setup   # 依赖 + 拉取 pandoc sidecar（SHA-256 校验）
pnpm dev                     # Web 先行路径（web-host 5175 + renderer 5173）
pnpm dev:desktop             # Electron 桌面开发（renderer dev server + Electron 窗口）
pnpm typecheck && pnpm lint && pnpm test   # 门禁
pnpm --filter @md2word/web-host e2e        # Web E2E
pnpm --filter @md2word/desktop e2e         # 桌面 E2E（Playwright _electron）
pnpm --filter @md2word/desktop dist        # 打安装包（产物在 packages/desktop/release/）
```

目录与架构见 [docs/md2word开发计划方案.md](docs/md2word开发计划方案.md)（唯一开发依据）；
进度总账见 [项目进展记录.md](项目进展记录.md)；逐项测试证据见 [docs/tests/](docs/tests/)。

## 许可证

md2word 自有代码 MIT。捆绑的 pandoc 3.12 为 GPL-2.0+，以独立子进程调用，
完整许可证文本与源码地址见应用包内 `THIRD-PARTY-LICENSES.md`。
