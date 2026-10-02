import { default as fastify } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HIGHLIGHT_STYLES, resolvePandocInfo, type ConvertOptions, type HighlightStyle } from '@md2word/core';
import { LogBuffer } from './lib/logger.js';
import { SettingsStore } from './lib/settings.js';
import { JobManager, type JobResult } from './lib/jobs.js';

export interface CreateServerOptions {
  /** 数据目录（.data）：jobs/settings/log；默认包根 ../.data */
  dataDir?: string;
  /** 静态托管目录（renderer dist）；缺省不托管（开发时由 Vite 服务） */
  staticDir?: string;
  /** 测试注入：不监听端口 */
  noListen?: never;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DEFAULT_SETTINGS: Record<string, unknown> = {
  toc: false,
  tocDepth: 3,
  numberSections: false,
  highlightStyle: 'pygments',
  offline: false,
  overwrite: false,
  recentFiles: [] as string[],
};

export async function createServer(opts: CreateServerOptions = {}) {
  const dataDir = resolve(opts.dataDir ?? join(REPO_ROOT, '.data'));
  mkdirSync(dataDir, { recursive: true });

  const logger = new LogBuffer();
  logger.attachFile(join(dataDir, 'md2word.log'));
  const settings = new SettingsStore(dataDir, DEFAULT_SETTINGS);
  const jobs = new JobManager(dataDir, logger);

  const app = fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  await app.register(multipart, {
    limits: { fileSize: 21 * 1024 * 1024, files: 50 },
  });

  // ---- 健康检查（M0 起步页链路） ----
  app.get('/api/health', async () => {
    const pandoc = await resolvePandocInfo();
    return { ok: true, name: 'md2word web-host', pandoc, pending: jobs.pendingCount, running: jobs.isRunning };
  });

  // ---- 转换（US1：上传 → 队列 → 结果） ----
  app.post('/api/convert', async (req, reply) => {
    const parts = req.parts();
    const jobDir = join(dataDir, 'jobs', randomUUID());
    mkdirSync(jobDir, { recursive: true });
    const names: string[] = [];
    let options: ConvertOptions = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        // 防路径穿越：只取 basename
        const safeName = part.filename.split(/[\\/]/).pop() ?? part.filename;
        const { writeFileSync } = await import('node:fs');
        const buf = await part.toBuffer();
        if (/\.(md|markdown|mdown|mkd)$/i.test(safeName)) {
          // 转换对象：重名附加序号，保留全部文件
          let finalName = safeName;
          let n = 1;
          while (names.includes(finalName)) finalName = `${++n}-${safeName}`;
          writeFileSync(join(jobDir, finalName), buf);
          names.push(finalName);
        } else {
          // 附带资源（图片等）：按原文件名保存到作业目录，
          // 供 md 内相对路径引用（Web 上传模式拖入资源即可内联）
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

    // 设置持久化的选项作为缺省，请求内 options 覆盖
    const merged: ConvertOptions = {
      toc: settings.all.toc === true,
      tocDepth: (settings.all.tocDepth as 1 | 2 | 3 | 4 | 5 | 6) ?? 3,
      numberSections: settings.all.numberSections === true,
      highlightStyle: (settings.all.highlightStyle as HighlightStyle) ?? 'pygments',
      offline: settings.all.offline === true,
      ...options,
    };

    const state = jobs.createJob(jobDir, names);
    logger.info(`job accepted: ${names.length} file(s), options=${JSON.stringify(merged)}`);
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

  // ---- 打开文件/目录（US1：点"打开"直接进 Word；打开所在文件夹） ----
  app.post('/api/open/:jobId/:name', async (req, reply) => {
    const { jobId, name } = req.params as { jobId: string; name: string };
    const dir = jobs.jobDir(jobId);
    if (!dir) {
      reply.code(404);
      return { ok: false, error: '作业不存在' };
    }
    const target = join(dir, decodeURIComponent(name));
    if (!target.startsWith(dir) || !existsSync(target)) {
      reply.code(404);
      return { ok: false, error: '文件不存在' };
    }
    const openFolder = (req.query as { folder?: string }).folder === '1';
    const ok = await jobs.openPath(openFolder ? dir : target, openFolder ? 'folder' : 'file');
    return { ok };
  });

  // ---- 设置（US6 持久化） ----
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
    settings.set(patch);
    logger.info(`settings updated: ${JSON.stringify(patch)}`);
    return settings.all;
  });

  // ---- 日志（US5：人话错误 + 一键导出） ----
  app.get('/api/log', async () => ({ lines: logger.exportText().split('\n').filter(Boolean) }));
  app.get('/api/log/export', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="md2word-log.txt"');
    return logger.exportText();
  });

  // ---- 静态托管 renderer（M4 起也由 Electron 复用同产物） ----
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : null;
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler(async (req, reply) => {
      // SPA 回退（非 /api 路径回 index.html）
      if (req.url.startsWith('/api')) {
        reply.code(404);
        return { ok: false, error: '接口不存在' };
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, logger, settings, jobs, dataDir };
}

const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  const { app } = await createServer();
  const port = Number(process.env.MD2WORD_PORT ?? 5175);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`[web-host] listening on http://127.0.0.1:${port}`);
}
