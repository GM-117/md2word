import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { transport, isDesktop, type ConvertItemResult, type ConvertOptionsPayload, type Health, type TemplateInfo, type TemplateStyleSummary } from './lib/transport';

interface RowState {
  key: string;
  name: string;
  status: 'converting' | 'done' | 'failed';
  result?: ConvertItemResult;
  jobId?: string;
}

const HIGHLIGHT_OPTIONS = ['pygments', 'tango', 'espresso', 'zenburn', 'kate', 'monochrome'];

const STAT_LABELS: Array<[string, string]> = [
  ['headings', '标题'],
  ['tables', '表格'],
  ['images', '图片'],
  ['math', '公式'],
  ['footnotes', '脚注'],
  ['codeBlocks', '代码块'],
];

/* ---------- 装饰性图标（均 aria-hidden） ---------- */

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const IconSliders = () => (
  <Icon>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  </Icon>
);
const IconLayout = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </Icon>
);
const IconTag = () => (
  <Icon>
    <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
    <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
  </Icon>
);
const IconList = () => (
  <Icon>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Icon>
);
const IconUpload = () => (
  <Icon>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </Icon>
);
const IconCheck = () => (
  <Icon size={13}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);
const IconX = ({ size = 13 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);
const IconAlert = () => (
  <Icon size={13}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" />
  </Icon>
);
const IconDocArrow = () => (
  <Icon size={26}>
    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h5" />
    <path d="M9 14h5M12 11.5 14.5 14 12 16.5" />
  </Icon>
);
const IconBrand = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M8.5 13.5h6M12 10.5l3 3-3 3" />
  </svg>
);

/* 队列空态插画 */
function EmptyArt() {
  return (
    <svg className="empty-art" width="150" height="122" viewBox="0 0 150 122" fill="none" aria-hidden="true">
      <rect className="il-doc2" x="36" y="6" width="66" height="84" rx="8" />
      <rect className="il-doc" x="52" y="20" width="66" height="88" rx="8" />
      <path className="il-line" d="M63 42h42M63 56h32M63 70h24" />
      <path className="il-arrow" d="M6 62h28M34 62l-8-8M34 62l-8 8" />
      <circle className="il-badge" cx="116" cy="98" r="17" />
      <text className="il-w" x="116" y="103" textAnchor="middle">W</text>
    </svg>
  );
}

/* 高亮风格示意色板（近似 pygments 同名风格；提示用户以 Word 打开为准） */const HL_PALETTES: Record<string, { bg: string; text: string; kw: string; str: string; com: string; num: string }> = {
  pygments: { bg: '#f6f8fa', text: '#24292f', kw: '#cf222e', str: '#0a3069', com: '#6e7781', num: '#0550ae' },
  tango: { bg: '#faf8ef', text: '#2e3436', kw: '#204a87', str: '#4e9a06', com: '#8f5902', num: '#0000cf' },
  espresso: { bg: '#fffef7', text: '#33312e', kw: '#a61717', str: '#4070a0', com: '#bc7a00', num: '#40a070' },
  zenburn: { bg: '#3f3f3f', text: '#dcdccc', kw: '#f0dfaf', str: '#cc9393', com: '#7f9f7f', num: '#dca3a3' },
  kate: { bg: '#ffffff', text: '#1f1c1b', kw: '#0057ae', str: '#bf0303', com: '#898887', num: '#b08000' },
  monochrome: { bg: '#ffffff', text: '#000000', kw: '#000000', str: '#000000', com: '#000000', num: '#000000' },
};

