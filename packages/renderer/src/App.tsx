import { useCallback, useEffect, useRef, useState } from 'react';
import { transport, type ConvertItemResult, type ConvertOptionsPayload, type Health, type TemplateInfo } from './lib/transport';

interface RowState {
  key: string;
  name: string;
  status: 'converting' | 'done' | 'failed';
  result?: ConvertItemResult;
  jobId?: string;
}

const HIGHLIGHT_OPTIONS = ['pygments', 'tango', 'espresso', 'zenburn', 'kate', 'monochrome'];

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo | null>(null);
  const [templateMsg, setTemplateMsg] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);

  const [options, setOptions] = useState<ConvertOptionsPayload>({
    toc: false,
    tocDepth: 3,
    numberSections: false,
    highlightStyle: 'pygments',
    offline: false,
    overwrite: false,
    template: 'builtin-zh',
    metadata: { title: '', author: '' },
  });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const refreshTemplates = useCallback(() => {
    transport.listTemplates().then((t) => {
      setTemplates(t);
      setOptions((prev) => ({ ...prev, template: (t.defaultTemplate as string) ?? prev.template }));
    }).catch(() => undefined);
  }, []);

  // 启动：健康检查 + 恢复持久化设置（US6）+ 模板列表
  useEffect(() => {
    transport.health()
      .then(setHealth)
      .catch((e: unknown) => setBridgeError(e instanceof Error ? e.message : String(e)));
    transport.getSettings()
      .then((s) => setOptions((prev) => ({
        toc: s.toc === true,
        tocDepth: typeof s.tocDepth === 'number' ? s.tocDepth : prev.tocDepth,
        numberSections: s.numberSections === true,
        highlightStyle: typeof s.highlightStyle === 'string' ? s.highlightStyle : prev.highlightStyle,
        offline: s.offline === true,
        overwrite: s.overwrite === true,
        template: typeof s.defaultTemplate === 'string' ? s.defaultTemplate : prev.template,
        metadata: {
          title: typeof s.metaTitle === 'string' ? s.metaTitle : '',
          author: typeof s.metaAuthor === 'string' ? s.metaAuthor : '',
        },
      })))
      .catch(() => undefined);
    transport.getSettings().then((s) => {
      if (Array.isArray(s.recentFiles)) setRecentFiles(s.recentFiles as string[]);
    }).catch(() => undefined);
    refreshTemplates();
  }, [refreshTemplates]);

  const patchOptions = useCallback((patch: Partial<ConvertOptionsPayload>) => {
    setOptions((prev) => ({ ...prev, ...patch }));
    void transport.saveSettings(patch as Record<string, unknown>).catch(() => undefined);
  }, []);

  const patchMeta = useCallback((patch: { title?: string; author?: string }) => {
    setOptions((prev) => ({ ...prev, metadata: { ...prev.metadata, ...patch } }));
    // 元数据即时保存（防抖语义由输入节奏决定；服务端合并幂等）
    const settingsPatch: Record<string, unknown> = {};
    if (patch.title !== undefined) settingsPatch.metaTitle = patch.title;
    if (patch.author !== undefined) settingsPatch.metaAuthor = patch.author;
    void transport.saveSettings(settingsPatch).catch(() => undefined);
  }, []);

  const convertFiles = useCallback(async (fileList: FileList | File[]) => {
    const all = Array.from(fileList);
    const mdFiles = all.filter((f) => /\.(md|markdown|mdown|mkd)$/i.test(f.name));
    const resourceFiles = all.filter((f) => !/\.(md|markdown|mdown|mkd)$/i.test(f.name));
    if (mdFiles.length === 0) {
      setLog(['未选择任何 .md 文件（支持 .md/.markdown/.mdown/.mkd）；其余文件已忽略。']);
      return;
    }
    setBusy(true);
    setLog(null);
    try { await transport.saveSettings({ ...optionsRef.current, metaTitle: optionsRef.current.metadata?.title ?? '', metaAuthor: optionsRef.current.metadata?.author ?? '' }); } catch { /* 保存失败不阻断转换 */ }
    const newKeys = mdFiles.map((f) => ({ key: `${f.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name }));
    setRows((prev) => [
      ...prev,
      ...newKeys.map((k) => ({ ...k, status: 'converting' as const })),
    ]);
    // 最近文件（US6/P1：成功失败都记录，上限 10）
    setRecentFiles((prev) => {
      const next = [...mdFiles.map((f) => f.name), ...prev.filter((n) => !mdFiles.some((f) => f.name === n))].slice(0, 10);
      void transport.saveSettings({ recentFiles: next }).catch(() => undefined);
      return next;
    });

    try {
      const job = await transport.convert([...mdFiles, ...resourceFiles], optionsRef.current);
      setRows((prev) => prev.map((r) => {
        const idx = newKeys.findIndex((k) => k.key === r.key);
        if (idx === -1) return r;
        const item = job.items[idx];
        return item
          ? { ...r, status: item.ok ? 'done' : 'failed', result: item, jobId: job.jobId }
          : { ...r, status: 'failed', result: { ok: false, durationMs: 0, warnings: [], name: r.name, error: { code: 'E_BRIDGE', message: '服务端未返回该文件的结果' } } };
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRows((prev) => prev.map((r) => (
        newKeys.some((k) => k.key === r.key)
          ? {
              ...r,
              status: 'failed',
              result: { ok: false, durationMs: 0, warnings: [], name: r.name, error: { code: 'E_BRIDGE', message } },
            }
          : r
      )));
    }
    setBusy(false);
  }, []);

  const importTemplate = useCallback(async (file: File) => {
    setTemplateMsg(null);
    const res = await transport.uploadTemplate(file);
    if (res.ok) {
      setTemplateMsg(`模板“${res.name}”导入成功`);
      refreshTemplates();
    } else {
      setTemplateMsg(res.error ?? '模板导入失败');
    }
  }, [refreshTemplates]);

  const openResult = useCallback(async (row: RowState, folder: boolean) => {
    if (!row.jobId || !row.result) return;
    await transport.open(row.jobId, row.result.name, folder);
  }, []);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>md2word</h1>
          <p className="sub">
            {bridgeError
              ? <span className="err">web-host 桥接失败：{bridgeError}</span>
              : health
                ? <>桥接正常 · pandoc {health.pandoc?.version ?? '未定位'}（{health.pandoc?.source ?? '-'}）{busy ? ' · 队列转换中…' : ''}</>
                : '正在连接 web-host…'}
          </p>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => void transport.cancel()}>取消队列</button>
          <a className="button" href={transport.exportLogUrl()} target="_blank" rel="noreferrer">导出日志</a>
        </div>
      </header>

      {recentFiles.length > 0 && (
        <div className="recent">
          <span className="recent-label">最近文件：</span>
          {recentFiles.slice(0, 6).map((n) => <span key={n} className="recent-chip" title={n}>{n}</span>)}
        </div>
      )}

      <div className="layout">
        <section className="left">
          <div
            className={dragOver ? 'dropzone drag' : 'dropzone'}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length > 0) void convertFiles(e.dataTransfer.files);
            }}
          >
            <p className="dropzone-main">把 .md 拖到这里</p>
            <p className="dropzone-sub">可连同图片资源一起拖入；或</p>
            <label className="button primary">
              选择文件（可多选）
              <input
                type="file"
                multiple
                accept=".md,.markdown,.mdown,.mkd,image/*"
                onChange={(e) => { if (e.target.files) void convertFiles(e.target.files); e.target.value = ''; }}
              />
            </label>
          </div>

          <div className="panel">
            <h2>转换选项</h2>
            <label className="opt">
              <input type="checkbox" checked={options.toc} onChange={(e) => patchOptions({ toc: e.target.checked })} />
              生成目录（TOC）
            </label>
            {options.toc && (
              <label className="opt indent">
                目录层级
                <select value={options.tocDepth} onChange={(e) => patchOptions({ tocDepth: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
            <label className="opt">
              <input type="checkbox" checked={options.numberSections} onChange={(e) => patchOptions({ numberSections: e.target.checked })} />
              章节编号
            </label>
            <label className="opt indent">
              高亮风格
              <select value={options.highlightStyle} onChange={(e) => patchOptions({ highlightStyle: e.target.value })}>
                {HIGHLIGHT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="opt">
              <input type="checkbox" checked={options.offline} onChange={(e) => patchOptions({ offline: e.target.checked })} />
              离线模式（不抓取远程图片）
            </label>
            <label className="opt">
              <input type="checkbox" checked={options.overwrite} onChange={(e) => patchOptions({ overwrite: e.target.checked })} />
              覆盖同名输出
            </label>
            <p className="hint">选项改动即时生效并保存（下次打开自动恢复）</p>
          </div>

          <div className="panel">
            <h2>文档模板</h2>
            <label className="opt" style={{ justifyContent: 'space-between' }}>
              模板
              <select
                value={options.template}
                onChange={(e) => patchOptions({ template: e.target.value })}
              >
                {templates?.builtin && <option value={templates.builtin.id}>{templates.builtin.name}</option>}
                <option value="pandoc-default">{templates?.pandocDefault.name ?? 'pandoc 默认样式'}</option>
                {templates?.user.filter((t) => t.valid).map((t) => (
                  <option key={t.name} value={t.name}>{t.name}（自定义）</option>
                ))}
              </select>
            </label>
            <label className="opt">
              <span className="button">
                导入 reference.docx 模板
                <input
                  type="file"
                  accept=".docx"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importTemplate(f);
                    e.target.value = '';
                  }}
                />
              </span>
            </label>
            {templateMsg && <p className={templateMsg.includes('成功') ? 'hint' : 'err'}>{templateMsg}</p>}
          </div>

          <div className="panel">
            <h2>元数据（可选）</h2>
            <p className="hint">填写后将写入 Word 文档属性；留空则使用 md 内 YAML front matter（若有）。</p>
            <label className="opt meta">
              标题
              <input
                type="text"
                value={options.metadata?.title ?? ''}
                placeholder="文档标题"
                onChange={(e) => patchMeta({ title: e.target.value })}
              />
            </label>
            <label className="opt meta">
              作者
              <input
                type="text"
                value={options.metadata?.author ?? ''}
                placeholder="作者名"
                onChange={(e) => patchMeta({ author: e.target.value })}
              />
            </label>
          </div>
        </section>

        <section className="right">
          <h2>转换队列与结果</h2>
          {rows.length === 0 && <p className="empty">还没有任务。拖入 .md 开始。</p>}
          {rows.map((row) => (
            <article key={row.key} className={`row ${row.status}`}>
              <div className="row-head">
                <span className="name">{row.name}</span>
                <span className="badge">{row.status === 'converting' ? '转换中…' : row.status === 'done' ? `成功 ${row.result?.durationMs}ms` : '失败'}</span>
              </div>

              {row.status === 'done' && (
                <div className="row-body">
                  <div className="stats">
                    {row.result?.stats && (
                      <>标题 {row.result.stats.headings} · 表格 {row.result.stats.tables} · 图片 {row.result.stats.images} · 公式 {row.result.stats.math} · 脚注 {row.result.stats.footnotes} · 代码块 {row.result.stats.codeBlocks}</>
                    )}
                  </div>
                  {row.result?.warnings.map((w, i) => (
                    <p key={i} className="warn">⚠ {w.message}</p>
                  ))}
                  <div className="actions">
                    <a className="button" href={row.result?.downloadUrl}>下载 .docx</a>
                    <button type="button" onClick={() => void openResult(row, false)}>打开</button>
                    <button type="button" onClick={() => void openResult(row, true)}>打开所在文件夹</button>
                  </div>
                </div>
              )}

              {row.status === 'failed' && (
                <div className="row-body">
                  <p className="err">{row.result?.error?.message ?? '未知错误'}</p>
                  <details>
                    <summary>错误详情（错误码 {row.result?.error?.code}）</summary>
                    <pre>{row.result?.error?.stderrTail ?? '（无 pandoc 原文）'}</pre>
                  </details>
                </div>
              )}
            </article>
          ))}
        </section>
      </div>

      {log && (
        <pre className="logbox">{log.join('\n')}</pre>
      )}
    </main>
  );
}
