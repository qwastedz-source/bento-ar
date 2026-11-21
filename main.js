import { processAll } from './imageproc.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const LS_SET = 'bk_settings_v1';
const LS_IMG = 'bk_image_v1';
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

const DEF = {
  shape: 'circle', diameter: 10, zoom: 1, offX: 0, offY: 0, rot: 0, mirror: false,
  mode: 'lines', thr: 0.12, blur: 2, thick: 0.8, minLen: 2, fillThr: 110, fillAlpha: 0.5,
  invert: false, color: '#00ff6a', opacity: 0.85,
};
const COLORS = ['#00ff6a', '#ff2bd6', '#00e5ff', '#ffe600', '#ff3b30', '#2f6bff', '#000000', '#ffffff'];

const S = { ...DEF, ...(LS.get(LS_SET) || {}) };
let img = null;
let result = null;

const FMT = {
  diameter: (v) => `${(+v).toFixed(1)} см`,
  zoom: (v) => `×${(+v).toFixed(2)}`,
  rot: (v) => `${Math.round(v)}°`,
  thr: (v) => (+v).toFixed(2),
  blur: (v) => `${v}`,
  thick: (v) => `${(+v).toFixed(1)} мм`,
  minLen: (v) => `${(+v).toFixed(1)} мм`,
  fillThr: (v) => `${v}`,
  fillAlpha: (v) => `${Math.round(v * 100)}%`,
  opacity: (v) => `${Math.round(v * 100)}%`,
};

function save() { LS.set(LS_SET, S); }

// ---------- UI ----------
function syncUI() {
  for (const el of $$('[data-k]')) {
    const k = el.dataset.k;
    if (el.type === 'checkbox') el.checked = !!S[k];
    else el.value = S[k];
  }
  for (const o of $$('output[data-for]')) {
    const k = o.dataset.for;
    o.textContent = FMT[k] ? FMT[k](S[k]) : S[k];
  }
  for (const seg of $$('[data-seg]')) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(S[seg.dataset.seg] === b.dataset.v));
  }
  for (const b of $$('[data-set]')) b.setAttribute('aria-pressed', String(+S[b.dataset.set] === +b.dataset.v));
  for (const el of $$('[data-show]')) el.hidden = !el.dataset.show.split(' ').includes(S.mode);
  for (const b of $$('#swatches button')) b.setAttribute('aria-pressed', String(b.dataset.c === S.color));
}

function buildSwatches() {
  const box = $('#swatches');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.style.background = c;
    b.dataset.c = c;
    b.title = c;
    b.setAttribute('aria-label', `Цвет ${c}`);
    b.onclick = () => { S.color = c; changed(); };
    box.appendChild(b);
  }
}

function changed(fast = false) { save(); syncUI(); schedule(fast); }

for (const el of $$('[data-k]')) {
  el.addEventListener('input', () => {
    const k = el.dataset.k;
    S[k] = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
    changed(el.type === 'range');
  });
}
for (const seg of $$('[data-seg]')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S[seg.dataset.seg] = b.dataset.v;
    changed();
  });
}
for (const b of $$('[data-set]')) b.addEventListener('click', () => { S[b.dataset.set] = parseFloat(b.dataset.v); changed(); });
$('#resetPos').onclick = () => { S.zoom = 1; S.offX = 0; S.offY = 0; S.rot = 0; changed(); };

// ---------- rendering ----------
let timer = null;
function render(N) {
  const t0 = performance.now();
  result = processAll(img, S, N);
  drawPreview();
  if (N >= 1024) $('#info').textContent = `Ø ${S.diameter.toFixed(1)} см · ${N}×${N} px · ${(S.diameter * 10 / N).toFixed(2)} мм/px · ${Math.round(performance.now() - t0)} мс`;
}
function schedule(fast) {
  clearTimeout(timer);
  if (fast) render(512);
  timer = setTimeout(() => render(1024), fast ? 250 : 30);
}

