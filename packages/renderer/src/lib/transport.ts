// 传输适配器（M4 换 Electron IPC 时仅替换实现，UI 零改动 —— 开发计划 §2.1）
export interface PandocStatus {
  version?: string;
  path?: string;
  source?: string;
}

export interface Health {
  ok: boolean;
  name: string;
  pandoc: PandocStatus | null;
  pending?: number;
  running?: boolean;
}

export interface ConvertWarning {
  code: string;
  message: string;
  detail?: string;
}

export interface ConvertItemResult {
  ok: boolean;
  outputPath?: string;
  durationMs: number;
  stats?: Record<string, number>;
  warnings: ConvertWarning[];
  error?: { code: string; message: string; stderrTail?: string };
  name: string;
  /** open/download 共用的登记键（M6：文件夹批量下重名产物唯一化；web 端与桌面端语义一致） */
  outputKey?: string;
  downloadUrl?: string;
}

export interface JobResult {
  jobId: string;
  items: ConvertItemResult[];
}

export interface ConvertOptionsPayload {
  toc?: boolean;
  tocDepth?: number;
  numberSections?: boolean;
  highlightStyle?: string;
  offline?: boolean;
  overwrite?: boolean;
  metadata?: { title?: string; author?: string };
  /** 模板名：'builtin-zh' | 'pandoc-default' | 用户模板名（服务端解析为路径） */
  template?: string;
  /** M6+ 流式进度：渲染层生成的批次关联标记，服务端仅在进度事件中原样回传（不进入转换选项） */
  clientBatchId?: string;
}

/** M6+ 逐文件流式进度事件：单个文件落定（成功/失败）即推送一次 */
export interface ConvertProgressEvent {
  /** 批次关联标记（渲染层生成；web 端由服务端原样回传，桌面端经 IPC 事件回传） */
  batchId?: string;
  jobId: string;
  /** 在本批次 md 条目中的序号（与提交顺序一致） */
  index: number;
  item: ConvertItemResult;
}

export interface TemplateInfo {
  builtin: { name: string; id: string; valid: boolean } | null;
  pandocDefault: { name: string; id: string };
  user: Array<{ name: string; valid: boolean; missingStyles: string[]; error?: string }>;
  defaultTemplate: string;
}

export type Settings = Record<string, unknown>;

/** 模板样式概览（桌面端"模板预览"卡片数据；与 desktop services/templates.ts 的 TemplateStyleSummary 对应） */
export interface TemplateStyleSummary {
  label: string;
  normal?: { font?: string; eastAsia?: string; sizePt?: number };
  heading?: { font?: string; eastAsia?: string; sizePt?: number };
  code?: { font?: string; eastAsia?: string; sizePt?: number };
  lineSpacing?: number;
}

export interface ApiTransport {
  health(): Promise<Health>;
  /** 一次作业：files[0..n] 中的 .md 参与转换，其余文件作为资源随作业保存（供相对路径引用） */
  convert(files: File[], options: ConvertOptionsPayload): Promise<JobResult>;
  /**
   * M6 批量转换：已备好的文件条目（name 可为含子目录的相对路径，file 为网页端 File 源）。
   * 与 convert 的差别：桌面端文件夹批量已持有真实路径（path 模式），跳过 getPathForFile 探测。
   * onProgress（可选）：传入时（options.clientBatchId 为关联标记）逐文件推送落定结果——
   * 桌面端走 convert:progress IPC 事件，网页端走 NDJSON 流式响应（Accept 协商，旧服务端自动回退整批 JSON）。
   */
  convertEntries(
    entries: ConvertEntryPayload[],
    options: ConvertOptionsPayload,
    onProgress?: (evt: ConvertProgressEvent) => void,
  ): Promise<JobResult>;
  /** M6（仅桌面）：原生文件夹选择对话框；用户取消返回 ok:false */
  pickFolder?(): Promise<{ ok: boolean; path?: string }>;
  /** M6（仅桌面）：递归扫描文件夹（排除隐藏/非 .md/node_modules）；无 .md 或路径非法时抛错 */
  scanFolder?(folderPath: string): Promise<FolderScanResult>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: Settings): Promise<Settings>;
  exportLogUrl(): string;
  downloadUrl(path: string): string;
  /** 中断正在进行的转换并清空等待队列；返回被取消的任务数 */
  cancel(): Promise<{ cancelled: number }>;
  /** 打开产物文件（系统默认程序）/ 所在文件夹 */
  open(jobId: string, name: string, folder: boolean): Promise<boolean>;
  /** 模板列表（含校验状态） */
  listTemplates(): Promise<TemplateInfo>;
  /** 下载当前模板文件（builtin-zh / pandoc-default / 用户模板名）的 URL */
  exportTemplateUrl(id: string): string;
  /** 导入模板；无效模板被拒并返回缺失样式 */
  uploadTemplate(file: File): Promise<{ ok: boolean; name?: string; error?: string; missingStyles?: string[] }>;
  /** 删除用户模板 */
  deleteTemplate(name: string): Promise<boolean>;
}

