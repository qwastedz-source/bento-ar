// Обработка картинки для трафарета на торт.
// Всё считается в квадрате N×N, который соответствует верху торта.

const maskCache = new Map();

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export const MODES = ['lines', 'mix', 'fill', 'photo'];
export const LIMITS = {
  diameter: [6, 20], zoom: [0.2, 3], rot: [-180, 180], offX: [-1.5, 1.5], offY: [-1.5, 1.5],
  thr: [0.03, 0.5], blur: [0, 8], thick: [0.3, 3], minLen: [0, 15],
  fillThr: [10, 245], fillAlpha: [0.15, 1], opacity: [0.1, 1],
};
/** Привести настройки в допустимые рамки (битый localStorage, кнопки в шлеме). */
export function clampSettings(s) {
  const o = { ...s };
  for (const [k, [a, b]] of Object.entries(LIMITS)) {
    if (k in o) o[k] = Number.isFinite(+o[k]) ? clamp(+o[k], a, b) : a;
  }
  if (!MODES.includes(o.mode)) o.mode = 'lines';
  if (o.shape !== 'square') o.shape = 'circle';
  if (typeof o.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(o.color)) o.color = '#00ff6a';
  return o;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Кладём исходник в квадрат: вписываем, потом zoom/сдвиг/поворот/зеркало.
function compose(img, p, N) {
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (img) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const s = (N / Math.max(iw, ih)) * p.zoom;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.translate(N / 2 + p.offX * N, N / 2 + p.offY * N);
    g.rotate((p.rot * Math.PI) / 180);
    g.scale(p.mirror ? -s : s, s);
    g.drawImage(img, -iw / 2, -ih / 2);
  }
  return g.getImageData(0, 0, N, N);
}

function shapeMask(shape, N) {
  const key = shape + N;
  if (maskCache.has(key)) return maskCache.get(key);
  const m = new Float32Array(N * N);
  if (shape === 'square') m.fill(1);
  else {
    const c = N / 2, r = N / 2 - 1;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - c, dy = y + 0.5 - c;
        m[y * N + x] = clamp(r - Math.sqrt(dx * dx + dy * dy) + 0.5, 0, 1);
      }
    }
  }
  maskCache.set(key, m);
  return m;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s * inv;
      s += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s * inv;
      s += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
  return out;
}

// Canny-подобные линии: размытие → Собель → тонкие линии → гистерезис →
// убрать мусор → нарастить до нужной толщины (со сглаживанием краёв).
function lineAlpha(gray, N, p, mmPerPx) {
  const n = N * N;
  let b = gray;
  const blurR = Math.round(p.blur * (N / 1024));
  if (blurR > 0) { b = boxBlur(b, N, N, blurR); b = boxBlur(b, N, N, blurR); }

  const mag = new Float32Array(n), bin = new Uint8Array(n);
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      const tl = b[i - N - 1], t = b[i - N], tr = b[i - N + 1];
      const l = b[i - 1], r = b[i + 1];
      const bl = b[i + N - 1], bo = b[i + N], br = b[i + N + 1];
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * bo + br) - (tl + 2 * t + tr);
      mag[i] = Math.sqrt(gx * gx + gy * gy) / 1020;
      let a = Math.atan2(gy, gx);
      if (a < 0) a += Math.PI;
      const d = a * 57.29578;
      bin[i] = d < 22.5 || d >= 157.5 ? 0 : d < 67.5 ? 1 : d < 112.5 ? 2 : 3;
    }
  }

  const hi = p.thr, lo = p.thr * 0.45;
  const nms = new Float32Array(n);
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const i = y * N + x, m = mag[i];
      if (m < lo) continue;
      let a1, a2;
      switch (bin[i]) {
        case 0: a1 = mag[i - 1]; a2 = mag[i + 1]; break;
        case 1: a1 = mag[i - N - 1]; a2 = mag[i + N + 1]; break;
        case 2: a1 = mag[i - N]; a2 = mag[i + N]; break;
        default: a1 = mag[i - N + 1]; a2 = mag[i + N - 1];
      }
      if (m >= a1 && m > a2) nms[i] = m;
    }
  }

  const edge = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) if (nms[i] >= hi) { edge[i] = 1; stack[sp++] = i; }
  const nb = [-N - 1, -N, -N + 1, -1, 1, N - 1, N, N + 1];
  while (sp) {
    const i = stack[--sp];
    for (let k = 0; k < 8; k++) {
      const j = i + nb[k];
      if (!edge[j] && nms[j] >= lo) { edge[j] = 1; stack[sp++] = j; }
    }
  }

  // убрать короткие обрывки (крошки, шум)
  const minPx = p.minLen / mmPerPx;
  if (minPx > 1.5) {
    const seen = new Uint8Array(n);
    const comp = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (!edge[s] || seen[s]) continue;
      let cn = 0; sp = 0;
      stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const i = stack[--sp];
        comp[cn++] = i;
        for (let k = 0; k < 8; k++) {
          const j = i + nb[k];
          if (j >= 0 && j < n && edge[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
        }
      }
      if (cn < minPx) for (let k = 0; k < cn; k++) edge[comp[k]] = 0;
    }
  }

  // дистанция до линии (chamfer) → толщина с мягким краем
  const INF = 1e9, D2 = Math.SQRT2;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = edge[i] ? 0 : INF;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let v = dist[i];
      if (y > 0) {
        v = Math.min(v, dist[i - N] + 1);
        if (x > 0) v = Math.min(v, dist[i - N - 1] + D2);
        if (x < N - 1) v = Math.min(v, dist[i - N + 1] + D2);
      }
      if (x > 0) v = Math.min(v, dist[i - 1] + 1);
      dist[i] = v;
    }
  }
  for (let y = N - 1; y >= 0; y--) {
    for (let x = N - 1; x >= 0; x--) {
      const i = y * N + x;
      let v = dist[i];
      if (y < N - 1) {
        v = Math.min(v, dist[i + N] + 1);
        if (x > 0) v = Math.min(v, dist[i + N - 1] + D2);
        if (x < N - 1) v = Math.min(v, dist[i + N + 1] + D2);
      }
      if (x < N - 1) v = Math.min(v, dist[i + 1] + 1);
      dist[i] = v;
    }
  }
  const R = Math.max(0.5, p.thick / mmPerPx / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = clamp(R + 0.5 - dist[i], 0, 1);
  return out;
}

