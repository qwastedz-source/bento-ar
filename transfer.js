// Пересылка картинок телефон → шлем напрямую по WebRTC (PeerJS).
// Сигналинг через бесплатный сервер PeerJS, сами фото идут P2P.

export const PREFIX = 'bentoar-v1-';
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O и 1/I
export const CODE_LEN = 6;
export const MAX_BYTES = 15 * 1024 * 1024;
export const MIME_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const PEER_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
export const QR_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

export function makeCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}
export function normalizeCode(s) {
  return String(s || '').toUpperCase().split('').filter((ch) => ALPHABET.includes(ch)).join('').slice(0, CODE_LEN);
}
export function isValidCode(s) {
  return typeof s === 'string' && s.length === CODE_LEN && [...s].every((ch) => ALPHABET.includes(ch));
}
export const peerIdFor = (code) => PREFIX + code;

export function sendUrl(base, code) {
  const u = new URL('send.html', base);
  u.hash = code;
  return u.href;
}

function byteLen(d) {
  if (d instanceof ArrayBuffer) return d.byteLength;
  if (ArrayBuffer.isView(d)) return d.byteLength;
  return 0;
}
/** null, если сообщение — нормальная картинка, иначе код ошибки. */
export function validateImageMsg(m) {
  if (!m || typeof m !== 'object' || m.type !== 'image') return 'bad-type';
  if (!MIME_OK.includes(m.mime)) return 'bad-mime';
  const n = byteLen(m.data);
  if (!n) return 'empty';
  if (n > MAX_BYTES) return 'too-big';
  return null;
}

export function fitSize(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ---------- только браузер ----------
const scripts = new Map();
export function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = res;
      s.onerror = () => { scripts.delete(src); rej(new Error('script')); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
}
async function loadPeer() {
  if (!window.Peer) await loadScript(PEER_URL);
  return window.Peer || window.peerjs?.Peer;
}

/**
 * Шлем: ждёт картинки по коду. onStatus(state): 'starting' | 'ready' | 'phone' | 'receiving' |
 * 'reconnecting' | 'busy' | 'taken' | 'offline' | 'nolib' | 'error'.
 */
export function startReceiver(code, { onImage, onStatus = () => {} }) {
  let stopped = false, tries = 0, current = null;
  const open = async () => {
    if (stopped) return;
    onStatus('starting');
    let Peer;
    try { Peer = await loadPeer(); } catch { onStatus('nolib'); setTimeout(open, 8000); return; }
    const p = new Peer(peerIdFor(code), { debug: 1 });
    current = p;
    p.on('open', () => { tries = 0; onStatus('ready'); });
    p.on('connection', (conn) => {
      conn.on('open', () => onStatus('phone'));
      conn.on('data', async (m) => {
        const err = validateImageMsg(m);
        if (err) { try { conn.send({ type: 'nack', id: m?.id, err }); } catch {} return; }
        onStatus('receiving');
        try {
          await onImage(new Blob([m.data], { type: m.mime }), String(m.name || 'фото').slice(0, 80));
          conn.send({ type: 'ack', id: m.id });
        } catch { try { conn.send({ type: 'nack', id: m.id, err: 'decode' }); } catch {} }
        onStatus('phone');
      });
      conn.on('close', () => { if (!stopped) onStatus('ready'); });
    });
    p.on('disconnected', () => {
      if (stopped || p.destroyed || current !== p) return;
      onStatus('reconnecting');
      setTimeout(() => { if (!p.destroyed && current === p) { try { p.reconnect(); } catch {} } }, 1500);
    });
    p.on('error', (e) => {
      if (stopped || current !== p) return;
      const t = e?.type || 'error';
      if (t === 'unavailable-id') {
        try { p.destroy(); } catch {}
        if (tries++ < 6) { onStatus('busy'); setTimeout(open, 3000); } else onStatus('taken');
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(t)) {
        onStatus('offline');
        try { p.destroy(); } catch {}
        setTimeout(open, 5000);
        return;
      }
      onStatus('error');
    });
  };
  open();
  return { stop() { stopped = true; try { current?.destroy(); } catch {} } };
}

/** Телефон: подключиться к шлему. Возвращает { send(msg), close() }. */
export async function connectSender(code, { onStatus = () => {}, onAck = () => {}, onNack = () => {} } = {}) {
  const Peer = await loadPeer();
  const peer = new Peer({ debug: 1 });
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (why) => { if (done) return; done = true; try { peer.destroy(); } catch {} reject(new Error(why)); };
    const timer = setTimeout(() => fail('timeout'), 15000);
    peer.on('open', () => {
      const conn = peer.connect(peerIdFor(code), { reliable: true });
      conn.on('open', () => {
        clearTimeout(timer);
        done = true;
        onStatus('connected');
        resolve({ send: (m) => conn.send(m), close: () => { try { peer.destroy(); } catch {} }, conn });
      });
      conn.on('data', (m) => {
        if (m?.type === 'ack') onAck(m.id);
        else if (m?.type === 'nack') onNack(m.id, m.err);
      });
      conn.on('close', () => onStatus('closed'));
    });
    peer.on('error', (e) => {
      if (!done) fail(e?.type === 'peer-unavailable' ? 'no-headset' : e?.type || 'error');
      else onStatus('closed');
    });
  });
}