/** M6 批量条目：path（桌面真实文件）与 file（网页 File 对象）二选一 */
export interface ConvertEntryPayload {
  name: string;
  path?: string;
  file?: File;
}

/** M6：文件夹扫描结果（桌面端 IPC 返回结构） */
export interface FolderScanResult {
  root: string;
  files: Array<{ path: string; relPath: string }>;
  truncated: boolean;
  scannedDirs: number;
}

export class HttpTransport implements ApiTransport {
  async health(): Promise<Health> {
    const r = await fetch('/api/health');
    if (!r.ok) throw new Error(`health HTTP ${r.status}`);
    return r.json() as Promise<Health>;
  }

  async convert(files: File[], options: ConvertOptionsPayload): Promise<JobResult> {
    return this.convertEntries(files.map((f) => ({ name: f.name, file: f })), options);
  }

  async convertEntries(
    entries: ConvertEntryPayload[],
    options: ConvertOptionsPayload,
    onProgress?: (evt: ConvertProgressEvent) => void,
  ): Promise<JobResult> {
    const form = new FormData();
    for (const e of entries) {
      if (!e.file) throw new Error(`网页端仅支持文件上传（${e.name} 缺少文件内容）`);
      // 文件名 URI 编码以保留相对路径（服务端解码还原；busboy 会把裸 filename 扒平成 basename）
      form.append('files', e.file, encodeURIComponent(e.name));
    }
    form.append('options', JSON.stringify(options));
    if (!onProgress) {
      const r = await fetch('/api/convert', { method: 'POST', body: form });
      return this.parseConvertResponse(r);
    }
    // 流式：NDJSON 逐行解析（服务端按 Accept 协商；不支持的旧服务端回退整批 JSON）
    const r = await fetch('/api/convert', {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/x-ndjson' },
    });
    if (!r.ok) return this.parseConvertResponse(r);
    const isNdjson = (r.headers.get('content-type') ?? '').includes('application/x-ndjson');
    if (!isNdjson || !r.body) return this.parseConvertResponse(r);
    return readNdjsonStream(r.body, onProgress);
  }

  private async parseConvertResponse(r: Response): Promise<JobResult> {
    const body = (await r.json()) as JobResult & { ok?: boolean; error?: string };
    if (!r.ok) throw new Error(body.error ?? `convert HTTP ${r.status}`);
    return body;
  }

  async getSettings(): Promise<Settings> {
    const r = await fetch('/api/settings');
    if (!r.ok) throw new Error(`settings HTTP ${r.status}`);
    return r.json() as Promise<Settings>;
  }

