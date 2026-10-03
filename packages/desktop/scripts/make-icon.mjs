import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 应用图标生成（构建资源，产物提交入库：build/icon.icns / build/icon.ico / build/icon_512.png）。
 * 图标源：packages/renderer/src/assets/icon-v3.svg（品牌 M→W，与网页 favicon / 顶栏 logo 同源）。
 * 栅格化：Playwright Chromium 按目标尺寸直接渲染 SVG（omitBackground 保留圆角外透明）。
 * ICO 用 256px PNG-in-ICO（Vista+ 支持）。
 * 用法：node scripts/make-icon.mjs [svgPath]
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const REPO = join(DESKTOP, '..', '..');
const DEFAULT_SVG = join(REPO, 'packages', 'renderer', 'src', 'assets', 'icon-v3.svg');

const svgPath = process.argv[2] ?? DEFAULT_SVG;
if (!existsSync(svgPath)) {
  console.error(`[icon] 图标源不存在：${svgPath}`);
  process.exit(2);
}
const buildDir = join(DESKTOP, 'build');
mkdirSync(buildDir, { recursive: true });

/** 目标尺寸集合：iconset 全套（含 @2x）+ 512 预览 */
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

async function renderAll() {
  // about:blank 源无法加载 file:// 子资源（Chromium 安全限制），故将 SVG 内联进页面，
  // 并按目标尺寸改写根 <svg> 的 width/height（正则只命中根标签属性；stroke-width 不受影响）
  const svgText = readFileSync(svgPath, 'utf8');
  const sizedSvg = (size) => svgText
    .replace(/\swidth="[^"]*"/i, '')
    .replace(/\sheight="[^"]*"/i, '')
    .replace('<svg', `<svg width="${size}" height="${size}"`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  const out = new Map();
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${sizedSvg(size)}</body></html>`,
      { waitUntil: 'networkidle' },
    );
    out.set(size, await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    console.log(`[icon] rendered ${size}px ✓`);
  }
  await browser.close();
  return out;
}

// ---------- ICO（PNG-in-ICO，256px） ----------
function makeIco(png256) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type icon
  header.writeUInt16LE(1, 4); // count
  header.writeUInt8(0, 6); // width 256 → 0
  header.writeUInt8(0, 7); // height 256 → 0
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bpp
  header.writeUInt32LE(png256.length, 14); // size
  header.writeUInt32LE(22, 18); // offset
  return Buffer.concat([header, png256]);
}

const pngs = await renderAll();

writeFileSync(join(buildDir, 'icon_512.png'), pngs.get(512));

// icns（macOS：iconset + iconutil）
try {
  const iconset = join(buildDir, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${s}x${s}.png`), pngs.get(s));
    writeFileSync(join(iconset, `icon_${s}x${s}@2x.png`), pngs.get(s * 2));
  }
  execSync(`iconutil -c icns "${iconset}" -o "${join(buildDir, 'icon.icns')}"`, { stdio: 'inherit' });
  rmSync(iconset, { recursive: true, force: true });
  console.log('[icon] icon.icns ✓');
} catch (err) {
  console.warn('[icon] iconutil 不可用（非 macOS？）跳过 icns：', err instanceof Error ? err.message : err);
}

// ico（Windows）
writeFileSync(join(buildDir, 'icon.ico'), makeIco(pngs.get(256)));
console.log('[icon] icon.ico ✓');
console.log('[icon] done — 源：', svgPath);
