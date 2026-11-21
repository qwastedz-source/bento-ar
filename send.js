import { CODE_LEN, normalizeCode, isValidCode, connectSender, fitSize } from './transfer.js';

const $ = (s) => document.querySelector(s);
const LS_CODE = 'bk_send_code';
const MAX_SIDE = 2048;

let link = null;      // { send, close }
let connecting = null;
const pending = new Map(); // id → { el, msg }

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2800);
}
function setStatus(text, cls = '') { const s = $('#status'); s.textContent = text; s.className = 'pill ' + cls; }

// ---------- поле кода из 6 клеток ----------
const box = $('#codeIn');
const cells = [];
for (let i = 0; i < CODE_LEN; i++) {
  const inp = document.createElement('input');
  inp.inputMode = 'text';
  inp.autocapitalize = 'characters';
  inp.autocomplete = 'off';
  inp.spellcheck = false;
  inp.maxLength = 1;
  inp.setAttribute('aria-label', `Символ ${i + 1}`);
  inp.addEventListener('input', () => {
    const v = normalizeCode(inp.value);
    if (v.length > 1) { setCode(v); return; }
    inp.value = v;
    if (v && i < CODE_LEN - 1) cells[i + 1].focus();
    onCodeChange();
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && i > 0) cells[i - 1].focus(); });
  inp.addEventListener('paste', (e) => { e.preventDefault(); setCode(e.clipboardData.getData('text')); });
  box.appendChild(inp);
  cells.push(inp);
}
function getCode() { return cells.map((c) => c.value).join(''); }
function setCode(s) {
  const v = normalizeCode(s);
  cells.forEach((c, i) => { c.value = v[i] || ''; });
  cells[Math.min(v.length, CODE_LEN - 1)].focus();
  onCodeChange();
}

let lastCode = '';
function onCodeChange() {
  const code = getCode();
  if (code === lastCode) return;
  lastCode = code;
  link?.close(); link = null; connecting = null;
  if (!isValidCode(code)) { setStatus('введи код'); $('#pick').classList.add('off'); return; }
  try { localStorage.setItem(LS_CODE, code); } catch {}
  history.replaceState(null, '', '#' + code);
  connect().catch(() => {});
}

async function connect() {
  const code = getCode();
  if (connecting) return connecting;
  setStatus('ищу шлем…', 'warn');
  connecting = connectSender(code, {
    onStatus: (s) => { if (s === 'closed') { link = null; connecting = null; setStatus('связь потеряна', 'warn'); } },
    onAck: (id) => done(id, true),
    onNack: (id, err) => done(id, false, err),
  }).then((l) => {
    link = l;
    setStatus('шлем на связи ✓', 'ok');
    $('#pick').classList.remove('off');
    return l;
  }).catch((e) => {
    connecting = null;
    const why = e.message === 'no-headset' ? 'шлем не найден' : e.message === 'timeout' ? 'нет ответа' : 'нет связи';
    setStatus(why, 'warn');
    $('#pick').classList.add('off');
    setTimeout(() => { if (!link && !connecting && getCode() === code) connect().catch(() => {}); }, 5000);
    throw e;
  });
  return connecting;
}

// ---------- подготовка и отправка ----------
function loadImg(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
}
// <img> сам учитывает поворот из EXIF, поэтому рисуем через него.
async function prepare(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await loadImg(url);
    const { w, h } = fitSize(im.naturalWidth, im.naturalHeight, MAX_SIDE);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(im, 0, 0, w, h);
    const keepAlpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif';
    const mime = keepAlpha ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((r) => c.toBlob(r, mime, 0.9));
    return { blob, mime, thumb: c.toDataURL('image/jpeg', 0.6) };
  } finally { URL.revokeObjectURL(url); }
}

function addItem(name, thumb) {
  $('#sentCard').hidden = false;
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = '<img alt=""><div><b></b><span>отправляю…</span></div><button class="btn sm soft resend">Ещё раз</button>';
  el.querySelector('img').src = thumb;
  el.querySelector('b').textContent = name;
  $('#list').prepend(el);
  return el;
}
function done(id, ok, err) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.el.className = 'item ' + (ok ? 'ok' : 'err');
  p.el.querySelector('span').textContent = ok ? '✓ на шлеме' : err === 'too-big' ? 'слишком большой файл' : 'не дошло';
  if (ok) toast('Картинка на шлеме ✓');
}
async function sendMsg(msg, el) {
  el.className = 'item';
  el.querySelector('span').textContent = 'отправляю…';
  try {
    const l = link || (await connect());
    const timer = setTimeout(() => done(msg.id, false), 30000);
    pending.set(msg.id, { el, msg, timer });
    l.send(msg);
  } catch {
    el.className = 'item err';
    el.querySelector('span').textContent = 'шлем не на связи';
  }
}

$('#file').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) {
    try {
      const { blob, mime, thumb } = await prepare(f);
      const msg = { type: 'image', id: Math.random().toString(36).slice(2), name: f.name || 'фото', mime, data: await blob.arrayBuffer() };
      const el = addItem(msg.name, thumb);
      el.querySelector('.resend').onclick = () => sendMsg({ ...msg, id: Math.random().toString(36).slice(2) }, el);
      await sendMsg(msg, el);
    } catch {
      toast('Не получилось открыть это фото');
    }
  }
});

// ---------- старт ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
let start = location.hash.slice(1);
if (!isValidCode(normalizeCode(start))) { try { start = localStorage.getItem(LS_CODE) || ''; } catch { start = ''; } }
if (start) setCode(start); else cells[0].focus();
