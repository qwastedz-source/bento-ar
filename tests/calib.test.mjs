import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circle3, fitRim, fitSquare, fitCenter, faceYaw, yawToDir, tooClose, flatDist } from '../calib.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const onCircle = (cx, cz, r, ang, y = 0.8) => ({ x: cx + r * Math.cos(ang), y, z: cz + r * Math.sin(ang) });
const head = { x: 0, y: 1.2, z: 0 };

test('circle3: находит центр и радиус', () => {
  const c = circle3(onCircle(0.1, -0.4, 0.05, 0), onCircle(0.1, -0.4, 0.05, 2), onCircle(0.1, -0.4, 0.05, 4));
  near(c.x, 0.1); near(c.z, -0.4); near(c.r, 0.05);
});

test('circle3: точки на одной прямой → null', () => {
  assert.equal(circle3({ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 2 }), null);
});

test('yawToDir совпадает с поворотом (0,0,-1) вокруг Y (как в three.js)', () => {
  for (const yaw of [0, 0.3, 1.2, -2, Math.PI]) {
    // матрица поворота вокруг Y: x' = x cos + z sin, z' = -x sin + z cos
    const x = 0 * Math.cos(yaw) + -1 * Math.sin(yaw);
    const z = -0 * Math.sin(yaw) + -1 * Math.cos(yaw);
    const d = yawToDir(yaw);
    near(d.x, x); near(d.z, z);
  }
});

test('faceYaw: верх картинки смотрит от головы', () => {
  const p = { x: 0.3, z: -0.4 };
  const d = yawToDir(faceYaw(p, head));
  near(d.x, 0.6); near(d.z, -0.8);
});

test('fitRim: 10-сантиметровый торт', () => {
  const pts = [onCircle(0.05, -0.45, 0.05, 0.2, 0.81), onCircle(0.05, -0.45, 0.05, 2.4, 0.80), onCircle(0.05, -0.45, 0.05, 4.4, 0.79)];
  const r = fitRim(pts, head);
  assert.equal(r.error, undefined);
  near(r.x, 0.05); near(r.z, -0.45); near(r.y, 0.80); near(r.diam, 0.10);
  const d = yawToDir(r.yaw);
  const l = Math.hypot(0.05, 0.45);
  near(d.x, 0.05 / l); near(d.z, -0.45 / l);
});

test('fitRim: слишком большой или кривой круг → ошибка', () => {
  const big = [onCircle(0, -1, 0.5, 0), onCircle(0, -1, 0.5, 2), onCircle(0, -1, 0.5, 4)];
  assert.ok(fitRim(big, head).error);
  assert.ok(fitRim([{ x: 0, y: 0, z: 0 }, { x: 0.05, y: 0, z: 0 }, { x: 0.1, y: 0, z: 0 }], head).error);
  assert.ok(fitRim([{ x: 0, y: 0, z: 0 }], head).error);
});

test('fitSquare: центр уходит от себя, порядок углов не важен', () => {
  const a = { x: -0.05, y: 0.8, z: -0.3 }, b = { x: 0.05, y: 0.8, z: -0.3 };
  for (const [p, q] of [[a, b], [b, a]]) {
    const r = fitSquare(p, q, head);
    near(r.x, 0); near(r.z, -0.35); near(r.y, 0.8); near(r.diam, 0.1);
    const d = yawToDir(r.yaw);
    near(d.x, 0); near(d.z, -1);
  }
});

test('fitSquare: странный размер → ошибка', () => {
  assert.ok(fitSquare({ x: 0, y: 0, z: 0 }, { x: 0.01, y: 0, z: 0 }, head).error);
  assert.ok(fitSquare({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }, head).error);
});

test('fitCenter берёт размер из настроек', () => {
  const r = fitCenter({ x: 0.1, y: 0.9, z: -0.5 }, head, 0.12);
  assert.equal(r.diam, 0.12); near(r.y, 0.9);
});

