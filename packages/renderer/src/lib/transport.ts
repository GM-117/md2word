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
}

export interface TemplateInfo {
  builtin: { name: string; id: string; valid: boolean } | null;
  pandocDefault: { name: string; id: string };
  user: Array<{ name: string; valid: boolean; missingStyles: string[]; error?: string }>;
  defaultTemplate: string;
}

export type Settings = Record<string, unknown>;

export interface ApiTransport {
  health(): Promise<Health>;
  /** 一次作业：files[0..n] 中的 .md 参与转换，其余文件作为资源随作业保存（供相对路径引用） */
  convert(files: File[], options: ConvertOptionsPayload): Promise<JobResult>;
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
  /** 导入模板；无效模板被拒并返回缺失样式 */
  uploadTemplate(file: File): Promise<{ ok: boolean; name?: string; error?: string; missingStyles?: string[] }>;
  /** 删除用户模板 */
  deleteTemplate(name: string): Promise<boolean>;
}

export class HttpTransport implements ApiTransport {
  async health(): Promise<Health> {
    const r = await fetch('/api/health');
    if (!r.ok) throw new Error(`health HTTP ${r.status}`);
    return r.json() as Promise<Health>;
  }

  async convert(files: File[], options: ConvertOptionsPayload): Promise<JobResult> {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    form.append('options', JSON.stringify(options));
    const r = await fetch('/api/convert', { method: 'POST', body: form });
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
  getSettings(): Promise<Settings>;
  saveSettings(patch: Settings): Promise<Settings>;
  open(jobId: string, name: string, folder: boolean): Promise<boolean>;
  listTemplates(): Promise<TemplateInfo>;
  uploadTemplate(name: string, bytes: Uint8Array): Promise<{ ok: boolean; name?: string; error?: string; missingStyles?: string[] }>;
  deleteTemplate(name: string): Promise<boolean>;
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
    // path 模式优先（真实文件：直接从源位置转换，产物写源目录）；取不到路径时回退字节通道
    const entries = await Promise.all(
      files.map(async (f) => {
        const path = bridge().getPathForFile(f);
        if (path) return { name: f.name, path };
        return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
      }),
    );
    return bridge().convert(entries, options);
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
}

/** 环境自动选择：Electron 下走 IPC，浏览器/web-host 下走 HTTP（UI 组件对此无感知） */
export const transport: ApiTransport =
  typeof window !== 'undefined' && window.md2word ? new IpcTransport() : new HttpTransport();