/**
 * p: { shape, diameter(см), zoom, offX, offY, rot, mirror, mode, thr, blur, thick(мм),
 *      minLen(мм), fillThr, fillAlpha, invert, color }
 * Возвращает { main, photo } — ImageData N×N (RGBA, фон прозрачный).
 */
export function processAll(img, p, N = 1024) {
  return processImageData(compose(img, p, N), p);
}

// В браузере — настоящий ImageData, в Node (тесты) — объект той же формы.
function makeImage(N) {
  return typeof ImageData !== 'undefined'
    ? new ImageData(N, N)
    : { width: N, height: N, data: new Uint8ClampedArray(N * N * 4) };
}

/** Чистая обработка уже скомпонованного квадрата src ({width, data} RGBA). */
export function processImageData(src, p) {
  const N = src.width;
  const d = src.data, n = N * N;
  const mask = shapeMask(p.shape, N);

  const photo = makeImage(N);
  const pd = photo.data;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    pd[k] = d[k]; pd[k + 1] = d[k + 1]; pd[k + 2] = d[k + 2];
    pd[k + 3] = d[k + 3] * mask[i];
  }
  if (p.mode === 'photo') return { main: photo, photo };

  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i * 4, a = d[k + 3] / 255;
    gray[i] = (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]) * a + 255 * (1 - a);
  }
  const [cr, cg, cb] = hexToRgb(p.color);
  const main = makeImage(N);
  const md = main.data;
  const mmPerPx = (p.diameter * 10) / N;

  if (p.mode === 'fill') {
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      const on = p.invert ? gray[i] > p.fillThr : gray[i] < p.fillThr;
      md[k] = cr; md[k + 1] = cg; md[k + 2] = cb;
      md[k + 3] = on ? p.fillAlpha * 255 * mask[i] : 0;
    }
    return { main, photo };
  }

  const la = lineAlpha(gray, N, p, mmPerPx);
  const mix = p.mode === 'mix';
  for (let i = 0; i < n; i++) {
    const k = i * 4, a = la[i];
    if (!mix) {
      md[k] = cr; md[k + 1] = cg; md[k + 2] = cb;
      md[k + 3] = a * 255 * mask[i];
    } else {
      const pa = (d[k + 3] / 255) * 0.45;
      const oa = a + pa * (1 - a);
      if (oa > 0) {
        md[k] = (cr * a + d[k] * pa * (1 - a)) / oa;
        md[k + 1] = (cg * a + d[k + 1] * pa * (1 - a)) / oa;
        md[k + 2] = (cb * a + d[k + 2] * pa * (1 - a)) / oa;
      } else { md[k] = cr; md[k + 1] = cg; md[k + 2] = cb; }
      md[k + 3] = oa * 255 * mask[i];
    }
  }
  return { main, photo };
}
