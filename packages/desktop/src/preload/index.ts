import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * 预加载桥（contextIsolation: true / sandbox: true）：仅暴露白名单方法，无 Node 权限。
 * 与 renderer lib/transport.ts 的 Md2WordBridge 类型一一对应。
 */
contextBridge.exposeInMainWorld('md2word', {
  platform: process.platform,
  health: () => ipcRenderer.invoke('app:health'),
  convert: (entries: unknown, options: unknown) => ipcRenderer.invoke('convert:batch', entries, options),
  cancel: () => ipcRenderer.invoke('convert:cancel'),
  // M6+ 流式进度：主进程 convert:progress 事件 → 渲染层回调；返回退订函数
  onConvertProgress: (callback: (evt: unknown) => void) => {
    const listener = (_event: unknown, evt: unknown): void => callback(evt);
    ipcRenderer.on('convert:progress', listener);
    return (): void => {
      ipcRenderer.removeListener('convert:progress', listener);
    };
  },
  // D37 下载反馈：保存完成/失败 → 渲染层 toast；返回退订函数
  onDownloadFeedback: (callback: (feedback: { ok: boolean; filename: string; savedPath?: string }) => void) => {
    const listener = (_event: unknown, feedback: { ok: boolean; filename: string; savedPath?: string }): void =>
      callback(feedback);
    ipcRenderer.on('download:feedback', listener);
    return (): void => {
      ipcRenderer.removeListener('download:feedback', listener);
    };
  },
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  scanFolder: (folderPath: string) => ipcRenderer.invoke('convert:scanFolder', folderPath),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  open: (jobId: string, name: string, folder: boolean) => ipcRenderer.invoke('open:path', jobId, name, folder),
  listTemplates: () => ipcRenderer.invoke('template:list'),
  uploadTemplate: (name: string, bytes: Uint8Array) => ipcRenderer.invoke('template:add', name, bytes),
  deleteTemplate: (name: string) => ipcRenderer.invoke('template:delete', name),
  templateSummary: (id: string) => ipcRenderer.invoke('template:summary', id),
  reconvert: (name: string) => ipcRenderer.invoke('convert:reconvert', name),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});
