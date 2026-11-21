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