const pv = $('#preview');
const pg = pv.getContext('2d');
const tmp = document.createElement('canvas');
function drawPreview() {
  const P = pv.width, m = P * 0.08, size = P - 2 * m;
  pg.clearRect(0, 0, P, P);
  const grd = pg.createLinearGradient(0, 0, P, P);
  grd.addColorStop(0, '#3a302b'); grd.addColorStop(1, '#241e1b');
  pg.fillStyle = grd; pg.fillRect(0, 0, P, P);

  pg.save();
  pg.shadowColor = 'rgba(0,0,0,0.45)'; pg.shadowBlur = 40; pg.shadowOffsetY = 14;
  pg.fillStyle = '#f8efe5';
  pg.beginPath();
  if (S.shape === 'square') pg.rect(m, m, size, size); else pg.arc(P / 2, P / 2, size / 2, 0, Math.PI * 2);
  pg.fill();
  pg.restore();

  if (result) {
    const N = result.main.width;
    tmp.width = tmp.height = N;
    tmp.getContext('2d').putImageData(result.main, 0, 0);
    pg.globalAlpha = S.opacity;
    pg.imageSmoothingQuality = 'high';
    pg.drawImage(tmp, m, m, size, size);
    pg.globalAlpha = 1;
  }

  pg.strokeStyle = 'rgba(0,229,255,0.9)'; pg.lineWidth = 3; pg.setLineDash([14, 10]);
  pg.beginPath();
  if (S.shape === 'square') pg.rect(m, m, size, size); else pg.arc(P / 2, P / 2, size / 2, 0, Math.PI * 2);
  pg.stroke(); pg.setLineDash([]);

  pg.fillStyle = 'rgba(255,255,255,0.75)';
  pg.font = '600 30px system-ui, sans-serif';
  pg.fillText(`${S.shape === 'square' ? 'сторона' : 'Ø'} ${S.diameter.toFixed(1)} см`, 24, P - 24);
  pg.textAlign = 'right';
  pg.fillText('↑ дальняя сторона', P - 24, 44);
  pg.textAlign = 'left';
}

// drag / zoom on preview
const ptrs = new Map();
let pinchD = 0;
pv.addEventListener('pointerdown', (e) => { pv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
pv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  const prev = ptrs.get(e.pointerId);
  const cur = { x: e.clientX, y: e.clientY };
  ptrs.set(e.pointerId, cur);
  const rect = pv.getBoundingClientRect();
  const cakePx = rect.width * 0.84;
  if (ptrs.size === 1) {
    S.offX += (cur.x - prev.x) / cakePx;
    S.offY += (cur.y - prev.y) / cakePx;
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchD) S.zoom = Math.min(3, Math.max(0.2, S.zoom * (d / pinchD)));
    pinchD = d;
  }
  changed(true);
});
const endPtr = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinchD = 0; };
pv.addEventListener('pointerup', endPtr);
pv.addEventListener('pointercancel', endPtr);
pv.addEventListener('wheel', (e) => {
  e.preventDefault();
  S.zoom = Math.min(3, Math.max(0.2, S.zoom * Math.exp(-e.deltaY * 0.001)));
  changed(true);
}, { passive: false });

// ---------- loading images ----------
function loadImage(src, cors = false) {
  return new Promise((res, rej) => {
    const im = new Image();
    if (cors) im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('load'));
    im.src = src;
  });
}

function persistImage(im) {
  const max = 1400;
  const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
  const s = Math.min(1, max / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.round(iw * s); c.height = Math.round(ih * s);
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  let url = c.toDataURL('image/png');
  if (url.length > 3_000_000) url = c.toDataURL('image/jpeg', 0.9);
  if (!LS.set(LS_IMG, url)) LS.set(LS_IMG, c.toDataURL('image/jpeg', 0.75));
}

async function useImage(im, persist = true) {
  img = im;
  if (persist) persistImage(im);
  S.zoom = 1; S.offX = 0; S.offY = 0; S.rot = 0;
  changed();
}

$('#file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try { await useImage(await loadImage(URL.createObjectURL(f))); }
  catch { alert('Не получилось открыть этот файл как картинку.'); }
  e.target.value = '';
});
$('#urlBtn').onclick = async () => {
  const u = $('#url').value.trim();
  if (!u) return;
  try { await useImage(await loadImage(u, true)); }
  catch { alert('Сайт не отдал картинку (часто так из-за защиты). Скачай её и выбери файлом.'); }
};
window.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  try { await useImage(await loadImage(URL.createObjectURL(item.getAsFile()))); } catch {}
});
$('#demo').onclick = async () => useImage(await loadImage(makeDemo()));