  async saveSettings(patch: Settings): Promise<Settings> {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`settings HTTP ${r.status}`);
    return r.json() as Promise<Settings>;
  }

  exportLogUrl(): string {
    return '/api/log/export';
  }

  downloadUrl(path: string): string {
    return path; // 服务端返回的 downloadUrl 已是相对端点
  }

  async cancel(): Promise<{ cancelled: number }> {
    const r = await fetch('/api/cancel', { method: 'POST' });
    const body = (await r.json().catch(() => ({}))) as { cancelled?: number };
    return { cancelled: typeof body.cancelled === 'number' ? body.cancelled : 0 };
  }

  async open(jobId: string, name: string, folder: boolean): Promise<boolean> {
    const r = await fetch(`/api/open/${jobId}/${encodeURIComponent(name)}?folder=${folder ? 1 : 0}`, { method: 'POST' });
    if (!r.ok) return false;
    const body = (await r.json()) as { ok: boolean };
    return body.ok;
  }

  async listTemplates(): Promise<TemplateInfo> {
    const r = await fetch('/api/templates');
    if (!r.ok) throw new Error(`templates HTTP ${r.status}`);
    return r.json() as Promise<TemplateInfo>;
  }

  exportTemplateUrl(id: string): string {
    return `/api/templates/export/${encodeURIComponent(id)}`;
  }

  async uploadTemplate(file: File): Promise<{ ok: boolean; name?: string; error?: string; missingStyles?: string[] }> {
    const form = new FormData();
    form.append('file', file, file.name);
    const r = await fetch('/api/templates', { method: 'POST', body: form });
    const body = (await r.json()) as { ok: boolean; name?: string; error?: string; missingStyles?: string[] };
    if (!r.ok) return { ok: false, error: body.error ?? `HTTP ${r.status}`, missingStyles: body.missingStyles };
    return body;
  }

  async deleteTemplate(name: string): Promise<boolean> {
    const r = await fetch(`/api/templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
    return r.ok;
  }
}

/* ---------- Electron IPC 传输（M4：window.md2word 桥存在时自动选用，UI 零改动） ---------- */

/** 预加载桥暴露的白名单 API（与 packages/desktop/src/preload/index.ts 一一对应） */
export interface Md2WordBridge {
  platform: string;
  health(): Promise<Health>;
  convert(
    entries: Array<{ name: string; path?: string; bytes?: Uint8Array }>,
    options: ConvertOptionsPayload,
  ): Promise<JobResult>;
  cancel(): Promise<{ ok: boolean; cancelled?: number }>;
  /** M6+ 流式进度：订阅逐文件落定事件（按事件内 batchId 区分批次）；返回退订函数 */
  onConvertProgress(callback: (evt: ConvertProgressEvent) => void): () => void;
  /** D33 下载反馈：订阅 .docx/模板下载与日志导出的保存结果（成功含 savedPath）；返回退订函数 */
  onDownloadFeedback(callback: (feedback: { ok: boolean; filename: string; savedPath?: string }) => void): () => void;
  /** M6：原生文件夹选择对话框（用户取消 → ok:false） */
  pickFolder(): Promise<{ ok: boolean; path?: string }>;
  /** M6：递归扫描文件夹（排除隐藏/非 .md/node_modules）；无 .md 或路径非法时抛错 */
  scanFolder(folderPath: string): Promise<FolderScanResult>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: Settings): Promise<Settings>;
  open(jobId: string, name: string, folder: boolean): Promise<boolean>;
  listTemplates(): Promise<TemplateInfo>;
  uploadTemplate(name: string, bytes: Uint8Array): Promise<{ ok: boolean; name?: string; error?: string; missingStyles?: string[] }>;
  deleteTemplate(name: string): Promise<boolean>;
  /** 模板样式概览（模板预览卡片；失败/未知 id 返回 null） */
  templateSummary(id: string): Promise<TemplateStyleSummary | null>;
  // 模板文件下载走 md2word://template/<id>（will-download 原生保存对话框），无需专用方法
  /** 下载当前模板文件的 URL（web = HTTP 端点；桌面 = md2word:// 协议，原生保存对话框） */
  exportTemplateUrl(id: string): string;
  /** 点击最近文件重新转换（使用当前选项；源路径由主进程 recentPaths 登记表解析） */
  reconvert(name: string): Promise<JobResult>;
  /** 拖拽/选择的 File → 真实文件系统路径；虚拟文件（如自动化注入）返回空串 */
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    md2word?: Md2WordBridge;
  }
}

function bridge(): Md2WordBridge {
  if (!window.md2word) throw new Error('md2word 桥不可用（非桌面环境）');
  return window.md2word;
}

export class IpcTransport implements ApiTransport {
  async health(): Promise<Health> {
    return bridge().health();
  }

  async convert(files: File[], options: ConvertOptionsPayload): Promise<JobResult> {
    return this.convertEntries(files.map((f) => ({ name: f.name, file: f })), options);
  }

  async convertEntries(
    entries: ConvertEntryPayload[],
    options: ConvertOptionsPayload,
    onProgress?: (evt: ConvertProgressEvent) => void,
  ): Promise<JobResult> {
    // 流式进度：按 options.clientBatchId 过滤事件（同队列可能交错多个批次），结束后退订
    let unsub: (() => void) | null = null;
    if (onProgress && options.clientBatchId) {
      const batchId = options.clientBatchId;
      unsub = bridge().onConvertProgress((evt) => {
        if (evt.batchId === batchId) onProgress(evt);
      });
    }
    try {
      // path 模式优先（真实文件：直接从源位置转换，产物写源目录）；取不到路径时回退字节通道
      const payloads = await Promise.all(
        entries.map(async (e) => {
          if (e.path) return { name: e.name, path: e.path };
          if (e.file) {
            const path = bridge().getPathForFile(e.file);
            if (path) return { name: e.name, path };
            return { name: e.name, bytes: new Uint8Array(await e.file.arrayBuffer()) };
          }
          return { name: e.name }; // 无内容 → 服务端报 E_SOURCE_NOT_FOUND
        }),
      );
      return await bridge().convert(payloads, options);
    } finally {
      unsub?.();
    }
  }

  async pickFolder(): Promise<{ ok: boolean; path?: string }> {
    return bridge().pickFolder();
  }

  async scanFolder(folderPath: string): Promise<FolderScanResult> {
    return bridge().scanFolder(folderPath);
  }

  async getSettings(): Promise<Settings> {
    return bridge().getSettings();
  }

  async saveSettings(patch: Settings): Promise<Settings> {
    return bridge().saveSettings(patch);
  }

  exportLogUrl(): string {
    return 'md2word://log/export'; // 主进程导航拦截 → 存盘对话框
  }

  downloadUrl(path: string): string {
    return path; // 结果条目已携带 md2word://download/<jobId>/<name>
  }

  exportTemplateUrl(id: string): string {
    return `md2word://template/${encodeURIComponent(id)}`;
  }

  async cancel(): Promise<{ cancelled: number }> {
    const r = await bridge().cancel();
    return { cancelled: r.cancelled ?? 0 };
  }

  async open(jobId: string, name: string, folder: boolean): Promise<boolean> {
    return bridge().open(jobId, name, folder);
  }

  async listTemplates(): Promise<TemplateInfo> {
    return bridge().listTemplates();
  }

  async uploadTemplate(file: File): Promise<{ ok: boolean; name?: string; error?: string; missingStyles?: string[] }> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bridge().uploadTemplate(file.name, bytes);
  }

  async deleteTemplate(name: string): Promise<boolean> {
    return bridge().deleteTemplate(name);
  }

  async templateSummary(id: string): Promise<TemplateStyleSummary | null> {
    return bridge().templateSummary(id);
  }

  async reconvert(name: string): Promise<JobResult> {
    return bridge().reconvert(name);
  }
}

