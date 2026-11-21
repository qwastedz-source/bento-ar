import { processAll, clampSettings } from './imageproc.js';
import { listImages, addImage, touchImage, deleteImage } from './store.js';
import { makeCode, isValidCode, sendUrl, startReceiver, loadScript, QR_URL } from './transfer.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const LS_SET = 'bk_settings_v1';
const LS_IMG_OLD = 'bk_image_v1';
const LS_CODE = 'bk_phone_code';
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const DEF = {
  shape: 'circle', diameter: 10, zoom: 1, offX: 0, offY: 0, rot: 0, mirror: false,
  mode: 'lines', thr: 0.12, blur: 2, thick: 0.8, minLen: 2, fillThr: 110, fillAlpha: 0.5,
  invert: false, color: '#00ff6a', opacity: 0.85,
};
const COLORS = ['#00ff6a', '#ff2bd6', '#00e5ff', '#ffe600', '#ff3b30', '#2f6bff', '#000000', '#ffffff'];
const S = clampSettings({ ...DEF, ...(LS.get(LS_SET) || {}) });

let img = null;
let currentId = null;
let result = null;
let xr = null; // модуль xr.js
const xrModP = import('./xr.js').then((m) => (xr = m)).catch((e) => { console.error(e); return null; });

const FMT = {
  zoom: (v) => `×${(+v).toFixed(2)}`,
  rot: (v) => `${Math.round(v)}°`,
  thr: (v) => (v < 0.08 ? 'много' : v < 0.18 ? 'средне' : v < 0.3 ? 'мало' : 'минимум'),
  blur: (v) => (+v ? `${v}` : 'выкл'),
  thick: (v) => `${(+v).toFixed(1)} мм`,
  minLen: (v) => (+v ? `${(+v).toFixed(1)} мм` : 'выкл'),
  fillThr: (v) => `${v}`,
  fillAlpha: (v) => `${Math.round(v * 100)}%`,
  opacity: (v) => `${Math.round(v * 100)}%`,
};

function save() { LS.set(LS_SET, S); }

let toastT = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- UI sync ----------
function paintRange(el) {
  const p = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--p', `${p}%`);
}
function syncUI() {
  for (const el of $$('[data-k]')) {
    const k = el.dataset.k;
    if (el.type === 'checkbox') el.checked = !!S[k];
    else { el.value = S[k]; paintRange(el); }
  }
  for (const o of $$('output[data-for]')) {
    const k = o.dataset.for;
    o.textContent = FMT[k] ? FMT[k](S[k]) : S[k];
  }
  for (const seg of $$('[data-seg]')) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(S[seg.dataset.seg] === b.dataset.v));
  }
  for (const b of $$('[data-set]')) b.setAttribute('aria-pressed', String(Math.abs(S[b.dataset.set] - b.dataset.v) < 0.05));
  for (const el of $$('[data-show]')) el.hidden = !el.dataset.show.split(' ').includes(S.mode);
  for (const b of $$('#swatches button')) b.setAttribute('aria-pressed', String(b.dataset.c === S.color));
  $('#diamVal').innerHTML = `${S.diameter.toFixed(1)} <small>см</small>`;
  $('#diamLabel').textContent = S.shape === 'square' ? 'Сторона верха' : 'Диаметр верха';
  $$('[data-tool="mirror"]').forEach((b) => b.setAttribute('aria-pressed', String(!!S.mirror)));
}

function changed(fast = false) { save(); syncUI(); schedule(fast); }

for (const c of COLORS) {
  const b = document.createElement('button');
  b.style.background = c;
  b.dataset.c = c;
  b.setAttribute('aria-label', `Цвет ${c}`);
  b.onclick = () => { S.color = c; changed(); };
  $('#swatches').appendChild(b);
}
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
for (const b of $$('[data-step]')) {
  b.addEventListener('click', () => {
    S.diameter = Math.min(20, Math.max(6, Math.round((S.diameter + parseFloat(b.dataset.step)) * 10) / 10));
    changed();
  });
}
const TOOLS = {
  zoomIn: () => { S.zoom = Math.min(3, S.zoom * 1.1); },
  zoomOut: () => { S.zoom = Math.max(0.2, S.zoom / 1.1); },
  rotL: () => { S.rot = ((S.rot - 15 + 540) % 360) - 180; },
  rotR: () => { S.rot = ((S.rot + 15 + 540) % 360) - 180; },
  mirror: () => { S.mirror = !S.mirror; },
  center: () => { S.zoom = 1; S.offX = 0; S.offY = 0; S.rot = 0; },
};
for (const b of $$('[data-tool]')) b.addEventListener('click', () => { TOOLS[b.dataset.tool](); changed(); });

