import { existsSync } from 'node:fs';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { resolvePandocInfo } from '@md2word/core';
import type { AppServices } from './context.js';
import { scanFolderForConvert } from './services/scan.js';

/**
 * IPC 白名单桥（开发计划 §2.1 / M4 计划 §M4-2）。
 * 全部通道在此集中注册；open 仅放行作业注册表登记过的产物；settings:set 校验失败抛人话错误。
 */
export function registerBridge(services: AppServices): void {
  ipcMain.handle('app:health', async () => {
    const pandoc = await resolvePandocInfo();
    return {
      ok: true,
      name: 'md2word desktop',
      pandoc,
      pending: services.convert.pendingCount,
      running: services.convert.isRunning,
    };
  });

  // 渲染层传入 clientBatchId（流式进度关联标记，M6+ 逐文件进度）时，逐项结果经
  // convert:progress 事件推送；事件即时反映单项落定，最终完整结果仍由 invoke 返回
  ipcMain.handle('convert:batch', (event, entries: unknown, options: unknown) => {
    const opts = (options && typeof options === 'object' ? options : {}) as { clientBatchId?: unknown };
    const batchId = typeof opts.clientBatchId === 'string' && opts.clientBatchId ? opts.clientBatchId : null;
    const sender = event.sender;
    return services.convert.run(
      entries as Parameters<typeof services.convert.run>[0],
      options as Parameters<typeof services.convert.run>[1],
      batchId
        ? (index, item, jobId) => {
            if (!sender.isDestroyed()) sender.send('convert:progress', { batchId, jobId, index, item });
          }
        : undefined,
    );
  });

  ipcMain.handle('convert:file', (_event, entry: unknown, options: unknown) =>
    services.convert.run([entry] as Parameters<typeof services.convert.run>[0], options as Parameters<typeof services.convert.run>[1]),
  );

  ipcMain.handle('convert:cancel', () => {
    const cancelled = services.convert.cancelAll();
    return { ok: true, cancelled };
  });

  // M6 批量转换：原生文件夹选择对话框 + 递归扫描（排除隐藏/非 .md/node_modules）
  ipcMain.handle('dialog:pickFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = { title: '选择要批量转换的文件夹', properties: ['openDirectory'] };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false };
    return { ok: true, path: picked.filePaths[0] };
  });

  ipcMain.handle('convert:scanFolder', (_event, folderPath: unknown) => {
    const result = scanFolderForConvert(folderPath);
    services.logger.info(
      `folder scanned: ${result.root} → ${result.files.length} md file(s), dirs=${result.scannedDirs}${result.truncated ? ' (truncated)' : ''}`,
    );
    return result;
  });

  ipcMain.handle('settings:get', () => services.settings.all);

  ipcMain.handle('settings:set', (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('设置必须是 JSON 对象');
    }
    const result = services.settings.set(patch as Record<string, unknown>);
    if (!result.ok) throw new Error(result.error);
    return services.settings.all;
  });

  ipcMain.handle('open:path', async (_event, jobId: string, name: string, folder: boolean) => {
    const resolved = services.registry.resolve(String(jobId ?? ''), String(name ?? ''));
    if (!resolved) {
      services.logger.warn(`open refused: 未登记的产物 ${String(jobId)}/${String(name)}`);
      return false;
    }
    if (folder) {
      shell.showItemInFolder(resolved.outputPath);
      services.logger.info(`revealed in folder: ${resolved.outputPath}`);
      return true;
    }
    const error = await shell.openPath(resolved.outputPath);
    if (error) {
      services.logger.warn(`open failed: ${resolved.outputPath} ${error}`);
      return false;
    }
    services.logger.info(`opened: ${resolved.outputPath}`);
    return true;
  });

  ipcMain.handle('template:list', () => services.templates.list());

  ipcMain.handle('template:add', (_event, name: unknown, bytes: unknown) =>
    services.templates.add(String(name ?? ''), bytes instanceof Uint8Array ? bytes : new Uint8Array(0)),
  );

  ipcMain.handle('template:delete', (_event, name: unknown) => services.templates.delete(String(name ?? '')));

  ipcMain.handle('template:summary', (_event, id: unknown) => services.templates.describeTemplate(String(id ?? '')));

  // 最近文件"点击重新转换"：源路径来自转换服务登记的 recentPaths（白名单数据，非用户输入路径）
  ipcMain.handle('convert:reconvert', (_event, name: unknown) => {
    const n = String(name ?? '');
    const paths = (services.settings.all.recentPaths ?? {}) as Record<string, string>;
    const p = paths[n];
    if (!p || !existsSync(p)) {
      throw new Error(`找不到该文件的源路径，可能已被移动或删除：${p ?? n}`);
    }
    return services.convert.run([{ name: n, path: p }], {});
  });
}
