// Рисует иконки приложения в PNG без зависимостей: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../icons/', import.meta.url));
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const PINK_A = hex('#f06595'), PINK_B = hex('#c2255c');
const CREAM = hex('#fff6f9'), SIDE = hex('#f6d3df'), MINT = hex('#0ca678'), SHADOW = hex('#9c1f4d');

// Цвет точки (u, v ∈ [0,1]) или null (прозрачно)
function shade(u, v, { maskable }) {
  const r = maskable ? 0 : 0.22;
  // скруглённый квадрат фона
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0), dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return null;
  let c = mix(PINK_A, PINK_B, (u + v) / 2);
  // для maskable держим рисунок в безопасной зоне 80%
  const s = maskable ? 0.8 : 1;
  const x = (u - 0.5) / s + 0.5, y = (v - 0.5) / s + 0.5;
  const cx = 0.5, rx = 0.3, ryTop = 0.13, topY = 0.5, botY = 0.62;
  const inE = (yc, ry) => ((x - cx) / rx) ** 2 + ((y - yc) / ry) ** 2 <= 1;
  if (inE(botY + 0.035, ryTop)) c = mix(c, SHADOW, 0.35);           // тень
  if (inE(botY, ryTop) || (Math.abs(x - cx) <= rx && y >= topY && y <= botY)) c = SIDE; // бок торта
  if (inE(topY, ryTop)) c = CREAM;                                    // верх
  // пунктирный мятный контур на верхе (трафарет)
  const e = Math.hypot((x - cx) / 0.18, (y - topY) / 0.075);
  if (Math.abs(e - 1) < 0.16) {
    const a = Math.atan2((y - topY) / 0.075, (x - cx) / 0.18);
    if (Math.floor(((a + Math.PI) / (2 * Math.PI)) * 14) % 2 === 0) c = MINT;
  }
  return c;
}

function render(size, opts) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const col = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, opts);
          if (col) { r += col[0]; g += col[1]; b += col[2]; a++; }
        }
      }
      const k = (py * size + px) * 4;
      if (a) { buf[k] = r / a; buf[k + 1] = g / a; buf[k + 2] = b / a; }
      buf[k + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return png(size, buf);
}

writeFileSync(out + 'icon-192.png', render(192, { maskable: false }));
writeFileSync(out + 'icon-512.png', render(512, { maskable: false }));
writeFileSync(out + 'maskable-512.png', render(512, { maskable: true }));
writeFileSync(out + 'apple-180.png', render(180, { maskable: true }));
console.log('icons →', out);
