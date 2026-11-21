// Чистая геометрия калибровки (без three.js, тестируется в Node).
// Точки: {x, y, z} в метрах, y вверх. Yaw: поворот вокруг Y; верх картинки смотрит в yawToDir(yaw).

export const MIN_POINT_GAP = 0.015; // 1.5 см между точками
export const RIM_R_MIN = 0.02, RIM_R_MAX = 0.16;
export const SIDE_MIN = 0.03, SIDE_MAX = 0.3;

export const flatDist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Куда смотрит верх картинки при данном yaw (поворот вектора (0,0,-1) вокруг Y). */
export function yawToDir(yaw) { return { x: -Math.sin(yaw), z: -Math.cos(yaw) }; }

/** Yaw, при котором верх картинки направлен от головы к точке p («дальняя сторона»). */
export function faceYaw(p, head) {
  const dx = p.x - head.x, dz = p.z - head.z;
  const l = Math.hypot(dx, dz) || 1;
  return Math.atan2(-dx / l, -dz / l);
}

/** Окружность по трём точкам в плоскости XZ. null, если точки на одной прямой. */
export function circle3(a, b, c) {
  const d = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
  if (Math.abs(d) < 1e-9) return null;
  const A = a.x * a.x + a.z * a.z, B = b.x * b.x + b.z * b.z, C = c.x * c.x + c.z * c.z;
  const x = (A * (b.z - c.z) + B * (c.z - a.z) + C * (a.z - b.z)) / d;
  const z = (A * (c.x - b.x) + B * (a.x - c.x) + C * (b.x - a.x)) / d;
  return { x, z, r: Math.hypot(a.x - x, a.z - z) };
}

export function tooClose(pts, p) { return pts.some((q) => flatDist(q, p) < MIN_POINT_GAP); }

export function median(arr) {
  const a = [...arr].sort((p, q) => p - q), n = a.length;
  if (!n) return NaN;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
/** Медиана по осям: гасит дрожание руки и рывок при нажатии курка. */
export function medianPoint(samples) {
  return { x: median(samples.map((s) => s.x)), y: median(samples.map((s) => s.y)), z: median(samples.map((s) => s.z)) };
}

function solve3(M, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(M);
  if (Math.abs(d) < 1e-18) return null;
  return [0, 1, 2].map((k) => det(M.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / d);
}

/** Окружность по 3+ точкам методом наименьших квадратов (Kåsa). rms — разброс точек от круга, м. */
export function fitCircleLSQ(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, mz = 0;
  for (const p of pts) { mx += p.x; mz += p.z; }
  mx /= n; mz /= n;
  let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, sxr = 0, szr = 0, sr = 0;
  for (const p of pts) {
    const x = p.x - mx, z = p.z - mz, r = x * x + z * z;
    sxx += x * x; sxz += x * z; szz += z * z; sx += x; sz += z; sxr += x * r; szr += z * r; sr += r;
  }
  const sol = solve3([[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, n]], [-sxr, -szr, -sr]);
  if (!sol) return null;
  const [D, E, F] = sol;
  const cx = -D / 2, cz = -E / 2, r2 = cx * cx + cz * cz - F;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let ss = 0;
  for (const p of pts) { const e = Math.hypot(p.x - mx - cx, p.z - mz - cz) - r; ss += e * e; }
  return { x: cx + mx, z: cz + mz, r, rms: Math.sqrt(ss / n) };
}

export const RIM_RMS_MAX = 0.005; // точка дальше 5 мм от круга считается промахом

/** Круглый торт по 3+ точкам края → { x, y, z, diam, yaw, rms } или { error }. */
export function fitRim(pts, head) {
  const c = fitCircleLSQ(pts);
  if (!c || c.r < RIM_R_MIN || c.r > RIM_R_MAX) return { error: 'Точки не похожи на край торта, давай заново' };
  if (pts.length > 3 && c.rms > RIM_RMS_MAX) return { error: 'Эта точка мимо края, не засчитана', miss: true };
  const y = median(pts.map((p) => p.y));
  return { x: c.x, y, z: c.z, diam: 2 * c.r, yaw: faceYaw({ x: c.x, z: c.z }, head), rms: c.rms };
}

/**
 * Насколько подтянуть картинку к новой позе якоря: 0 = не трогать (микродрожь),
 * 1 = прыгнуть сразу (большая коррекция), иначе плавно.
 */
export function anchorBlend(dist, ang, dt, { eps = 0.0007, epsAng = 0.002, snap = 0.03, tau = 0.15 } = {}) {
  if (dist < eps && ang < epsAng) return 0;
  if (dist > snap) return 1;
  return 1 - Math.exp(-dt / tau);
}

/** Квадратный торт по двум ближним углам (в любом порядке) → { x, y, z, diam, yaw } или { error }. */
export function fitSquare(a, b, head) {
  const side = flatDist(a, b);
  if (side < SIDE_MIN || side > SIDE_MAX) return { error: 'Странный размер, давай заново' };
  const ex = (b.x - a.x) / side, ez = (b.z - a.z) / side;
  let nx = -ez, nz = ex;
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  if (nx * (mx - head.x) + nz * (mz - head.z) < 0) { nx = -nx; nz = -nz; } // внутрь торта = от себя
  return {
    x: mx + (nx * side) / 2, y: (a.y + b.y) / 2, z: mz + (nz * side) / 2,
    diam: side, yaw: Math.atan2(-nx, -nz),
  };
}

/** Центр (1 точка) → положение с размером по настройкам. */
export function fitCenter(p, head, diam) {
  return { x: p.x, y: p.y, z: p.z, diam, yaw: faceYaw(p, head) };
}
