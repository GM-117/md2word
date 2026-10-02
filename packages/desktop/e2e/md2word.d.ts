// 桌面 E2E 用的最小桥类型（完整契约见 packages/renderer/src/lib/transport.ts 的 Md2WordBridge）
export {};

declare global {
  interface Window {
    md2word?: {
      platform: string;
      convert(
        entries: Array<{ name: string; path?: string; bytes?: Uint8Array }>,
        options: Record<string, unknown>,
      ): Promise<{ jobId: string; items: Array<{ ok: boolean; outputPath?: string }> }>;
    };
  }
}
