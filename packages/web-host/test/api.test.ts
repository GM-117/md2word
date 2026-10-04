import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let jobs: Awaited<ReturnType<typeof createServer>>['jobs'];
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'md2word-host-'));
  const created = await createServer({ dataDir });
  app = created.app;
  jobs = created.jobs;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---- multipart 构造（Node 内置 FormData 不可用于 fastify.inject，手工拼） ----
function multipart(parts: Array<{ name: string; value?: string | Buffer; filename?: string; contentType?: string }>): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----md2wordtest${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename !== undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType ?? 'text/markdown'}\r\n\r\n`));
      chunks.push(typeof p.value === 'string' ? Buffer.from(p.value, 'utf8') : (p.value ?? Buffer.alloc(0)));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      chunks.push(typeof p.value === 'string' ? Buffer.from(p.value, 'utf8') : Buffer.alloc(0));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** 与渲染层 HttpTransport 一致：文件名 URI 编码以保留相对路径（服务端解码还原） */
const enc = (name: string): string => encodeURIComponent(name);

describe('GET /api/health', () => {
  it('返回桥接信息与 pandoc sidecar 版本', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; name: string; pandoc: { version: string } | null };
    expect(body.ok).toBe(true);
    expect(body.pandoc?.version).toBe('3.12');
  });
});

describe('GET /api/templates/export/:id', () => {
  it('导出内置中文模板：合法 zip + 附件文件名', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates/export/builtin-zh' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(String(res.headers['content-disposition'])).toContain('filename*');
  });

  it('导出 pandoc 默认模板（按需生成缓存）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates/export/pandoc-default' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('未知模板 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates/export/nope.docx' });
    expect(res.statusCode).toBe(404);
  });

  it('闭环：导出的默认模板原样再导入应通过校验（D32）', async () => {
    const exp = await app.inject({ method: 'GET', url: '/api/templates/export/pandoc-default' });
    expect(exp.statusCode).toBe(200);
    const boundary = `----roundtrip${Math.random().toString(36).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pandoc 默认样式.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      exp.rawPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: 'pandoc 默认样式' });
  });
});