for (const t of $$('[role="tab"]')) {
  t.addEventListener('click', () => {
    for (const x of $$('[role="tab"]')) x.setAttribute('aria-selected', String(x === t));
    for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== t.dataset.tab;
  });
}

// ---------- rendering ----------
let timer = null;
function params() {
  const md = xr?.measuredDiameterCm?.();
  return md ? { ...S, diameter: md } : S;
}
function render(N) {
  const t0 = performance.now();
  result = processAll(img, params(), N);
  drawPreview();
  // в AR любое изменение (фото с телефона, меню в шлеме) сразу уходит на торт
  if (N >= 1024 && xr?.isActive?.()) xr.updateImages(result.main, result.photo);
  if (N >= 1024) $('#info').textContent = `${(S.diameter * 10 / N).toFixed(2)} мм/px · ${Math.round(performance.now() - t0)} мс`;
}
function schedule(fast) {
  clearTimeout(timer);
  if (fast) render(512);
  timer = setTimeout(() => render(1024), fast ? 250 : 30);
}

const pv = $('#preview');
const pg = pv.getContext('2d');
const tmp = document.createElement('canvas');
function cakePath(P, m, size) {
  pg.beginPath();
  if (S.shape === 'square') pg.roundRect ? pg.roundRect(m, m, size, size, 18) : pg.rect(m, m, size, size);
  else pg.arc(P / 2, P / 2, size / 2, 0, Math.PI * 2);
}
function drawPreview() {
  const P = pv.width, m = P * 0.09, size = P - 2 * m;
  const bg = pg.createRadialGradient(P / 2, P * 0.4, P * 0.1, P / 2, P / 2, P * 0.75);
  bg.addColorStop(0, '#4a3a32'); bg.addColorStop(1, '#221b18');
  pg.fillStyle = bg; pg.fillRect(0, 0, P, P);

  // доска под тортом
  pg.save();
  pg.fillStyle = 'rgba(255,255,255,0.06)';
  pg.beginPath();
  if (S.shape === 'square') pg.rect(m - 26, m - 26, size + 52, size + 52); else pg.arc(P / 2, P / 2, size / 2 + 30, 0, Math.PI * 2);
  pg.fill();
  pg.restore();

  pg.save();
  pg.shadowColor = 'rgba(0,0,0,0.5)'; pg.shadowBlur = 50; pg.shadowOffsetY = 18;
  const cream = pg.createRadialGradient(P * 0.42, P * 0.38, size * 0.05, P / 2, P / 2, size * 0.62);
  cream.addColorStop(0, '#fffaf4'); cream.addColorStop(1, '#efe0cf');
  pg.fillStyle = cream;
  cakePath(P, m, size); pg.fill();
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

  pg.strokeStyle = 'rgba(0,229,255,0.85)'; pg.lineWidth = 3; pg.setLineDash([14, 10]);
  cakePath(P, m, size); pg.stroke(); pg.setLineDash([]);

  pg.font = '800 28px Nunito, system-ui, sans-serif';
  pg.fillStyle = 'rgba(255,255,255,0.8)';
  pg.textAlign = 'center';
  pg.fillText('▲ дальняя сторона', P / 2, m - 34 > 30 ? 46 : 40);
  pg.textAlign = 'left';
  pg.fillText(`${S.shape === 'square' ? '□' : 'Ø'} ${S.diameter.toFixed(1)} см`, 26, P - 28);
}

// перетаскивание / масштаб на превью
const ptrs = new Map();
let pinchD = 0;
pv.addEventListener('pointerdown', (e) => { pv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
pv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  const prev = ptrs.get(e.pointerId);
  const cur = { x: e.clientX, y: e.clientY };
  ptrs.set(e.pointerId, cur);
  const cakePx = pv.getBoundingClientRect().width * 0.82;
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

// ---------- картинки ----------
function loadImage(src, cors = false) {
  return new Promise((res, rej) => {
    const im = new Image();
    if (cors) im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('load'));
    im.src = src;
  });
}

// Уменьшаем до 1600 px и сохраняем в «недавние».
async function storeImage(im, name, hasAlpha) {
  const max = 1600;
  const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
  const s = Math.min(1, max / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(iw * s)); c.height = Math.max(1, Math.round(ih * s));
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, hasAlpha ? 'image/png' : 'image/jpeg', 0.92));
  try { return await addImage(blob, name); } catch { return null; }
}

