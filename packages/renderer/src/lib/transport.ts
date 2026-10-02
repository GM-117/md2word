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
  cancel(): Promise<void>;
  /** 打开产物文件（系统默认程序）/ 所在文件夹 */
  open(jobId: string, name: string, folder: boolean): Promise<boolean>;
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

  async cancel(): Promise<void> {
    await fetch('/api/cancel', { method: 'POST' });
  }

  async open(jobId: string, name: string, folder: boolean): Promise<boolean> {
    const r = await fetch(`/api/open/${jobId}/${encodeURIComponent(name)}?folder=${folder ? 1 : 0}`, { method: 'POST' });
    if (!r.ok) return false;
    const body = (await r.json()) as { ok: boolean };
    return body.ok;
  }
}

export const transport: ApiTransport = new HttpTransport();
