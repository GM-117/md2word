import { join } from 'node:path';
import { getBundledReferenceDocx } from '@md2word/core';
import { LogBuffer } from './services/logger.js';
import { SettingsService, type KvStore } from './services/settings.js';
import { TemplateService } from './services/templates.js';
import { JobRegistry } from './services/jobs.js';
import { ConvertService } from './services/convert.js';
import { createKvStore } from './services/electronStoreAdapter.js';

export interface AppPaths {
  /** 用户数据根：settings/templates/jobs/logs（打包态 = userData，测试/E2E 可注入临时目录） */
  userDataDir: string;
  /** extraResources 根（打包态 = process.resourcesPath；开发态仅作模板兜底） */
  resourcesDir: string;
  isPackaged: boolean;
}

/** 测试注入点：跳过 electron-store（其 electron 依赖在纯 Node 下不可用），用内存实现替代 */
export interface CreateServicesOptions {
  kvStore?: KvStore;
}

export interface AppServices {
  logger: LogBuffer;
  settings: SettingsService;
  templates: TemplateService;
  convert: ConvertService;
  registry: JobRegistry;
  userDataDir: string;
}

/**
 * 服务装配（不 import electron，可被 vitest 集成测试直驱）。
 * 内置模板：打包态用 extraResources 副本（pandoc 读不了 asar 虚拟路径，§M4-4）；开发态用 core 仓库资产。
 */
export async function createServices(paths: AppPaths, opts: CreateServicesOptions = {}): Promise<AppServices> {
  const logger = new LogBuffer();
  logger.attachFile(join(paths.userDataDir, 'logs', 'md2word.log'));

  const store = opts.kvStore ?? (await createKvStore(paths.userDataDir));
  const settings = new SettingsService(store);

  const builtinTemplatePath =
    (paths.isPackaged ? join(paths.resourcesDir, 'templates', 'reference-zh.docx') : getBundledReferenceDocx()) ??
    join(paths.resourcesDir, 'templates', 'reference-zh.docx');

  const templates = new TemplateService(join(paths.userDataDir, 'templates'), builtinTemplatePath, settings, logger);
  const registry = new JobRegistry();
  const convert = new ConvertService(
    join(paths.userDataDir, 'jobs'),
    registry,
    templates,
    () => settings.all,
    (patch) => settings.set(patch),
    logger,
  );

  return { logger, settings, templates, convert, registry, userDataDir: paths.userDataDir };
}