test('tooClose: защита от двойного нажатия', () => {
  const pts = [{ x: 0, y: 0, z: 0 }];
  assert.equal(tooClose(pts, { x: 0.01, y: 0.5, z: 0 }), true);
  assert.equal(tooClose(pts, { x: 0.03, y: 0, z: 0 }), false);
  near(flatDist({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
});

// ---------- точность: МНК-круг, медиана, сглаживание якоря ----------
import { fitCircleLSQ, median, medianPoint, anchorBlend } from '../calib.js';

// детерминированный «шум» ±amp
function noise(seed, amp) { let s = seed; return () => { s = (s * 16807) % 2147483647; return ((s / 2147483647) * 2 - 1) * amp; }; }

test('fitCircleLSQ: 3 точки = точный круг, rms 0', () => {
  const c = fitCircleLSQ([onCircle(0.1, -0.4, 0.05, 0), onCircle(0.1, -0.4, 0.05, 2), onCircle(0.1, -0.4, 0.05, 4)]);
  near(c.x, 0.1, 1e-9); near(c.z, -0.4, 1e-9); near(c.r, 0.05, 1e-9); near(c.rms, 0, 1e-9);
});

test('fitCircleLSQ: 8 точек с дрожанием ±1.5 мм → центр точнее 1 мм', () => {
  const n = noise(7, 0.0015);
  const pts = Array.from({ length: 8 }, (_, i) => {
    const p = onCircle(0.02, -0.42, 0.055, (i / 8) * Math.PI * 2);
    return { x: p.x + n(), y: p.y, z: p.z + n() };
  });
  const c = fitCircleLSQ(pts);
  assert.ok(Math.hypot(c.x - 0.02, c.z + 0.42) < 0.001, 'центр');
  near(c.r, 0.055, 0.001);
  assert.ok(c.rms > 0 && c.rms < 0.002);
});

test('fitRim: больше точек → точнее, чем по трём', () => {
  const n = noise(11, 0.002);
  const all = Array.from({ length: 8 }, (_, i) => {
    const p = onCircle(0, -0.4, 0.05, (i / 8) * Math.PI * 2 + 0.3);
    return { x: p.x + n(), y: 0.8, z: p.z + n() };
  });
  const err = (r) => Math.hypot(r.x, r.z + 0.4);
  const e3 = [0, 3, 5].map((i) => all[i]);
  assert.ok(err(fitRim(all, head)) <= err(fitRim(e3, head)) + 1e-12);
});

test('fitRim: промах мимо края отбрасывается', () => {
  const pts = [0, 1.5, 3, 4.5].map((a) => onCircle(0, -0.4, 0.05, a));
  pts.push({ x: 0, y: 0.8, z: -0.4 }); // точка в центре, не на краю
  const r = fitRim(pts, head);
  assert.ok(r.error && r.miss);
});

test('fitRim: высота — медиана, один выброс не портит', () => {
  const pts = [0, 1.6, 3.2, 4.8].map((a, i) => onCircle(0, -0.4, 0.05, a, [0.80, 0.801, 0.80, 0.83][i]));
  near(fitRim(pts, head).y, 0.8005, 1e-9);
});

test('median / medianPoint', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
  const m = medianPoint([{ x: 0, y: 0, z: 0 }, { x: 1, y: 5, z: 1 }, { x: 0.1, y: 0.1, z: 9 }]);
  assert.deepEqual(m, { x: 0.1, y: 0.1, z: 1 }); // рывок (5 и 9) погашен
});

test('anchorBlend: дрожь игнор, поправка плавно, скачок сразу', () => {
  assert.equal(anchorBlend(0.0003, 0.001, 1 / 72), 0);
  const k = anchorBlend(0.003, 0, 1 / 72);
  assert.ok(k > 0 && k < 0.2, `плавно: ${k}`);
  assert.equal(anchorBlend(0.05, 0, 1 / 72), 1);
  assert.ok(anchorBlend(0, 0.01, 1 / 72) > 0, 'поворот тоже учитывается');
});
