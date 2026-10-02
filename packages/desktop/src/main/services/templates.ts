import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getBundledReferenceDocx, resolvePandocInfo, runPandoc, validateTemplate } from '@md2word/core';
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
}
