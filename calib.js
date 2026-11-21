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

/** Круглый торт по 3 точкам края → { x, y, z, diam, yaw } или { error }. */
export function fitRim(pts, head) {
  const c = pts.length === 3 ? circle3(pts[0], pts[1], pts[2]) : null;
  if (!c || c.r < RIM_R_MIN || c.r > RIM_R_MAX) return { error: 'Точки не похожи на край торта, давай заново' };
  const y = (pts[0].y + pts[1].y + pts[2].y) / 3;
  return { x: c.x, y, z: c.z, diam: 2 * c.r, yaw: faceYaw({ x: c.x, z: c.z }, head) };
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