describe('POST /api/convert（US1：拖拽→转换→结果）', () => {
  it('中文文件名转换成功，产物可下载且为合法 zip', async () => {
    const md = readFileSync(new URL('../../../samples/basic-zh.md', import.meta.url), 'utf8');
    const { payload, headers } = multipart([
      { name: 'files', value: md, filename: '测试 文档.md' },
      { name: 'options', value: JSON.stringify({ toc: true }) },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { jobId: string; items: Array<{ ok: boolean; name: string; downloadUrl?: string; warnings: Array<{ code: string }> }> };
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.ok).toBe(true);
    expect(item.name).toBe('测试 文档.md');
    expect(item.downloadUrl).toContain('/api/download/');
    expect(item.warnings.map((w) => w.code)).toContain('W_TOC_FIELD');

    // 下载产物 → zip 魔数 + document.xml 存在
    const dl = await app.inject({ method: 'GET', url: item.downloadUrl! });
    expect(dl.statusCode).toBe(200);
    const buf = dl.rawPayload;
    expect(buf.subarray(0, 2).toString()).toBe('PK');

    // 打开接口数据源（D30 修复）：按上传名解析产物 docx 路径
    const openable = body.items[0]! as typeof item & { outputPath?: string };
    expect(jobs!.findOutputPath(body.jobId, item.name)).toBe(openable.outputPath ?? null);

    // 未产生物的名称 → 404 人话错误
    const miss = await app.inject({ method: 'POST', url: `/api/open/${body.jobId}/${encodeURIComponent('不存在.md')}` });
    expect(miss.statusCode).toBe(404);
    expect((miss.json() as { error: string }).error).toContain('未找到该文件的转换产物');

    // 打开接口：拒绝越界路径（路径穿越防护）
    const openRes = await app.inject({ method: 'POST', url: `/api/open/${body.jobId}/${encodeURIComponent('../../etc/passwd')}` });
    expect([404, 500]).toContain(openRes.statusCode);
  });

  it('失败文件不中断后续（US2 口径）', async () => {
    const { payload, headers } = multipart([
      { name: 'files', value: '# 好\n\n段落。\n', filename: 'a.md' },
      { name: 'files', value: '', filename: 'b.md' }, // 空文件也成功（pandoc 允许）
      { name: 'files', value: '# 好2\n', filename: 'c.md' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers });
    const body = res.json() as { items: Array<{ ok: boolean; name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(body.items.every((i) => i.ok)).toBe(true);
  });

  it('非 .md 附件被跳过；零有效文件 → 400', async () => {
    const { payload, headers } = multipart([
      { name: 'files', value: '<html></html>', filename: 'page.html' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers });
    expect(res.statusCode).toBe(400);
  });

  it('options 非法 JSON → 400', async () => {
    const { payload, headers } = multipart([
      { name: 'files', value: '# x\n', filename: 'x.md' },
      { name: 'options', value: '{broken' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers });
    expect(res.statusCode).toBe(400);
  });
});

describe('M6 文件夹批量（relPath 镜像落盘 + outputKey）', () => {
  const MD = '# 标题\n\n正文段落，含中文。\n';

  it('嵌套相对路径按镜像落盘：relPath 展示名保留、重名产物唯一键、产物可下载', async () => {
    const { payload, headers } = multipart([
      { name: 'files', value: MD, filename: enc('笔记/sub1/a.md') },
      { name: 'files', value: MD, filename: enc('笔记/sub2/a.md') },
      { name: 'files', value: MD, filename: enc('笔记/readme.md') },
      { name: 'options', value: '{}' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      jobId: string;
      items: Array<{ ok: boolean; name: string; outputKey?: string; downloadUrl?: string }>;
    };
    expect(body.items.map((i) => i.name)).toEqual(['笔记/sub1/a.md', '笔记/sub2/a.md', '笔记/readme.md']);
    expect(body.items.every((i) => i.ok)).toBe(true);
    // 重名产物（两个 sub 下的 a.md）：outputKey 唯一，downloadUrl 互不相同
    const keys = body.items.map((i) => i.outputKey!);
    expect(new Set(keys).size).toBe(3);
    expect(new Set(body.items.map((i) => i.downloadUrl)).size).toBe(3);
    expect(keys).toContain('a.docx');
    expect(keys).toContain('2-a.docx');

    // 每个登记键都可下载合法 zip（产物在镜像子目录内，按键解析而非平铺拼接）
    for (const item of body.items) {
      const dl = await app.inject({ method: 'GET', url: item.downloadUrl! });
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.subarray(0, 2).toString()).toBe('PK');
    }

    // open 路由按键解析（outputKey → 产物路径）
    const openable = await app.inject({
      method: 'POST',
      url: `/api/open/${body.jobId}/${encodeURIComponent(body.items[0]!.outputKey!)}`,
    });
    expect(openable.statusCode).toBe(200);
    expect((openable.json() as { ok: boolean }).ok).toBe(true);
  });

  it('穿越文件名被安全化：../evil.md 回退平铺 staged，不越出作业目录', async () => {
    const { payload, headers } = multipart([
      { name: 'files', value: MD, filename: enc('../evil.md') },
      { name: 'options', value: '{}' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ ok: boolean; name: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.ok).toBe(true);
    expect(body.items[0]!.name).toBe('evil.md'); // 段被剥掉，落作业目录内
  });

  it('资源文件镜像落盘保持相对目录结构（相对引用图片可解析）', async () => {
    // 1x1 透明 PNG（真实字节，pandoc 可完整读取嵌入）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const md = '# 图\n\n![pic](img/pic.png)\n';
    const { payload, headers } = multipart([
      { name: 'files', value: md, filename: enc('doc/note.md') },
      { name: 'files', value: png, filename: enc('doc/img/pic.png'), contentType: 'image/png' },
      { name: 'options', value: '{}' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers });
    const body = res.json() as { items: Array<{ ok: boolean; warnings: Array<{ code: string }> }> };
    expect(body.items[0]!.ok).toBe(true);
    // 图片按相对路径解析成功：不出现图片抓取失败警告
    expect(body.items[0]!.warnings.map((w) => w.code)).not.toContain('W_IMAGE_FETCH');
  });
});

describe('settings 持久化（US6）', () => {
  it('PUT 后 GET 生效且落盘 JSON（格式与 electron-store 一致）', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { toc: true, tocDepth: 4, highlightStyle: 'zenburn' },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    const s = get.json() as Record<string, unknown>;
    expect(s.toc).toBe(true);
    expect(s.tocDepth).toBe(4);
    expect(s.highlightStyle).toBe('zenburn');

    const disk = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(disk.highlightStyle).toBe('zenburn');
  });

  it('非法 highlightStyle / tocDepth → 400', async () => {
    const bad1 = await app.inject({ method: 'PUT', url: '/api/settings', payload: { highlightStyle: 'rainbow' } });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await app.inject({ method: 'PUT', url: '/api/settings', payload: { tocDepth: 9 } });
    expect(bad2.statusCode).toBe(400);
  });

  it('转换请求未带 options 时使用持久化设置作为缺省', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { toc: true, tocDepth: 2 } });
    const { payload, headers } = multipart([
      { name: 'files', value: '# 标题\n\n正文\n', filename: 'opts.md' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers });
    const body = res.json() as { items: Array<{ warnings: Array<{ code: string }> }> };
    expect(body.items[0]!.warnings.map((w) => w.code)).toContain('W_TOC_FIELD');
    // 还原设置
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { toc: false, tocDepth: 3 } });
  });
});

describe('日志与取消（US5）', () => {
  it('日志含转换记录，可导出', async () => {
    const logRes = await app.inject({ method: 'GET', url: '/api/log' });
    const lines = (logRes.json() as { lines: string[] }).lines;
    expect(lines.some((l) => l.includes('convert ok'))).toBe(true);

    const exportRes = await app.inject({ method: 'GET', url: '/api/log/export' });
    expect(exportRes.headers['content-disposition']).toContain('md2word-log.txt');
    expect(exportRes.body).toContain('[INFO]');
  });

  it('空队列取消返回 0', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/cancel' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { cancelled: number }).cancelled).toBe(0);
  });
});

describe('静态托管', () => {
  it('未配置 staticDir 时 /api 之外的路径 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });
});
