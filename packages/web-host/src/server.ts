import { resolvePandocInfo } from '@md2word/core';

export async function createServer() {
  const { default: fastify } = await import('fastify');
  const app = fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });

  app.get('/api/health', async () => {
    const info = await resolvePandocInfo();
    return { ok: true, name: 'md2word web-host', pandoc: info };
  });

  return app;
}

const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  const app = await createServer();
  const port = Number(process.env.MD2WORD_PORT ?? 5175);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`[web-host] listening on http://127.0.0.1:${port}`);
}
