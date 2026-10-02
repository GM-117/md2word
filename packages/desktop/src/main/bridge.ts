import { ipcMain, shell } from 'electron';
import { resolvePandocInfo } from '@md2word/core';
import type { AppServices } from './context.js';

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

  ipcMain.handle('convert:batch', (_event, entries: unknown, options: unknown) =>
    services.convert.run(entries as Parameters<typeof services.convert.run>[0], options as Parameters<typeof services.convert.run>[1]),
  );

  ipcMain.handle('convert:file', (_event, entry: unknown, options: unknown) =>
    services.convert.run([entry] as Parameters<typeof services.convert.run>[0], options as Parameters<typeof services.convert.run>[1]),
  );

  ipcMain.handle('convert:cancel', () => {
    const cancelled = services.convert.cancelAll();
    return { ok: true, cancelled };
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
}