async function useImage(im, { name = 'картинка', store = true, hasAlpha = true, keepPos = false } = {}) {
  img = im;
  currentId = store ? await storeImage(im, name, hasAlpha) : null;
  if (!keepPos) { S.zoom = 1; S.offX = 0; S.offY = 0; S.rot = 0; }
  changed();
  renderTiles();
}
async function useBlob(blob, name, opts = {}) {
  const url = URL.createObjectURL(blob);
  try {
    const im = await loadImage(url);
    await useImage(im, { name, hasAlpha: blob.type !== 'image/jpeg', ...opts });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

let tileUrls = [];
async function renderTiles() {
  let recs = [];
  try { recs = await listImages(); } catch {}
  tileUrls.forEach((u) => URL.revokeObjectURL(u));
  tileUrls = [];
  const box = $('#tiles');
  box.querySelectorAll('.tile.rec').forEach((t) => t.remove());
  for (const rec of recs) {
    const url = URL.createObjectURL(rec.blob);
    tileUrls.push(url);
    const t = document.createElement('div');
    t.className = 'tile rec' + (rec.id === currentId ? ' current' : '');
    t.tabIndex = 0;
    t.title = rec.name || '';
    t.innerHTML = '<img alt=""><button class="del" aria-label="Удалить"><svg class="i"><use href="#i-x"/></svg></button>';
    t.querySelector('img').src = url;
    const pick = async () => {
      const im = await loadImage(url);
      img = im; currentId = rec.id;
      try { await touchImage(rec); } catch {}
      S.zoom = 1; S.offX = 0; S.offY = 0; S.rot = 0;
      changed();
      renderTiles();
    };
    t.addEventListener('click', (e) => { if (!e.target.closest('.del')) pick(); });
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    t.querySelector('.del').addEventListener('click', async () => {
      try { await deleteImage(rec.id); } catch {}
      if (rec.id === currentId) currentId = null;
      renderTiles();
    });
    box.appendChild(t);
  }
}

$('#file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try { await useBlob(f, f.name); toast('Картинка загружена'); }
  catch { toast('Не получилось открыть этот файл'); }
  e.target.value = '';
});
$('#urlBtn').onclick = async () => {
  const u = $('#url').value.trim();
  if (!u) return;
  try { await useImage(await loadImage(u, true), { name: 'по ссылке' }); $('#url').value = ''; }
  catch { toast('Сайт не отдаёт картинку. Скачай её или пришли с телефона'); }
};
window.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  try { await useBlob(item.getAsFile(), 'из буфера'); toast('Вставлено из буфера'); } catch {}
});
$('#demo').onclick = async () => { await useImage(await loadImage(makeDemo()), { store: false }); };

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

// ---------- телефон → шлем ----------
const PHONE_STATUS = {
  starting: ['подключаюсь…', ''], ready: ['ждёт фото с телефона', 'ok'], phone: ['телефон подключён', 'live'],
  receiving: ['получаю фото…', 'live'], reconnecting: ['переподключаюсь…', 'warn'], busy: ['код занят, жду…', 'warn'],
  taken: ['код открыт в другой вкладке', 'warn'], offline: ['нет связи, повторяю…', 'warn'],
  nolib: ['нет интернета?', 'warn'], error: ['ошибка связи', 'warn'],
};
let receiver = null;
let phoneCode = LS.get(LS_CODE);
function setPhoneStatus(s) {
  const [text, cls] = PHONE_STATUS[s] || PHONE_STATUS.error;
  for (const el of [$('#phoneStatus'), $('#phonePill')]) {
    el.textContent = el.id === 'phonePill' ? `Телефон: ${text.replace(/^телефон |с телефона$/g, '').trim()}` : text;
    el.className = 'pill ' + cls;
  }
  $('#phonePill').hidden = false;
}
async function onPhoneImage(blob, name) {
  await useBlob(blob, name);
  toast(`Фото с телефона: ${name}`);
  if ($('#phoneDlg').open) $('#phoneDlg').close();
  if (xr?.isActive?.()) xr.notify('Новая картинка с телефона');
}

