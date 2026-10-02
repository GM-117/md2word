import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'md2word-tpl-'));
  const created = await createServer({ dataDir });
  app = created.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function multipartFile(fieldName: string, filename: string, data: Buffer | string, type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----tpl${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, Buffer.from(data), tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('GET /api/templates（M3：内置模板在位）', () => {
  it('内置中文模板存在且校验通过', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { builtin: { name: string; valid: boolean } | null; pandocDefault: { id: string }; user: unknown[]; defaultTemplate: string };
    expect(body.builtin).not.toBeNull();
    expect(body.builtin!.valid).toBe(true);
    expect(body.pandocDefault.id).toBe('pandoc-default');
    expect(body.defaultTemplate).toBe('builtin-zh');
  });
});

describe('POST /api/templates 导入与校验（M3 DoD：无效模板被拒并提示缺哪些样式）', () => {
  it('合法模板（复制内置）导入成功', async () => {
    // 直接用 core assets 的内置模板作为“用户上传”
    const builtinBuf = readFileSync(new URL('../../core/assets/reference-zh.docx', import.meta.url));
    const { payload, headers } = multipartFile('file', '我的 模板.docx', builtinBuf);
    const res = await app.inject({ method: 'POST', url: '/api/templates', payload, headers });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe('我的 模板');
    const list = (await app.inject({ method: 'GET', url: '/api/templates' })).json() as { user: Array<{ name: string; valid: boolean }> };
    expect(list.user.some((t) => t.name === '我的 模板' && t.valid)).toBe(true);
  });

  it('缺样式模板被拒，提示缺失样式清单', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const bad = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8('<w:document/>'),
      'word/styles.xml': strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="Normal" w:type="paragraph"><w:name w:val="Normal"/></w:style></w:styles>'),
    });
    const { payload, headers } = multipartFile('file', 'broken.docx', Buffer.from(bad));
    const res = await app.inject({ method: 'POST', url: '/api/templates', payload, headers });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; missingStyles: string[]; error: string };
    expect(body.ok).toBe(false);
    expect(body.missingStyles).toContain('Source Code');
    expect(body.error).toContain('缺少必需样式');
    // 无效模板不落库
    expect(existsSync(join(dataDir, 'templates', 'broken.docx'))).toBe(false);
  });

  it('非 docx 被拒', async () => {
    const { payload, headers } = multipartFile('file', 'fake.txt', Buffer.from('hi'), 'text/plain');
    const res = await app.inject({ method: 'POST', url: '/api/templates', payload, headers });
    expect(res.statusCode).toBe(400);
  });

  it('defaultTemplate 指向用户模板时转换生效（dc:title 元数据 + SimSun 字体链路）', async () => {
    // 选定用户模板
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { defaultTemplate: '我的 模板', metaTitle: '集成测试标题', metaAuthor: '测试员' } });
    const boundary = '----conv';
    const md = '# 模板链路\n\n正文。\n';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="t.md"\r\n\r\n${md}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n{}\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/convert',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    const body = res.json() as { items: Array<{ ok: boolean; downloadUrl: string }> };
    expect(body.items[0]!.ok).toBe(true);
    const dl = await app.inject({ method: 'GET', url: body.items[0]!.downloadUrl });
    const { unzipSync } = await import('fflate');
    const files = unzipSync(dl.rawPayload);
    const coreXml = new TextDecoder().decode(files['docProps/core.xml']);
    expect(coreXml).toContain('<dc:title>集成测试标题</dc:title>');
    expect(coreXml).toContain('测试员');
    const stylesXml = new TextDecoder().decode(files['word/styles.xml']);
    // 用户模板即内置中文模板副本 → 中文字体在位
    expect(stylesXml).toContain('SimSun');
    // 还原设置
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { defaultTemplate: 'builtin-zh', metaTitle: '', metaAuthor: '' } });
  });

  it('pandoc-default 时不注入中文字体（回退 pandoc 原生）', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { defaultTemplate: 'pandoc-default', metaTitle: '', metaAuthor: '' } });
    const boundary = '----conv2';
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="p.md"\r\n\r\n# x\n\r\n--${boundary}--\r\n`);
    const res = await app.inject({ method: 'POST', url: '/api/convert', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    const body = res.json() as { items: Array<{ ok: boolean; downloadUrl: string }> };
    expect(body.items[0]!.ok).toBe(true);
    const dl = await app.inject({ method: 'GET', url: body.items[0]!.downloadUrl });
    const { unzipSync } = await import('fflate');
    const stylesXml = new TextDecoder().decode(unzipSync(dl.rawPayload)['word/styles.xml']);
    expect(stylesXml).not.toContain('SimSun');
  });

  it('DELETE 移除用户模板并把默认回退到 builtin-zh', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { defaultTemplate: '我的 模板' } });
    const res = await app.inject({ method: 'DELETE', url: `/api/templates/${encodeURIComponent('我的 模板')}` });
    expect(res.statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/templates' })).json() as { user: Array<{ name: string }>; defaultTemplate: string };
    expect(list.user.some((t) => t.name === '我的 模板')).toBe(false);
    expect(list.defaultTemplate).toBe('builtin-zh');
  });
});