/** 高亮风格示意预览：让用户在选择前看到该风格下代码的大致着色（非像素级还原） */
function HLPreview({ style }: { style: string }) {
  const p = HL_PALETTES[style] ?? HL_PALETTES.pygments!;
  return (
    <div className="hl-preview" style={{ background: p.bg, color: p.text } as CSSProperties} aria-hidden="true">
      <code>
        <span style={{ color: p.kw, fontWeight: 600 }}>def</span> greet(name):
        <br />
        {'    '}
        <span style={{ color: p.com, fontStyle: 'italic' }}># 打招呼并返回问候语</span>
        <br />
        {'    '}
        count = <span style={{ color: p.num }}>3</span>
        <br />
        {'    '}
        <span style={{ color: p.kw, fontWeight: 600 }}>return</span> <span style={{ color: p.str }}>f"你好，{'{name}'}！"</span>
      </code>
      <p className="hl-preview-note">高亮风格示意（{style}），实际效果以 Word 打开为准</p>
    </div>
  );
}

/** 样式字体 → CSS font-family；preferEastAsia=true（中文正文）中文字体在前，false（代码）西文字体在前 */
function cssFont(s?: { font?: string; eastAsia?: string }, preferEastAsia = true): string | undefined {
  if (!s) return undefined;
  const parts = (preferEastAsia ? [s.eastAsia, s.font] : [s.font, s.eastAsia]).filter(Boolean) as string[];
  return parts.length > 0 ? parts.map((f) => `"${f}"`).join(', ') : undefined;
}

/** 字体显示名（常见中文字体映射，其余原样） */
function cnFont(s?: { font?: string; eastAsia?: string }, preferEastAsia = true): string {
  const raw = preferEastAsia ? (s?.eastAsia ?? s?.font ?? '') : (s?.font ?? s?.eastAsia ?? '');
  const map: Record<string, string> = { SimSun: '宋体', SimHei: '黑体', KaiTi: '楷体', FangSong: '仿宋', 'Microsoft YaHei': '微软雅黑' };
  return map[raw] ?? raw;
}

