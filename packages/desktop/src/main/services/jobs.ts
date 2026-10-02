import { basename, dirname } from 'node:path';
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

  /** 登记一个产物（sourceName 为渲染层持有的结果名，通常为源 .md 文件名） */
  addOutput(jobId: string, sourceName: string, outputPath: string): void {
    this.jobs.get(jobId)?.outputs.set(sourceName, outputPath);
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

  /** 产物 basename → 路径（download URL 校验用） */
  resolveByBasename(jobId: string, name: string): string | null {
    const record = this.jobs.get(jobId);
    if (!record) return null;
    for (const outputPath of record.outputs.values()) {
      if (basename(outputPath) === name) return outputPath;
    }
    return null;
  }

  get size(): number {
    return this.jobs.size;
  }
}
