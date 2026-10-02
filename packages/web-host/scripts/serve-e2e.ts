// Playwright webServer 启动器：静态托管 renderer dist + 独立 .data-e2e 数据目录
import { createServer } from '../src/server.js';

const port = Number(process.env.MD2WORD_PORT ?? 5199);
const { app } = await createServer({
  dataDir: '.data-e2e',
  staticDir: '../renderer/dist',
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`[serve-e2e] listening on http://127.0.0.1:${port}`);