function makeDemo() {
  const c = document.createElement('canvas');
  c.width = c.height = 800;
  const g = c.getContext('2d');
  g.lineWidth = 14; g.strokeStyle = '#1b1210'; g.lineJoin = 'round'; g.lineCap = 'round';
  const circ = (x, y, r, fill, stroke = true) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); if (stroke) g.stroke(); };
  const ell = (x, y, rx, ry, fill, stroke = true) => { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); if (stroke) g.stroke(); };
  circ(215, 215, 105, '#c68b59'); circ(585, 215, 105, '#c68b59');
  circ(215, 215, 52, '#f2c8a2', false); circ(585, 215, 52, '#f2c8a2', false);
  circ(400, 440, 275, '#c68b59');
  ell(400, 530, 135, 100, '#f3dec4');
  circ(295, 400, 30, '#1b1210', false); circ(505, 400, 30, '#1b1210', false);
  circ(306, 389, 9, '#fff', false); circ(516, 389, 9, '#fff', false);
  ell(400, 488, 46, 32, '#1b1210', false);
  g.beginPath(); g.moveTo(400, 515); g.lineTo(400, 560);
  g.moveTo(340, 565); g.quadraticCurveTo(370, 600, 400, 560); g.quadraticCurveTo(430, 600, 460, 565); g.stroke();
  ell(225, 525, 46, 26, '#f4a3ad', false); ell(575, 525, 46, 26, '#f4a3ad', false);
  return c.toDataURL('image/png');
}

// ---------- XR ----------
const xrModP = import('./xr.js').catch((e) => { console.error(e); return null; });
let xrOK = false;
const xs = $('#xrStatus');
(async () => {
  if (!window.isSecureContext) { xs.textContent = 'Нужен https (или localhost), иначе браузер не даст включить AR.'; xs.className = 'hint bad'; return; }
  if (!navigator.xr?.isSessionSupported) { xs.textContent = 'В этом браузере нет WebXR. Открой страницу в браузере Quest 3. Картинку можно подготовить и здесь, но сохранится она только на этом устройстве.'; xs.className = 'hint bad'; return; }
  try { xrOK = await navigator.xr.isSessionSupported('immersive-ar'); } catch { xrOK = false; }
  xs.textContent = xrOK ? 'AR доступен ✓' : 'Этот браузер не поддерживает AR passthrough. Открой страницу в Quest Browser.';
  xs.className = 'hint ' + (xrOK ? 'ok' : 'bad');
})();

$('#enterAR').onclick = async () => {
  if (!xrOK) { alert('AR недоступен в этом браузере. Открой эту страницу в браузере Quest 3.'); return; }
  clearTimeout(timer);
  render(1024);
  const mod = await xrModP;
  if (!mod) { alert('Не загрузился 3D-движок (нет интернета?). Обнови страницу.'); return; }
  try {
    await mod.startXR({
      main: result.main,
      photo: result.photo,
      shape: S.shape,
      diameterCm: S.diameter,
      opacity: S.opacity,
      onEnd: (r) => {
        S.opacity = r.opacity;
        if (r.diameterCm) S.diameter = Math.round(r.diameterCm * 10) / 10;
        changed();
      },
    });
  } catch (e) {
    console.error(e);
    alert('Не удалось запустить AR: ' + (e?.message || e));
  }
};

// ---------- boot ----------
buildSwatches();
syncUI();
(async () => {
  const saved = LS.get(LS_IMG);
  try { img = await loadImage(saved || makeDemo()); } catch { img = await loadImage(makeDemo()); }
  if (!saved) persistImage(img);
  render(1024);
})();
