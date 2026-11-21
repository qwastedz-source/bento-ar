import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processImageData, hexToRgb } from '../imageproc.js';

const N = 128;
const BASE = {
  shape: 'circle', diameter: 10, mode: 'lines', thr: 0.12, blur: 0, thick: 1.6, minLen: 0,
  fillThr: 110, fillAlpha: 0.5, invert: false, color: '#00ff6a',
};

// белый фон, чёрный квадрат 40..88, опционально точка 2×2 в (20,64)
function scene({ dot = false } = {}) {
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const k = (y * N + x) * 4;
      const black = (x >= 40 && x < 88 && y >= 40 && y < 88) || (dot && x >= 20 && x < 22 && y >= 63 && y < 65);
      const v = black ? 0 : 255;
      data[k] = data[k + 1] = data[k + 2] = v;
      data[k + 3] = 255;
    }
  }
  return { width: N, height: N, data };
}
const A = (img, x, y) => img.data[(y * N + x) * 4 + 3];
const run = (p, s = scene()) => processImageData(s, { ...BASE, ...p });

test('контур: линии на краю квадрата, пусто внутри и снаружи', () => {
  const { main } = run({});
  assert.ok(A(main, 40, 64) > 200 || A(main, 39, 64) > 200, 'левый край');
  assert.ok(A(main, 87, 64) > 200 || A(main, 88, 64) > 200, 'правый край');
  assert.equal(A(main, 64, 64), 0, 'центр квадрата');
  assert.equal(A(main, 12, 64), 0, 'фон');
  const [r, g, b] = hexToRgb(BASE.color);
  const k = (64 * N + 40) * 4;
  assert.deepEqual([main.data[k], main.data[k + 1], main.data[k + 2]], [r, g, b], 'цвет линии');
});

test('контур: круглая маска обрезает углы', () => {
  const s = scene();
  for (let i = 0; i < N; i++) { const k = i * 4; s.data[k] = s.data[k + 1] = s.data[k + 2] = 0; } // чёрная строка 0
  const { main, photo } = processImageData(s, { ...BASE });
  assert.equal(A(main, 0, 1), 0);
  assert.equal(A(photo, 0, 0), 0);
  assert.equal(A(photo, 64, 64), 255);
});

test('толщина в мм: толще ползунок → шире линия', () => {
  const width = (img) => { let n = 0; for (let x = 30; x < 52; x++) if (A(img, x, 64) > 127) n++; return n; };
  const thin = width(run({ thick: 0.8 }).main);
  const thick = width(run({ thick: 4 }).main);
  assert.ok(thin >= 1, `тонкая линия есть (${thin})`);
  assert.ok(thick > thin + 2, `толстая шире: ${thick} > ${thin}`);
  // 4 мм при 10 см / 128 px ≈ 5.1 px
  assert.ok(thick >= 4 && thick <= 7, `≈5 px, получилось ${thick}`);
});

test('убрать обрывки: точка исчезает, квадрат остаётся', () => {
  const s = scene({ dot: true });
  const withDot = processImageData(s, { ...BASE, minLen: 0 }).main;
  const clean = processImageData(scene({ dot: true }), { ...BASE, minLen: 10 }).main;
  const near = (img) => { let m = 0; for (let y = 58; y < 70; y++) for (let x = 15; x < 27; x++) m = Math.max(m, A(img, x, y)); return m; };
  assert.ok(near(withDot) > 0, 'без фильтра точка видна');
  assert.equal(near(clean), 0, 'с фильтром точка убрана');
  assert.ok(A(clean, 40, 64) > 200 || A(clean, 39, 64) > 200, 'квадрат на месте');
});

test('пятна: тёмное залито с нужной плотностью, наоборот — светлое', () => {
  const { main } = run({ mode: 'fill' });
  assert.equal(A(main, 64, 64), Math.round(0.5 * 255));
  assert.equal(A(main, 20, 64), 0);
  const inv = run({ mode: 'fill', invert: true }).main;
  assert.equal(A(inv, 64, 64), 0);
  assert.ok(A(inv, 20, 64) > 0);
});

test('фото: main и photo совпадают, квадратный торт без маски', () => {
  const r = run({ mode: 'photo', shape: 'square' });
  assert.equal(r.main, r.photo);
  assert.equal(A(r.photo, 0, 0), 255);
});

