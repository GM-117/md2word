import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

interface JobRecord {
  /** staged 模式的作业目录（bytes 落盘处；path 模式无固定目录） */
  dir: string;
  /** 源 md 名 → 产物 docx 绝对路径（open 白名单的唯一事实源） */
  outputs: Map<string, string>;
}

/**
 * 作业注册表：jobId → 产物路径白名单。
 * open:path 通道只允许打开这里登记过的产物（对齐开发计划"仅 .docx 所在目录"约束）；
 * 键一律是 basename，用户输入永不参与路径拼接，天然防穿越。
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();

  createJob(dir: string): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, { dir, outputs: new Map() });
    return jobId;
  }

  /** 登记一个产物；key 为唯一化的产物 basename（M6：文件夹批量下重名产物加 N- 前缀），open/download 共用 */
  addOutput(jobId: string, key: string, outputPath: string): void {
    this.jobs.get(jobId)?.outputs.set(key, outputPath);
  }

  /** 解析 open 请求；未登记返回 null */
  resolve(jobId: string, sourceName: string): { outputPath: string; folder: string } | null {
    const record = this.jobs.get(jobId);
    if (!record) return null;
    const outputPath = record.outputs.get(sourceName);
    if (!outputPath) return null;
    return { outputPath, folder: dirname(outputPath) };
  }

  /** 作业目录（staged 模式产物所在） */
  jobDir(jobId: string): string | null {
    return this.jobs.get(jobId)?.dir ?? null;
  }

  /** 按登记键直查产物（登记键 = 唯一化的产物 basename，M6 起与 downloadUrl/open 共用） */
  resolveKey(jobId: string, key: string): string | null {
    return this.jobs.get(jobId)?.outputs.get(key) ?? null;
  }

  get size(): number {
    return this.jobs.size;
  }
}
