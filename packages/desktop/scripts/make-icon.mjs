import { deflateSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 应用图标生成（构建资源，产物提交入库：build/icon.icns / build/icon.ico / build/icon_512.png）。
 * 纯 Node 绘制（无 canvas 依赖）：4× 超采样 + 盒式降采样；ICO 用 256px PNG-in-ICO（Vista+ 支持）。
 */

const S = 4; // 超采样倍数
const MASTER = 1024;
const W = MASTER * S;

// ---------- 调色 ----------
const BG_TOP = [79, 109, 245];
const BG_BOT = [43, 63, 212];
const WHITE = [255, 255, 255];
const LINE = [199, 210, 254];
const FLAP = [178, 190, 220];
const BADGE_COLOR = [16, 185, 129];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  if ((x < x0 + r || x > x1 - r) && (y < y0 + r || y > y1 - r)) {
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
  return Math.hypot(ex, ey);
}

// 1024 逻辑坐标（绘制时乘 S）
const DOC = { x0: 320, y0: 180, x1: 704, y1: 844, r: 48 };
const FOLD = 118; // 折角边长
const BADGE = { cx: 726, cy: 712, r: 148 };
const W_PTS = [
  [664, 652], [700, 782], [726, 692], [752, 782], [788, 652],
];

function drawPx(x, y) {
  const margin = 40 * S, cr = 220 * S;
  const inBg = inRoundedRect(x, y, margin, margin, W - margin, W - margin, cr);
  if (!inBg) return null;
  const t = (y - margin) / (W - 2 * margin);
  const bg = [
    Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
  ];

  // 徽章（绿圆）+ 白色 W（先画，被文档压住左缘 → 层次感）
  const bdx = x - BADGE.cx * S, bdy = y - BADGE.cy * S;
  if (bdx * bdx + bdy * bdy <= BADGE.r * BADGE.r * S * S) {
    const sx = x / S, sy = y / S;
    for (let i = 0; i < W_PTS.length - 1; i++) {
      const [x1, y1] = W_PTS[i];
      const [x2, y2] = W_PTS[i + 1];
      if (distSeg(sx, sy, x1, y1, x2, y2) <= 19) return WHITE;
    }
    return BADGE_COLOR;
  }

  // 白色文档
  if (inRoundedRect(x, y, DOC.x0 * S, DOC.y0 * S, DOC.x1 * S, DOC.y1 * S, DOC.r * S)) {
    // 折角：右上角三角缺口（透出背景）+ 浅色翻折面
    const nx0 = (DOC.x1 - FOLD) * S, ny0 = DOC.y0 * S;
    if (x >= nx0 && y <= ny0 + FOLD * S) {
      // 折角：沿 A(右 上角左移 F)–B(右缘 下移 F) 对角线切掉右上角（透出背景），翻折面盖在左下
      const beyondFold = x - nx0 >= y - ny0;
      return beyondFold ? bg : FLAP;
    }
    // 三行文字条
    for (const by of [300, 404, 508]) {
      if (inRoundedRect(x, y, 372 * S, by * S, 640 * S, (by + 46) * S, 23 * S)) return LINE;
    }
    return WHITE;
  }

  // 第四行短条（替代原箭头位，避免白底白箭头不可读）
  if (inRoundedRect(x, y, 372 * S, 612 * S, 540 * S, 658 * S, 23 * S)) return LINE;

  return bg;
}

function render() {
  const px = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const c = drawPx(x, y);
      const i = (y * W + x) * 4;
      if (c) {
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }
  }
  return px;
}

function boxDownsample(src, srcW, dstW) {
  const f = srcW / dstW;
  const out = new Uint8Array(dstW * dstW * 4);
  for (let dy = 0; dy < dstW; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      let r = 0, g = 0, b = 0, a = 0;
      const x0 = Math.floor(dx * f), x1 = Math.max(x0 + 1, Math.floor((dx + 1) * f));
      const y0 = Math.floor(dy * f), y1 = Math.max(y0 + 1, Math.floor((dy + 1) * f));
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcW + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------- 生成 ----------
console.log('[icon] rendering master', W, '…');
const master = render();
const buildDir = new URL('../build/', import.meta.url).pathname;
mkdirSync(buildDir, { recursive: true });

const pngAt = (size) => encodePng(boxDownsample(master, W, size), size);
writeFileSync(join(buildDir, 'icon_512.png'), pngAt(512));

// icns（macOS：iconset + iconutil）
try {
  const iconset = join(buildDir, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const sizes = [16, 32, 128, 256, 512];
  for (const s of sizes) {
    writeFileSync(join(iconset, `icon_${s}x${s}.png`), pngAt(s));
    writeFileSync(join(iconset, `icon_${s}x${s}@2x.png`), pngAt(s * 2));
  }
  execSync(`iconutil -c icns "${iconset}" -o "${join(buildDir, 'icon.icns')}"`, { stdio: 'inherit' });
  rmSync(iconset, { recursive: true, force: true });
  console.log('[icon] icon.icns ✓');
} catch (err) {
  console.warn('[icon] iconutil 不可用（非 macOS？）跳过 icns：', err instanceof Error ? err.message : err);
}

// ico（Windows：PNG-in-ICO，256px）
try {
  const png256 = pngAt(256);
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
  writeFileSync(join(buildDir, 'icon.ico'), Buffer.concat([header, png256]));
  console.log('[icon] icon.ico ✓');
} catch (err) {
  console.warn('[icon] ico 生成失败：', err instanceof Error ? err.message : err);
}
console.log('[icon] done');