function trimSpacing(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

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
  const [recentPaths, setRecentPaths] = useState<Record<string, string>>({});
  const [tplSummary, setTplSummary] = useState<TemplateStyleSummary | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

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
      if (isDesktop && s.recentPaths && typeof s.recentPaths === 'object') {
        setRecentPaths(s.recentPaths as Record<string, string>);
      }
    }).catch(() => undefined);
    refreshTemplates();
  }, [refreshTemplates]);

  // 模板样式概览（桌面端）：随模板选择变化
  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    window.md2word!.templateSummary(options.template ?? 'builtin-zh')
      .then((s) => { if (alive) setTplSummary(s); })
      .catch(() => { if (alive) setTplSummary(null); });
    return () => { alive = false; };
  }, [options.template, templates]);

  const patchOptions = useCallback((patch: Partial<ConvertOptionsPayload>) => {
    setOptions((prev) => ({ ...prev, ...patch }));
    // 模板选择对应服务端的 defaultTemplate 设置；其余键按原名保存
    const { template, ...rest } = patch;
    if (template !== undefined) {
      void transport.saveSettings({ defaultTemplate: template }).catch(() => undefined);
    }
    if (Object.keys(rest).length > 0) {
      void transport.saveSettings(rest as Record<string, unknown>).catch(() => undefined);
    }
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
    // 转换前把当前选项完整落盘（白名单键，避免垃圾键写入 settings），并消除保存与转换的竞态
    try {
      await transport.saveSettings({
        toc: optionsRef.current.toc ?? false,
        tocDepth: optionsRef.current.tocDepth ?? 3,
        numberSections: optionsRef.current.numberSections ?? false,
        highlightStyle: optionsRef.current.highlightStyle ?? 'pygments',
        offline: optionsRef.current.offline ?? false,
        overwrite: optionsRef.current.overwrite ?? false,
        defaultTemplate: optionsRef.current.template ?? 'builtin-zh',
        metaTitle: optionsRef.current.metadata?.title ?? '',
        metaAuthor: optionsRef.current.metadata?.author ?? '',
      });
    } catch { /* 保存失败不阻断转换 */ }
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
      // options 只传转换语义键：template 已换名为 defaultTemplate 设置，由服务端解析模板路径
      const { template: _tpl, ...convertOptions } = optionsRef.current;
      void _tpl;
      const job = await transport.convert([...mdFiles, ...resourceFiles], convertOptions);
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

  const clearRows = useCallback(() => { if (!busy) setRows([]); }, [busy]);

  // 取消队列：中断正在进行的 pandoc 转换并清空等待任务；空闲时给出说明性反馈
  const cancelQueue = useCallback(async () => {
    try {
      const { cancelled } = await transport.cancel();
      showToast(cancelled > 0 ? `已请求取消：中断了 ${cancelled} 个转换任务` : '当前没有进行中的转换任务');
    } catch {
      showToast('取消请求发送失败，请确认 web-host 正在运行');
    }
  }, [showToast]);

  // 删除单条最近文件记录（同步持久化到设置）
  const removeRecent = useCallback((name: string) => {
    setRecentFiles((prev) => {
      const next = prev.filter((n) => n !== name);
      void transport.saveSettings({ recentFiles: next }).catch(() => undefined);
      return next;
    });
  }, []);

  // 最近文件点击重新转换（桌面端）：主进程按登记的源路径 + 当前选项转换，结果照常进入队列列表
  const reconvertRecent = useCallback(async (name: string) => {
    if (busy) return;
    setBusy(true);
    setLog(null);
    const key = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setRows((prev) => [...prev, { key, name, status: 'converting' as const }]);
    try {
      const job = await window.md2word!.reconvert(name);
      const item = job.items[0];
      setRows((prev) => prev.map((r) => (r.key === key
        ? item
          ? { ...r, status: item.ok ? 'done' as const : 'failed' as const, result: item, jobId: job.jobId }
          : { ...r, status: 'failed' as const, result: { ok: false, durationMs: 0, warnings: [], name, error: { code: 'E_BRIDGE', message: '服务端未返回该文件的结果' } } }
        : r)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRows((prev) => prev.map((r) => (r.key === key
        ? { ...r, status: 'failed' as const, result: { ok: false, durationMs: 0, warnings: [], name, error: { code: 'E_BRIDGE', message } } }
        : r)));
    }
    setBusy(false);
    // 转换后主进程可能已刷新 recentPaths 登记，轻量拉取一次用于 tooltip
    void transport.getSettings().then((s) => {
      if (s.recentPaths && typeof s.recentPaths === 'object') setRecentPaths(s.recentPaths as Record<string, string>);
    }).catch(() => undefined);
  }, [busy]);

  const doneCount = rows.filter((r) => r.status === 'done').length;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true"><IconBrand /></div>
          <div>
            <h1>md2word</h1>
            <p className="sub">
              {bridgeError
                ? <span className="err">web-host 桥接失败：{bridgeError}</span>
                : health
                  ? <>
                      <span className={`status-dot ${busy ? 'busy' : ''}`} aria-hidden="true" />
                      <span>桥接正常 · pandoc {health.pandoc?.version ?? '未定位'}（{health.pandoc?.source ?? '-'}）{busy ? ' · 队列转换中…' : ''}</span>
                    </>
                  : <>
                      <span className="status-dot wait" aria-hidden="true" />
                      <span>正在连接 web-host…</span>
                    </>}
            </p>
          </div>
        </div>
        <div className="topbar-actions">
          {busy && (
            <button
              type="button"
              title="中断正在进行的转换并清空等待中的任务"
              onClick={() => void cancelQueue()}
            >
              取消转换
            </button>
          )}
        </div>
      </header>

      {recentFiles.length > 0 && (
        <div className="recent">
          <span className="recent-label">最近文件：</span>
          {recentFiles.slice(0, 6).map((n) => (
            <span key={n} className="recent-chip">
              {isDesktop ? (
                <button
                  type="button"
                  className="chip-name"
                  title={recentPaths[n] ? `点击用当前选项重新转换\n${recentPaths[n]}` : '点击用当前选项重新转换'}
                  disabled={busy}
                  onClick={() => void reconvertRecent(n)}
                >
                  {n}
                </button>
              ) : (
                <span className="chip-name" title={n}>{n}</span>
              )}
              <button type="button" className="chip-x" aria-label={`删除最近文件记录 ${n}`} title="删除该记录（不影响已转换的文件）" onClick={() => removeRecent(n)}>
                <IconX size={10} />
              </button>
            </span>
          ))}
          {isDesktop && <span className="recent-hint">点击文件名可用当前选项重新转换</span>}
        </div>
      )}

      <div className="layout">
        <section className="left">
          <label
            className={dragOver ? 'dropzone drag' : 'dropzone'}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length > 0) void convertFiles(e.dataTransfer.files);
            }}
          >
            <span className="drop-ico" aria-hidden="true"><IconDocArrow /></span>
            <span className="dropzone-main">把 .md 拖到这里</span>
            <span className="dropzone-sub">可连同图片资源一起拖入；或点击选择文件</span>
            <span className="button primary">选择文件（可多选）</span>
            <input
              type="file"
              multiple
              accept=".md,.markdown,.mdown,.mkd,image/*"
              onChange={(e) => { if (e.target.files) void convertFiles(e.target.files); e.target.value = ''; }}
            />
          </label>

          <div className="panel">
            <h2><span className="panel-icon" aria-hidden="true"><IconSliders /></span>转换选项</h2>
            <label className="opt">
              <input type="checkbox" checked={options.toc} onChange={(e) => patchOptions({ toc: e.target.checked })} />
              生成目录（TOC）
            </label>
            {options.toc && (
              <label className="opt indent field">
                <span>目录层级</span>
                <select value={options.tocDepth} onChange={(e) => patchOptions({ tocDepth: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
            <label className="opt">
              <input type="checkbox" checked={options.numberSections} onChange={(e) => patchOptions({ numberSections: e.target.checked })} />
              章节编号
            </label>
            <label className="opt indent field">
              <span>高亮风格</span>
              <select value={options.highlightStyle} onChange={(e) => patchOptions({ highlightStyle: e.target.value })}>
                {HIGHLIGHT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <HLPreview style={String(options.highlightStyle)} />
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
            <h2><span className="panel-icon" aria-hidden="true"><IconLayout /></span>文档模板</h2>
            <label className="opt field">
              <span>模板</span>
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
            {isDesktop && tplSummary && (
              <div className="tpl-preview">
                <div className="tpl-sample" aria-hidden="true">
                  <p className="ts-h" style={{ fontFamily: cssFont(tplSummary.heading) }}>一级标题样式</p>
                  <p className="ts-b" style={{ fontFamily: cssFont(tplSummary.normal) }}>正文段落样式，中文与 English 混排效果。</p>
                  <p className="ts-c" style={{ fontFamily: cssFont(tplSummary.code, false) }}>{'const greeting = "你好，世界";'}</p>
                </div>
                <p className="hint">
                  {tplSummary.label}
                  {tplSummary.normal && ` · 正文 ${cnFont(tplSummary.normal)}${tplSummary.normal.sizePt ? ` ${tplSummary.normal.sizePt}pt` : ''}`}
                  {tplSummary.heading && ` · 标题 ${cnFont(tplSummary.heading)}`}
                  {tplSummary.code && ` · 代码 ${cnFont(tplSummary.code, false)}`}
                  {tplSummary.lineSpacing ? ` · ${trimSpacing(tplSummary.lineSpacing)} 倍行距` : ''}
                  （示意效果，以 Word 打开为准）
                </p>
              </div>
            )}
            <label className="opt">
              <span className="button ghost">
                <IconUpload />
                导入 reference.docx 模板
                <input
                  type="file"
                  accept=".docx"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importTemplate(f);
                    e.target.value = '';
                  }}
                />
              </span>
            </label>
            <p className="hint">reference.docx 是 Word 样式模板：可在 Word 中基于内置模板改好字体/标题/代码样式后另存导入（需保留 12 项必需样式，缺样式会被拒绝并提示）。</p>
            {templateMsg && <p className={`tpl-msg ${templateMsg.includes('成功') ? 'hint' : 'err'}`}>{templateMsg}</p>}
          </div>

          <div className="panel">
            <h2><span className="panel-icon" aria-hidden="true"><IconTag /></span>元数据（可选）</h2>
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

        <section className="queue">
          <h2>
            <span className="panel-icon" aria-hidden="true"><IconList /></span>
            转换队列与结果
            <span className="queue-head-tools">
              {rows.length > 0 && (
                <>
                  <span className="queue-count">{rows.length} 项 · 成功 {doneCount}</span>
                  <button type="button" className="button ghost small" onClick={clearRows} disabled={busy}>清空</button>
                </>
              )}
            </span>
          </h2>
          <div className="queue-body">
            {rows.length === 0 && (
              <div className="empty">
                <EmptyArt />
                <p className="empty-title">队列为空</p>
                <p className="empty-desc">把 .md 文件拖到左侧虚线区域，或点击「选择文件」开始转换；完成后可在此下载 Word 文档。</p>
                <ol className="steps">
                  <li><span className="step-n" aria-hidden="true">1</span>拖入或选择文件</li>
                  <li><span className="step-n" aria-hidden="true">2</span>按需调整选项</li>
                  <li><span className="step-n" aria-hidden="true">3</span>下载或打开 .docx</li>
                </ol>
              </div>
            )}
            {rows.map((row) => (
              <article key={row.key} className={`row ${row.status}`}>
                <div className="row-head">
                  <span className={`row-ico ${row.status}`} aria-hidden="true">
                    {row.status === 'converting' ? <span className="spin" /> : row.status === 'done' ? <IconCheck /> : <IconX />}
                  </span>
                  <span className="name">{row.name}</span>
                  <span className="badge">
                    {row.status === 'converting' && <><span className="spin" />转换中…</>}
                    {row.status === 'done' && `成功 · ${row.result?.durationMs}ms`}
                    {row.status === 'failed' && '失败'}
                  </span>
                </div>

                {row.status === 'done' && (
                  <div className="row-body">
                    {row.result?.stats && (
                      <div className="stats">
                        {STAT_LABELS.map(([key, label]) => (
                          row.result?.stats?.[key] !== undefined
                            ? <span key={key} className="stat">{label} {row.result.stats[key]}</span>
                            : null
                        ))}
                      </div>
                    )}
                    {row.result?.warnings.map((w, i) => (
                      <p key={i} className="warn"><IconAlert />{w.message}</p>
                    ))}
                    <div className="actions">
                      <a className="button primary small" href={row.result?.downloadUrl}>下载 .docx</a>
                      <button type="button" className="button small" onClick={() => void openResult(row, false)}>打开</button>
                      <button type="button" className="button small" onClick={() => void openResult(row, true)}>打开所在文件夹</button>
                    </div>
                  </div>
                )}

                {row.status === 'failed' && (
                  <div className="row-body">
                    <p className="err"><IconAlert />{row.result?.error?.message ?? '未知错误'}</p>
                    <details>
                      <summary>错误详情（错误码 {row.result?.error?.code}）</summary>
                      <pre>{row.result?.error?.stderrTail ?? '（无 pandoc 原文）'}</pre>
                    </details>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </div>

      {log && (
        <pre className="logbox">{log.join('\n')}</pre>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}

      <footer className="foot">
        <span>全程本地处理，文件不会上传</span>
        <span className="sep">·</span>
        <span>由 pandoc 驱动</span>
        <span className="sep">·</span>
        <a className="foot-link" href={transport.exportLogUrl()} target="_blank" rel="noreferrer" title="导出运行日志（问题排查用）">导出日志</a>
      </footer>
    </main>
  );
}