test('контур + фото: внутри полупрозрачное фото, на краю линия', () => {
  const { main } = run({ mode: 'mix' });
  const a = A(main, 64, 64);
  assert.ok(a > 100 && a < 130, `≈45% фото, получилось ${a}`);
  assert.ok(A(main, 40, 64) > 200 || A(main, 39, 64) > 200);
});

test('прозрачный фон картинки считается белым (нет ложных линий)', () => {
  const s = scene();
  for (let i = 0; i < N * N; i++) {
    const x = i % N, y = Math.floor(i / N);
    if (!(x >= 40 && x < 88 && y >= 40 && y < 88)) { s.data[i * 4] = s.data[i * 4 + 1] = s.data[i * 4 + 2] = 0; s.data[i * 4 + 3] = 0; }
  }
  const { main } = processImageData(s, { ...BASE });
  assert.equal(A(main, 12, 64), 0);
  assert.ok(A(main, 40, 64) > 200 || A(main, 39, 64) > 200);
});

// ---------- качество: точное поле расстояний, SDF, обводка ----------
import { distanceTransform, encodeSdf, outlineColor, SDF_MAX } from '../imageproc.js';

test('distanceTransform: точное евклидово расстояние (сверка перебором)', () => {
  const N = 40;
  const mask = new Uint8Array(N * N);
  let s = 3;
  const pts = [];
  for (let k = 0; k < 12; k++) { s = (s * 16807) % 2147483647; const i = s % (N * N); mask[i] = 1; pts.push([i % N, Math.floor(i / N)]); }
  const d = distanceTransform(mask, N);
  let maxErr = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const exact = Math.min(...pts.map(([px, py]) => Math.hypot(px - x, py - y)));
    maxErr = Math.max(maxErr, Math.abs(d[y * N + x] - exact));
  }
  assert.ok(maxErr < 1e-4, `ошибка ${maxErr}`);
});

test('distanceTransform: диагональ ровная (старый chamfer давал до 8% ошибки)', () => {
  const N = 64, mask = new Uint8Array(N * N);
  mask[32 * N + 32] = 1;
  const d = distanceTransform(mask, N);
  assert.ok(Math.abs(d[(32 + 20) * N + 32 + 20] - Math.hypot(20, 20)) < 1e-4);
  assert.ok(Math.abs(d[(32 + 7) * N + 32 + 19] - Math.hypot(7, 19)) < 1e-4);
});

test('encodeSdf: 0 на линии, 255 далеко, монотонно', () => {
  const dist = new Float32Array([0, 1, 10, SDF_MAX, 500]);
  const s = encodeSdf(dist, 1);
  assert.equal(s.data[0], 0);
  assert.ok(s.data[1] > 0 && s.data[1] < s.data[2]);
  assert.equal(s.data[3], 255);
  assert.equal(s.data[4], 255);
  assert.equal(s.maxD, SDF_MAX);
});

test('контур отдаёт SDF для шейдера шлема', () => {
  const r = run({});
  assert.ok(r.sdf && r.sdf.width === N && r.sdf.data.length === N * N);
  assert.equal(r.sdf.data[64 * N + 40] <= 8 || r.sdf.data[64 * N + 39] <= 8, true, 'на линии почти 0');
  assert.ok(r.sdf.data[64 * N + 64] > 100, 'в центре квадрата далеко от линии');
  assert.equal(run({ mode: 'fill' }).sdf, undefined);
  assert.equal(run({ mode: 'photo' }).sdf, undefined);
});

test('обводка: тёмное кольцо вокруг светлой линии', () => {
  const plain = run({ thick: 1.6, outline: false, diameter: 2.5 }).main; // мельче торт = больше пикселей на мм
  const out = run({ thick: 1.6, outline: true, diameter: 2.5 }).main;
  // пиксель чуть снаружи линии: без обводки прозрачный, с обводкой тёмный
  let found = false;
  for (let x = 30; x < 40 && !found; x++) {
    const k = (64 * N + x) * 4;
    if (plain.data[k + 3] === 0 && out.data[k + 3] > 150 && out.data[k] < 60 && out.data[k + 1] < 60) found = true;
  }
  assert.ok(found, 'есть тёмная обводка');
  assert.equal(outlineColor('#00ff6a'), '#14110f');
  assert.equal(outlineColor('#000000'), '#ffffff');
  assert.equal(outlineColor('#2f6bff'), '#ffffff');
});
