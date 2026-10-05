import './sidecar.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, protocol, session } from 'electron';
import { createServices, type AppServices } from './context.js';
import { registerBridge } from './bridge.js';
import { parseResourceUrl } from './services/resourceUrl.js';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
/** E2E / 开发态模拟打包加载：显式指定 renderer 构建产物目录 */
const RENDERER_DIST = process.env.MD2WORD_RENDERER_DIST;

// 特权协议：app 托管 renderer（Vite ES module 在 file:// 下被 CORS 拦截）；md2word 承载产物下载/日志导出
// （两者都必须在 app ready 前 registerSchemesAsPrivileged）
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'md2word', privileges: { standard: true, secure: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;

// userData 重置必须先于单实例锁：锁按 userData 落位，否则开发/E2E 实例会与已安装的应用互相顶掉（D27）
if (process.env.MD2WORD_USER_DATA) app.setPath('userData', process.env.MD2WORD_USER_DATA);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setName('md2word');

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap);
}

async function bootstrap(): Promise<void> {
  services = await createServices({
    userDataDir: app.getPath('userData'),
    resourcesDir: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
  services.logger.info(`app start: version=${app.getVersion()} packaged=${app.isPackaged} userData=${app.getPath('userData')}`);

  registerAppProtocol();
  registerResourceProtocol();
  registerDownloadBehavior();
  registerBridge(services);
  app.setAboutPanelOptions({
    applicationName: 'md2word',
    applicationVersion: app.getVersion(),
    credits:
      'Markdown → Word（pandoc 3.12 sidecar）\n\npandoc 为 GPL-2.0+ 独立子进程，\n许可证全文与源码地址见应用资源目录 THIRD-PARTY-LICENSES.md。',
  });

  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
};

/** app://bundle/* → renderer 产物（打包态 = Resources/renderer；开发/E2E = MD2WORD_RENDERER_DIST） */
function registerAppProtocol(): void {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'renderer')
    : RENDERER_DIST ?? '';
  if (!root || !existsSync(join(root, 'index.html'))) {
    throw new Error(`renderer 产物不存在：${root || '(未设置)'}（打包缺 extraResources？开发请设 MD2WORD_RENDERER_DIST）`);
  }
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = join(root, rel);
    if (!filePath.startsWith(root)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const body = readFileSync(filePath);
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      return new Response(body, {
        headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 1024,
    minHeight: 640,
    title: 'md2word',
    show: false,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // 渲染层加载：dev server > app:// 特权协议（打包资源 / 显式 dist）
  if (DEV_SERVER_URL) {
    await win.loadURL(DEV_SERVER_URL);
  } else {
    await win.loadURL('app://bundle/index.html');
  }

  // 安全基线：窗口全拒；导航全拒（md2word:// 放行 → 协议 handler 返回 attachment → Chromium 下载，页面不跳转）
  win.webContents.setWindowOpenHandler(({ url }) => {
    const resource = parseResourceUrl(url);
    if (resource?.kind === 'log') void handleLogExport();
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!parseResourceUrl(url)) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    services?.logger.warn(`permission denied: ${permission}`);
    callback(false);
  });
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * md2word://download/<jobId>/<name> 与 md2word://log/export 的承载。
 * 一律返回 attachment 响应（页面永不导航）：登记产物 → 文件流；
 * 未登记/非法 → 空 attachment，由 will-download 闸门取消（D25：若返回 404 裸响应，
 * Chromium 会把页面导航到错误文本页）。
 */
function registerResourceProtocol(): void {
  const rejected = () =>
    new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('rejected.txt')}` },
    });
  protocol.handle('md2word', async (request) => {
    const resource = parseResourceUrl(request.url);
    const svc = services;
    if (!resource || !svc) return rejected();
    try {
      if (resource.kind === 'log') {
        return new Response(svc.logger.exportText(), {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('md2word-log.txt')}`,
          },
        });
      }
      if (resource.kind === 'template') {
        if (!svc.templates.templateExists(resource.id)) {
          svc.logger.warn(`template export refused: ${resource.id}`);
          return rejected();
        }
        const resolved = await svc.templates.resolveTemplatePath(resource.id);
        if (!resolved) return rejected();
        svc.logger.info(`template exported via md2word://: ${resolved.path}`);
        return new Response(readFileSync(resolved.path), {
          headers: {
            'content-type': DOCX_MIME,
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${resolved.label}.docx`)}`,
          },
        });
      }
      const output = svc.registry.resolveKey(resource.jobId, resource.name);
      if (!output) {
        svc.logger.warn(`download refused: 未登记的产物 ${resource.jobId}/${resource.name}`);
        return rejected();
      }
      svc.logger.info(`download via md2word://: ${output}`);
      return new Response(readFileSync(output), {
        headers: {
          'content-type': DOCX_MIME,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(resource.name)}`,
        },
      });
    } catch (err) {
      svc.logger.error(`resource handling failed: ${err instanceof Error ? err.message : String(err)}`);
      return rejected();
    }
  });
}

/** 导出日志（顶栏"导出日志"锚点 target=_blank → setWindowOpenHandler 拦截 → 存盘对话框写出） */
async function handleLogExport(): Promise<void> {
  if (!services || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出日志',
      defaultPath: 'md2word-log.txt',
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return;
    writeFileSync(filePath, services.logger.exportText(), 'utf8');
    services.logger.info(`log exported: ${filePath}`);
    notifyRenderer({ ok: true, filename: 'md2word-log.txt', savedPath: filePath });
  } catch (err) {
    services.logger.error(`log export failed: ${err instanceof Error ? err.message : String(err)}`);
    notifyRenderer({ ok: false, filename: 'md2word-log.txt' });
  }
}

/**
 * md2word:// 下载的落盘策略与安全闸门：
 * - 未登记的产物（伪造/失效链接）：preventDefault 取消下载——页面不跳转、不产生文件（D25）；
 * - MD2WORD_DOWNLOAD_DIR（E2E）：确定性落盘到该目录，避免原生对话框阻塞自动化；
 * - 默认（生产）：不干预，Electron 弹原生保存对话框。
 */
function registerDownloadBehavior(): void {
  const e2eDir = process.env.MD2WORD_DOWNLOAD_DIR;
  session.defaultSession.on('will-download', (event, item) => {
    const resource = parseResourceUrl(item.getURL());
    if (!resource) return; // 非 md2word 资源走默认行为
    const unregistered =
      (resource.kind === 'download' && !services?.registry.resolveKey(resource.jobId, resource.name)) ||
      (resource.kind === 'template' && !services?.templates.templateExists(resource.id));
    if (unregistered) {
      services?.logger.warn(`download cancelled (will-download): ${item.getURL()}`);
      event.preventDefault();
      return;
    }
    services?.logger.info(`will-download: ${item.getFilename()}`);
    if (e2eDir) {
      item.setSavePath(join(e2eDir, `${Date.now()}-${item.getFilename()}`));
    }
    // 保存结果反馈（D33）：完成/失败推送 toast；用户在保存对话框主动取消（cancelled）则不打扰
    item.once('done', (_e, state) => {
      if (state === 'cancelled') return;
      const ok = state === 'completed';
      const savedPath = ok ? item.getSavePath() : undefined;
      services?.logger[ok ? 'info' : 'error'](
        `download ${state}: ${item.getFilename()}${savedPath ? ` → ${savedPath}` : ''}`,
      );
      notifyRenderer({ ok, filename: item.getFilename(), savedPath });
    });
  });
}

/** 下载结果反馈 → 渲染层 toast（保存成功/失败即时确认，免去用户到目录人工核对） */
function notifyRenderer(feedback: { ok: boolean; filename: string; savedPath?: string }): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download:feedback', feedback);
  }
}