// ---------- мостик для меню в шлеме ----------
async function recentForXR() {
  let recs = [];
  try { recs = await listImages(); } catch {}
  const out = [];
  for (const r of recs.slice(0, 8)) {
    try {
      const bmp = await createImageBitmap(r.blob);
      const c = document.createElement('canvas');
      c.width = c.height = 240;
      const s = Math.max(240 / bmp.width, 240 / bmp.height);
      c.getContext('2d').drawImage(bmp, (240 - bmp.width * s) / 2, (240 - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
      bmp.close?.();
      out.push({ id: r.id, img: c, current: r.id === currentId });
    } catch {}
  }
  return out;
}
async function pickRecentForXR(id) {
  const rec = (await listImages()).find((r) => r.id === id);
  if (!rec) throw new Error('нет картинки');
  const url = URL.createObjectURL(rec.blob);
  try { img = await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  currentId = rec.id;
  touchImage(rec).catch(() => {});
  S.zoom = 1; S.offX = 0; S.offY = 0; S.rot = 0;
  save(); syncUI();
  clearTimeout(timer);
  render(1024);
  renderTiles();
}
const xrBridge = {
  colors: COLORS,
  getRecent: recentForXR,
  pickRecent: pickRecentForXR,
  getStencil: () => ({ mode: S.mode, thick: S.thick, thr: S.thr, color: S.color }),
  setStencil: (patch) => { Object.assign(S, clampSettings({ ...S, ...patch })); changed(); },
  phoneCode: () => (receiver ? phoneCode : null),
};
function startPhone() {
  if (!isValidCode(phoneCode)) { phoneCode = makeCode(); LS.set(LS_CODE, phoneCode); }
  receiver?.stop();
  receiver = startReceiver(phoneCode, { onImage: onPhoneImage, onStatus: setPhoneStatus });
}
async function drawQR() {
  const url = sendUrl(location.href, phoneCode);
  const short = new URL('send.html', location.href);
  $('#sendAddr').textContent = short.host + short.pathname;
  $('#codeView').textContent = phoneCode;
  const c = $('#qr'), g = c.getContext('2d');
  try {
    await loadScript(QR_URL);
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount(), cell = Math.floor(c.width / (n + 2)), off = Math.floor((c.width - cell * n) / 2);
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#1d1416';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) g.fillRect(off + x * cell, off + y * cell, cell, cell);
  } catch {
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#555'; g.font = '700 16px system-ui'; g.textAlign = 'center';
    g.fillText('QR не загрузился,', c.width / 2, c.height / 2 - 10);
    g.fillText('введи код вручную', c.width / 2, c.height / 2 + 14);
  }
}
async function openPhone() {
  if (!receiver) startPhone();
  $('#phoneDlg').showModal();
  await drawQR();
}
$('#phoneBtn').onclick = openPhone;
$('#phoneTile').onclick = openPhone;
$('#phonePill').onclick = openPhone;
$('#newCode').onclick = async () => { phoneCode = makeCode(); LS.set(LS_CODE, phoneCode); startPhone(); await drawQR(); };

// ---------- dialogs ----------
for (const d of $$('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
}
$('#helpBtn').onclick = () => $('#helpDlg').showModal();
$('#helpBtn2').onclick = () => $('#helpDlg').showModal();

// ---------- XR ----------
let xrOK = false;
(async () => {
  const pill = $('#xrPill'), xs = $('#xrStatus');
  const set = (cls, short, long) => { pill.className = 'pill ' + cls; pill.textContent = short; xs.textContent = long; };
  if (!window.isSecureContext) return set('warn', 'нужен https', 'Открой сайт по https, иначе AR не включится.');
  if (!navigator.xr?.isSessionSupported) return set('warn', 'открой в Quest', 'Здесь можно подготовить картинку. AR включится в браузере Quest 3.');
  try { xrOK = await navigator.xr.isSessionSupported('immersive-ar'); } catch { xrOK = false; }
  if (xrOK) set('ok', 'AR готов', 'Сядь перед тортом и нажми кнопку');
  else set('warn', 'открой в Quest', 'Этот браузер без AR. Открой страницу в браузере Quest 3.');
})();

$('#enterAR').onclick = async () => {
  if (!xrOK) { toast('AR работает только в браузере Quest 3'); return; }
  clearTimeout(timer);
  render(1024);
  const mod = await xrModP;
  if (!mod) { toast('Не загрузился 3D-движок, обнови страницу'); return; }
  try {
    await mod.startXR({
      ...xrBridge,
      main: result.main, photo: result.photo, shape: S.shape, diameterCm: S.diameter, opacity: S.opacity,
      onEnd: (r) => {
        S.opacity = r.opacity;
        if (r.diameterCm) S.diameter = Math.round(r.diameterCm * 10) / 10;
        changed();
        toast(r.saved ? 'Положение сохранено: при следующем входе вернётся само' : 'Ты вышла из AR');
      },
    });
  } catch (e) {
    console.error(e);
    toast('Не удалось запустить AR: ' + (e?.message || e));
  }
};

// ---------- установка как приложение ----------
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('Приложение установлено'); });
$('#installBtn').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch {}
  installEvt = null;
  $('#installBtn').hidden = true;
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

// ---------- старт ----------
syncUI();
(async () => {
  let recs = [];
  try { recs = await listImages(); } catch {}
  const old = LS.get(LS_IMG_OLD);
  if (!recs.length && old) {
    try { await useImage(await loadImage(old), { name: 'прошлая', keepPos: true }); } catch {}
    LS.del(LS_IMG_OLD);
  } else if (recs.length) {
    const url = URL.createObjectURL(recs[0].blob);
    try { img = await loadImage(url); currentId = recs[0].id; } catch {}
  }
  if (!img) img = await loadImage(makeDemo());
  render(1024);
  renderTiles();
  if (isValidCode(phoneCode)) startPhone(); // приём с телефона включается сам, если уже пользовались
})();
