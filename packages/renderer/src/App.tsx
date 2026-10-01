import { useEffect, useState } from 'react';

interface Health {
  ok: boolean;
  name: string;
  pandoc: { version?: string; path?: string; source?: string } | null;
}

/** M0 起步页：验证 web-host 桥与 renderer 链路；M2 替换为完整界面。 */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Health>;
      })
      .then(setHealth)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="m0-shell">
      <h1>md2word</h1>
      <p className="m0-sub">Markdown → Word 桌面工具 · M0 骨架自检页</p>
      <section className="m0-card">
        {error && <p className="m0-err">web-host 桥接失败：{error}</p>}
        {!error && !health && <p>正在连接 web-host…</p>}
        {health && (
          <ul>
            <li>桥接服务：{health.name} ✓</li>
            <li>
              pandoc sidecar：
              {health.pandoc?.version
                ? `${health.pandoc.version}（${health.pandoc.source}）✓`
                : '未定位到 —— 请先运行 pnpm setup'}
            </li>
          </ul>
        )}
      </section>
    </main>
  );
}
