import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getBundledReferenceDocx, resolvePandocInfo, runPandoc, validateTemplate } from '@md2word/core';
import { unzipSync } from 'fflate';
import type { LogBuffer } from './logger.js';
import type { SettingsService } from './settings.js';

/** 与 renderer TemplateInfo 契约一致（web-host GET /api/templates 同构） */
export interface TemplateInfo {
  builtin: { name: string; id: string; valid: boolean } | null;
  pandocDefault: { name: string; id: string };
  user: Array<{ name: string; valid: boolean; missingStyles: string[]; error?: string }>;
  defaultTemplate: string;
}

export type TemplateAddResult =
  | { ok: true; name: string }
  | { ok: false; error: string; missingStyles?: string[] };

/** 模板样式概览（渲染层"模板预览"卡片的数据源；字体供 CSS font-family 直接使用） */
export interface TemplateStyleSummary {
  label: string;
  normal?: { font?: string; eastAsia?: string; sizePt?: number };
  heading?: { font?: string; eastAsia?: string; sizePt?: number };
  code?: { font?: string; eastAsia?: string; sizePt?: number };
  /** 行距倍数（由 Normal 的 w:line/240 计算；仅 lineRule="auto" 时有效） */
  lineSpacing?: number;
}

/**
 * 模板服务：userData/templates 下用户模板的导入/校验/删除 + 内置模板与 pandoc 默认模板的解析。
 * 内置中文模板路径由宿主注入（打包态为 extraResources/templates，开发态为 core 仓库内资产），
 * 避免 pandoc 读 asar 虚拟路径（§M4-4）。
 */
export class TemplateService {
  constructor(
    private readonly templatesDir: string,
    private readonly builtinTemplatePath: string | null,
    private readonly settings: SettingsService,
    private readonly logger: LogBuffer,
  ) {
    mkdirSync(this.templatesDir, { recursive: true });
  }

  list(): TemplateInfo {
    const user = readdirSync(this.templatesDir)
      .filter((f) => f.toLowerCase().endsWith('.docx'))
      .map((f) => {
        const p = join(this.templatesDir, f);
        const v = validateTemplate(p);
        return { name: f.replace(/\.docx$/i, ''), valid: v.ok, missingStyles: v.missingStyles, error: v.error };
      });
    const builtinValid = this.builtinTemplatePath ? validateTemplate(this.builtinTemplatePath).ok : false;
    return {
      builtin: this.builtinTemplatePath ? { name: '内置中文模板', id: 'builtin-zh', valid: builtinValid } : null,
      pandocDefault: { name: 'pandoc 默认样式', id: 'pandoc-default' },
      user,
      defaultTemplate: String(this.settings.all.defaultTemplate ?? 'builtin-zh'),
    };
  }

  /** 导入模板：zip 合法性 + 必需样式校验；无效不落库并返回缺失样式清单（US3） */
  add(name: string, bytes: Uint8Array): TemplateAddResult {
    const safeName = basename(String(name ?? ''));
    if (!safeName.toLowerCase().endsWith('.docx')) {
      return { ok: false, error: '模板必须是 .docx 文件' };
    }
    const target = join(this.templatesDir, safeName);
    writeFileSync(target, bytes);
    const v = validateTemplate(target);
    if (!v.ok) {
      unlinkSync(target); // 无效模板不落库
      this.logger.warn(`template rejected: ${safeName} missing=${v.missingStyles.join(',')} error=${v.error ?? ''}`);
      return {
        ok: false,
        error: v.error ?? `模板缺少必需样式：${v.missingStyles.join('、')}（请基于内置模板或 pandoc 默认模板修改）`,
        missingStyles: v.missingStyles,
      };
    }
    this.logger.info(`template imported: ${safeName}`);
    return { ok: true, name: safeName.replace(/\.docx$/i, '') };
  }

  /** 删除用户模板；若删的是当前默认模板则回退内置 */
  delete(name: string): boolean {
    const safe = basename(String(name ?? ''));
    const p = join(this.templatesDir, `${safe}.docx`);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    if (this.settings.all.defaultTemplate === safe) this.settings.set({ defaultTemplate: 'builtin-zh' });
    this.logger.info(`template deleted: ${safe}`);
    return true;
  }

  /** 解析生效模板：请求指定 > 用户默认模板 > 内置中文模板 > pandoc 原生（显式选择时） */
  async resolveTemplate(requested?: string): Promise<string | undefined> {
    if (requested) return requested;
    const pref = this.settings.all.defaultTemplate;
    if (pref === 'pandoc-default') return this.ensurePandocDefaultTemplate();
    if (typeof pref === 'string' && pref !== 'builtin-zh') {
      const safe = basename(pref);
      const p = join(this.templatesDir, `${safe}.docx`);
      if (pref === safe && existsSync(p)) return p;
      this.logger.warn(`defaultTemplate 指向的模板不存在，回退：${String(pref)}`);
    }
    return this.builtinTemplatePath ?? getBundledReferenceDocx() ?? undefined;
  }

  /** pandoc 原生模板导出缓存（pandoc-default 显式选择时使用；与 web-host 行为一致） */
  private async ensurePandocDefaultTemplate(): Promise<string> {
    const cached = join(this.templatesDir, '.pandoc-default.docx');
    if (existsSync(cached)) return cached;
    const pandoc = await resolvePandocInfo();
    if (!pandoc) throw new Error('pandoc 不可用，无法导出默认模板');
    const run = await runPandoc(pandoc.path, ['--print-default-data-file', 'reference.docx'], { timeoutMs: 30_000 });
    if (run.code !== 0 || run.stdoutBytes.length < 1000) {
      throw new Error(`导出 pandoc 默认模板失败：${run.stderr.slice(0, 200)}`);
    }
    writeFileSync(cached, run.stdoutBytes);
    return cached;
  }

