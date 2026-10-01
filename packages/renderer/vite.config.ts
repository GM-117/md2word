import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 端口固定 5173；/api 反代到本地 web-host（127.0.0.1:5175）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5175', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
