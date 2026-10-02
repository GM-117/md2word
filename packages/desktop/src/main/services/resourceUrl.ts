/**
 * md2word:// 资源 URL 解析（桌面端"下载 .docx"/"导出日志"锚点的承载方式）。
 * 严格校验：jobId 必须是 UUID、name 解码后不得含路径分隔符或 ".."。
 */
export type ResourceUrl =
  | { kind: 'download'; jobId: string; name: string }
  | { kind: 'log' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseResourceUrl(rawUrl: string): ResourceUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'md2word:') return null;

  // new URL 归一化后 md2word://log/export 的 host 为 log，pathname 为 /export
  const host = url.hostname;
  if (host === 'log') return { kind: 'log' };
  if (host !== 'download') return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const jobId = segments[0] ?? '';
  const rawName = segments[1] ?? '';
  if (segments.length !== 2 || !UUID_RE.test(jobId)) return null;

  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  if (name.length === 0 || name.length > 255) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  if (name === '.' || name === '..' || name.includes('..')) return null;

  return { kind: 'download', jobId, name };
}

/** 构造结果条目的 download URL（services/convert 输出用） */
export function buildDownloadUrl(jobId: string, outputName: string): string {
  return `md2word://download/${jobId}/${encodeURIComponent(outputName)}`;
}
