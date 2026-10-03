import { createReadStream, mkdirSync, existsSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { default as fastify } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { augmentTemplateStyles, runPandoc, HIGHLIGHT_STYLES, resolvePandocInfo, validateTemplate, getBundledReferenceDocx, type ConvertOptions, type HighlightStyle } from '@md2word/core';
import { LogBuffer } from './lib/logger.js';
import { SettingsStore } from './lib/settings.js';
import { JobManager, type JobResult } from './lib/jobs.js';

export interface CreateServerOptions {
  /** 数据目录（.data）：jobs/settings/log/templates；默认仓库根 .data */
  dataDir?: string;
  /** 静态托管目录（renderer dist）；缺省不托管（开发时由 Vite 服务） */
  staticDir?: string;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DEFAULT_SETTINGS: Record<string, unknown> = {
  toc: false,
  tocDepth: 3,
  numberSections: false,
  highlightStyle: 'pygments',
  offline: false,
  overwrite: false,
  defaultTemplate: 'builtin-zh',
  metaTitle: '',
  metaAuthor: '',
  recentFiles: [] as string[],
};

export async function createServer(opts: CreateServerOptions = {}) {
  const dataDir = resolve(opts.dataDir ?? join(REPO_ROOT, '.data'));
  const templatesDir = join(dataDir, 'templates');
  mkdirSync(templatesDir, { recursive: true });

  const logger = new LogBuffer();
  logger.attachFile(join(dataDir, 'md2word.log'));
  const settings = new SettingsStore(dataDir, DEFAULT_SETTINGS);
  const jobs = new JobManager(dataDir, logger);

  /** pandoc 原生模板导出缓存（pandoc-default 显式选择/下载时使用；D32：注入缺失必需样式） */
  async function ensurePandocDefaultTemplate(): Promise<string> {
    const cached = join(templatesDir, '.pandoc-default-aug-v2.docx');
    if (existsSync(cached)) return cached;
    const pandoc = await resolvePandocInfo();
    if (!pandoc) throw new Error('pandoc 不可用，无法导出默认模板');
    const run = await runPandoc(pandoc.path, ['--print-default-data-file', 'reference.docx'], { timeoutMs: 30_000 });
    if (run.code !== 0 || run.stdoutBytes.length < 1000) {
      throw new Error(`导出 pandoc 默认模板失败：${run.stderr.slice(0, 200)}`);
    }
    const donor = getBundledReferenceDocx();
    const augmented = donor ? augmentTemplateStyles(run.stdoutBytes, donor) : run.stdoutBytes;
    writeFileSync(cached, augmented);
    return cached;
  }

  /** 解析生效模板：请求指定 > 用户默认模板 > 内置中文模板 > pandoc 原生（显式选择时） */
  async function resolveTemplate(requested?: string): Promise<string | undefined> {
    if (requested) return requested;
    const pref = settings.all.defaultTemplate;
    if (pref === 'pandoc-default') return ensurePandocDefaultTemplate();
    if (typeof pref === 'string' && pref !== 'builtin-zh') {
      const safe = basename(pref);
      const p = join(templatesDir, safe);
      if (pref === safe && existsSync(p)) return p;
      logger.warn(`defaultTemplate 指向的模板不存在，回退：${pref}`);
    }
    return getBundledReferenceDocx() ?? undefined;
  }

  const app = fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  await app.register(multipart, {
    limits: { fileSize: 64 * 1024 * 1024, files: 50 },
  });

  // ---- 健康检查 ----
  app.get('/api/health', async () => {
    const pandoc = await resolvePandocInfo();
    return { ok: true, name: 'md2word web-host', pandoc, pending: jobs.pendingCount, running: jobs.isRunning };
  });

  // ---- 模板管理（M3：导入/选择/校验） ----
  app.get('/api/templates', async () => {
    const user = readdirSync(templatesDir)
      .filter((f) => f.toLowerCase().endsWith('.docx'))
      .map((f) => {
        const p = join(templatesDir, f);
        const v = validateTemplate(p);
        return { name: f.replace(/\.docx$/i, ''), valid: v.ok, missingStyles: v.missingStyles, error: v.error };
      });
    const bundled = getBundledReferenceDocx();
    return {
      builtin: bundled ? { name: '内置中文模板', id: 'builtin-zh', valid: validateTemplate(bundled).ok } : null,
      pandocDefault: { name: 'pandoc 默认样式', id: 'pandoc-default' },
      user,
      defaultTemplate: settings.all.defaultTemplate,
    };
  });

  app.post('/api/templates', async (req, reply) => {
    const parts = req.parts();
    let saved: string | null = null;
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const safeName = (part.filename ?? '').split(/[\\/]/).pop() ?? '';
      if (!safeName.toLowerCase().endsWith('.docx')) {
        reply.code(400);
        return { ok: false, error: '模板必须是 .docx 文件' };
      }
      const buf = await part.toBuffer();
      const target = join(templatesDir, safeName);
      writeFileSync(target, buf);
      saved = target;
    }
    if (!saved) {
      reply.code(400);
      return { ok: false, error: '未收到模板文件' };
    }
    const v = validateTemplate(saved);
    if (!v.ok) {
      unlinkSync(saved); // 无效模板不落库
      reply.code(400);
      logger.warn(`template rejected: ${basename(saved)} missing=${v.missingStyles.join(',')} error=${v.error ?? ''}`);
      return {
        ok: false,
        error: v.error ?? `模板缺少必需样式：${v.missingStyles.join('、')}（请基于内置模板或 pandoc 默认模板修改）`,
        missingStyles: v.missingStyles,
      };
    }
    logger.info(`template imported: ${basename(saved)}`);
    return { ok: true, name: basename(saved).replace(/\.docx$/i, '') };
  });

  // ---- 模板文件导出（供用户下载标准模板后自定义修改） ----
  app.get('/api/templates/export/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    let p: string | null = null;
    let filename = `${id}.docx`;
    if (id === 'builtin-zh') {
      p = getBundledReferenceDocx();
      filename = '内置中文模板.docx';
    } else if (id === 'pandoc-default') {
      p = await ensurePandocDefaultTemplate();
      filename = 'pandoc默认模板.docx';
    } else {
      const safe = basename(id);
      if (!safe || safe !== id) {
        reply.code(400);
        return { ok: false, error: '非法模板名' };
      }
      p = join(templatesDir, `${safe}.docx`);
      filename = `${safe}.docx`;
    }
    if (!p || !existsSync(p)) {
      reply.code(404);
      return { ok: false, error: '模板不存在' };
    }
    logger.info(`template exported: ${basename(p)} → ${filename}`);
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return reply.send(createReadStream(p));
  });

  app.delete('/api/templates/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const safe = basename(name);
    const p = join(templatesDir, `${safe}.docx`);
    if (!existsSync(p)) {
      reply.code(404);
      return { ok: false, error: '模板不存在' };
    }
    unlinkSync(p);
    if (settings.all.defaultTemplate === safe) settings.set({ defaultTemplate: 'builtin-zh' });
    return { ok: true };
  });

  // ---- 转换 ----
  app.post('/api/convert', async (req, reply) => {
    const parts = req.parts();
    const jobDir = join(dataDir, 'jobs', randomUUID());
    mkdirSync(jobDir, { recursive: true });
    const names: string[] = [];
    let options: ConvertOptions = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        const safeName = (part.filename ?? '').split(/[\\/]/).pop() ?? part.filename;
        const { writeFileSync } = await import('node:fs');
        const buf = await part.toBuffer();
        if (/\.(md|markdown|mdown|mkd)$/i.test(safeName)) {
          let finalName = safeName;
          let n = 1;
          while (names.includes(finalName)) finalName = `${++n}-${safeName}`;
          writeFileSync(join(jobDir, finalName), buf);
          names.push(finalName);
        } else {
          writeFileSync(join(jobDir, safeName), buf);
        }
      } else if (part.fieldname === 'options') {
        try {
          options = JSON.parse(String(part.value)) as ConvertOptions;
        } catch {
          reply.code(400);
          return { ok: false, error: 'options 字段不是合法 JSON' };
        }
      }
    }

    if (names.length === 0) {
      reply.code(400);
      return { ok: false, error: '未收到任何 .md 文件（支持 .md/.markdown/.mdown/.mkd）' };
    }

    const s = settings.all;
    const merged: ConvertOptions = {
      toc: s.toc === true,
      tocDepth: (s.tocDepth as 1 | 2 | 3 | 4 | 5 | 6) ?? 3,
      numberSections: s.numberSections === true,
      highlightStyle: (s.highlightStyle as HighlightStyle) ?? 'pygments',
      offline: s.offline === true,
      referenceDocx: await resolveTemplate(options.referenceDocx),
      metadata: {
        title: typeof s.metaTitle === 'string' && s.metaTitle ? s.metaTitle : undefined,
        author: typeof s.metaAuthor === 'string' && s.metaAuthor ? s.metaAuthor : undefined,
      },
      ...options,
    };
    if (merged.metadata && !merged.metadata.title && !merged.metadata.author) delete merged.metadata;

    const state = jobs.createJob(jobDir, names);
    logger.info(`job accepted: ${names.length} file(s), options=${JSON.stringify({ ...merged, referenceDocx: merged.referenceDocx ? basename(merged.referenceDocx) : undefined })}`);
    const result = await jobs.enqueueJob(state, merged);
    return result satisfies JobResult;
  });

  // ---- 取消 ----
  app.post('/api/cancel', async () => {
    const n = jobs.cancelAll();
    return { ok: true, cancelled: n };
  });

  // ---- 下载产物 ----
  app.get('/api/download/:jobId/:name', async (req, reply) => {
    const { jobId, name } = req.params as { jobId: string; name: string };
    const dir = jobs.jobDir(jobId);
    if (!dir) {
      reply.code(404);
      return { ok: false, error: '作业不存在或已清理' };
    }
    const file = join(dir, decodeURIComponent(name));
    if (!file.startsWith(dir) || !existsSync(file)) {
      reply.code(404);
      return { ok: false, error: '产物不存在' };
    }
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(createReadStream(file));
  });

  // ---- 打开文件/目录（D30：打开/定位的是转换产物 docx，而非 staged 的 .md） ----
  app.post('/api/open/:jobId/:name', async (req, reply) => {
    const { jobId, name } = req.params as { jobId: string; name: string };
    if (!jobs.jobDir(jobId)) {
      reply.code(404);
      return { ok: false, error: '作业不存在' };
    }
    const output = jobs.findOutputPath(jobId, decodeURIComponent(name));
    if (!output || !existsSync(output)) {
      reply.code(404);
      return { ok: false, error: '未找到该文件的转换产物（可能转换失败或已被清理）' };
    }
    const reveal = (req.query as { folder?: string }).folder === '1';
    const ok = await jobs.openPath(output, reveal ? 'reveal' : 'file');
    return { ok };
  });

  // ---- 设置 ----
  app.get('/api/settings', async () => settings.all);
  app.put('/api/settings', async (req, reply) => {
    const patch = req.body as Record<string, unknown> | null;
    if (!patch || typeof patch !== 'object') {
      reply.code(400);
      return { ok: false, error: '请求体必须是 JSON 对象' };
    }
    if (patch.highlightStyle !== undefined && !HIGHLIGHT_STYLES.includes(patch.highlightStyle as HighlightStyle)) {
      reply.code(400);
      return { ok: false, error: `highlightStyle 必须是：${HIGHLIGHT_STYLES.join('/')}` };
    }
    if (patch.tocDepth !== undefined && ![1, 2, 3, 4, 5, 6].includes(patch.tocDepth as number)) {
      reply.code(400);
      return { ok: false, error: 'tocDepth 必须是 1-6' };
    }
    if (patch.recentFiles !== undefined) {
      if (!Array.isArray(patch.recentFiles) || patch.recentFiles.some((x) => typeof x !== 'string')) {
        reply.code(400);
        return { ok: false, error: 'recentFiles 必须是字符串数组' };
      }
      patch.recentFiles = (patch.recentFiles as string[]).slice(0, 10);
    }
    settings.set(patch);
    logger.info(`settings updated: ${JSON.stringify(patch)}`);
    return settings.all;
  });

  // ---- 日志 ----
  app.get('/api/log', async () => ({ lines: logger.exportText().split('\n').filter(Boolean) }));
  app.get('/api/log/export', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="md2word-log.txt"');
    return logger.exportText();
  });

  // ---- 静态托管 renderer ----
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : null;
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api')) {
        reply.code(404);
        return { ok: false, error: '接口不存在' };
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, logger, settings, jobs, dataDir, templatesDir };
}

const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  const { app } = await createServer();
  const port = Number(process.env.MD2WORD_PORT ?? 5175);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`[web-host] listening on http://127.0.0.1:${port}`);
}