/** 桌面能力标记：Electron 桥存在（最近文件点击重转/模板预览等桌面专属 UI 依赖它降级） */
export const isDesktop = typeof window !== 'undefined' && !!window.md2word;

/** 环境自动选择：Electron 下走 IPC，浏览器/web-host 下走 HTTP（UI 组件对此无感知） */
export const transport: ApiTransport =
  typeof window !== 'undefined' && window.md2word ? new IpcTransport() : new HttpTransport();

/** NDJSON 流解析：每行一个事件（item/done/error），逐文件回调进度，最终以 done 行的完整结果收束 */
async function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (evt: ConvertProgressEvent) => void,
): Promise<JobResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final: JobResult | null = null;
  const handleLine = (line: string): void => {
    if (!line) return;
    const evt = JSON.parse(line) as
      | { type: 'item'; batchId?: string; jobId?: string; index: number; item: ConvertItemResult }
      | { type: 'done'; jobId: string; items: ConvertItemResult[] }
      | { type: 'error'; message: string };
    if (evt.type === 'item') {
      onProgress({ batchId: evt.batchId, jobId: evt.jobId ?? '', index: evt.index, item: evt.item });
    } else if (evt.type === 'done') {
      final = { jobId: evt.jobId, items: evt.items };
    } else {
      throw new Error(evt.message);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    if (done) break;
  }
  handleLine(buf.trim()); // 兜底：末行无换行符
  if (!final) throw new Error('转换流意外结束（未收到完整结果）');
  return final;
}
