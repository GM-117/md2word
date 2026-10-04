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
