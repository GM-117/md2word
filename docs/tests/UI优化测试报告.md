# UI 全面优化测试报告（2026-10-02）

## 范围

用户反馈 Web 界面（http://localhost:5173）存在多处样式问题（红框标注：右栏队列空区、"高亮风格"下拉行、"文档模板"面板），要求整体 UI 达到专业级视觉标准。本次对 `packages/renderer` 做了全面视觉重构，**未改动任何业务逻辑与 API 契约**。

## 变更内容

| 文件 | 变更 |
| --- | --- |
| `packages/renderer/src/styles.css` | 全量重写：CSS 设计令牌（明/暗双主题）、自定义复选框/下拉/输入框/按钮、卡片与面板体系、空态设计、响应式断点（960px/560px）、细滚动条、focus-visible 焦点环、prefers-reduced-motion 适配 |
| `packages/renderer/src/App.tsx` | 结构重构：品牌 Logo + 连接状态点、面板标题图标、拖放区整域可点击（label 包裹）、队列空态插画 + 三步引导、结果行状态图标/统计徽章/警告与错误条、队列计数与"清空"按钮、页脚隐私说明 |

**E2E 选择器契约全部保留**（`h1`、`.topbar .sub`、`.dropzone input[type=file]`、`.opt`、`.panel`、`.row/.badge/.stats/.warn/.err`、`input[accept=".docx"]`、链接"下载 .docx"/"导出日志"），功能行为零变化。

## 验证结果

1. **typecheck**：`pnpm --filter @md2word/renderer typecheck` 通过。
2. **lint**：`pnpm lint`（eslint 全仓）通过。
3. **Playwright E2E**：`pnpm exec playwright test`（含 renderer 生产构建 tsc + vite build）**8/8 通过**，重构后复跑仍 8/8。
4. **视觉走查**（Playwright 截图，@2x fullPage，暗色/亮色/390px 窄屏共 9 张，覆盖空态/TOC 展开/成功结果/失败详情）：
   - 空态：插画 + 标题 + 描述 + 三步引导居中呈现，解决原右栏大片空白问题；
   - 结果行：状态图标、统计徽章（标题/表格/图片/公式/脚注/代码块）、F9 域更新警告条、操作按钮层级清晰；
   - 失败行：红色错误条 + 可展开 stderr 详情正常渲染；
   - 明暗主题同等完成度，窄屏单列无横向溢出、无挤压重叠；
   - 复查修正一处：队列面板最小高度改为仅空态生效（`:has(.empty)`），避免有结果行时底部留白过大。

## 遗留

- 无功能遗留；失败态截图经由路由拦截 mock `/api/convert` 取得（无效 UTF-8 输入未能触发真实 pandoc 失败），失败行样式与真实渲染路径一致（同一组件分支）。