  /** 模板样式概览：按模板 id（builtin-zh / pandoc-default / 用户模板名）解析并提取关键样式 */
  async describeTemplate(id: string): Promise<TemplateStyleSummary | null> {
    try {
      const resolved = await this.resolveTemplatePath(id);
      if (!resolved) return null;
      return { ...summarizeTemplate(resolved.path), label: resolved.label };
    } catch {
      return null;
    }
  }

  /** 模板 id 是否可解析（同步；md2word:// 下载闸门用） */
  templateExists(id: string): boolean {
    if (id === 'builtin-zh') return !!this.builtinTemplatePath && existsSync(this.builtinTemplatePath);
    if (id === 'pandoc-default') return true; // 按需导出缓存
    const safe = basename(id);
    return safe.length > 0 && id === safe && existsSync(join(this.templatesDir, `${safe}.docx`));
  }

  /** 模板 id → 文件路径 + 展示名（样式概览与模板文件下载共用） */
  async resolveTemplatePath(id: string): Promise<{ path: string; label: string } | null> {
    if (id === 'builtin-zh') {
      const p = this.builtinTemplatePath ?? getBundledReferenceDocx();
      return p && existsSync(p) ? { path: p, label: '内置中文模板' } : null;
    }
    if (id === 'pandoc-default') {
      const p = await this.ensurePandocDefaultTemplate();
      return { path: p, label: 'pandoc 默认样式' };
    }
    const safe = basename(id);
    if (!safe || id !== safe) return null;
    const p = join(this.templatesDir, `${safe}.docx`);
    return existsSync(p) ? { path: p, label: `${safe}（自定义）` } : null;
  }
}

/** 从 styles.xml 提取指定样式的字体/字号/颜色；字体缺省时回退 docDefaults → 主题字体（pandoc 默认模板字体在 theme 里） */
function extractStyle(
  stylesXml: string,
  styleId: string,
  fallback: { font?: string; eastAsia?: string } = {},
): { font?: string; eastAsia?: string; sizePt?: number } {
  const block = new RegExp(`<w:style [^>]*w:styleId="${styleId}"[\\s\\S]*?</w:style>`).exec(stylesXml)?.[0];
  if (!block) return { ...fallback };
  const fonts = /<w:rFonts[^>]*\/>/.exec(block)?.[0] ?? '';
  const sz = /<w:sz w:val="(\d+)"/.exec(block)?.[1];
  return {
    font: /w:ascii="([^"]+)"/.exec(fonts)?.[1] ?? fallback.font,
    eastAsia: /w:eastAsia="([^"]+)"/.exec(fonts)?.[1] ?? fallback.eastAsia,
    sizePt: sz ? Number(sz) / 2 : undefined,
  };
}

function docDefaultsFonts(stylesXml: string): { font?: string; eastAsia?: string } {
  const dd = /<w:rPrDefault>[\s\S]*?<w:rFonts([^>]*)\/>/.exec(stylesXml)?.[1];
  if (!dd) return {};
  return { font: /w:ascii="([^"]+)"/.exec(dd)?.[1], eastAsia: /w:eastAsia="([^"]+)"/.exec(dd)?.[1] };
}

/** theme1.xml 的字体方案：latin 顺序为 [majorFont, minorFont] */
function themeFonts(files: Record<string, Uint8Array>): { major?: string; minor?: string } {
  const themeKey = Object.keys(files).find((k) => /theme\d*\.xml$/.test(k));
  if (!themeKey) return {};
  const xml = new TextDecoder().decode(files[themeKey]!);
  const latin = [...xml.matchAll(/<a:latin typeface="([^"]*)"/g)].map((m) => m[1]);
  return { major: latin[0], minor: latin[1] };
}

/** 模板 → 样式概览（正文/标题/代码三行 + 行距；解析失败返回空概览，渲染层降级为仅描述文案） */
export function summarizeTemplate(docxPath: string): Omit<TemplateStyleSummary, 'label'> {
  try {
    const files = unzipSync(new Uint8Array(readFileSync(docxPath)));
    const stylesXml = files['word/styles.xml'] ? new TextDecoder().decode(files['word/styles.xml']) : '';
    if (!stylesXml) return {};
    const theme = themeFonts(files as Record<string, Uint8Array>);
    const dd = docDefaultsFonts(stylesXml);
    const base = { font: dd.font ?? theme.minor, eastAsia: dd.eastAsia };
    const headingBase = { font: theme.major ?? base.font, eastAsia: base.eastAsia };
    const normal = extractStyle(stylesXml, 'Normal', base);
    const heading = extractStyle(stylesXml, 'Heading1', headingBase);
    const code = extractStyle(stylesXml, 'SourceCode').font
      ? extractStyle(stylesXml, 'SourceCode')
      : extractStyle(stylesXml, 'VerbatimChar', base);
    const spacing = /<w:style [^>]*w:styleId="Normal"[\s\S]*?<w:spacing[^>]*w:line="(\d+)"[^>]*w:lineRule="auto"/.exec(stylesXml);
    return {
      normal,
      heading,
      code,
      ...(spacing ? { lineSpacing: Number(spacing[1]) / 240 } : {}),
    };
  } catch {
    return {};
  }
}
