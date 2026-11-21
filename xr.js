// WebXR-часть: passthrough, калибровка по торту, заморозка с системным якорем.
import * as THREE from 'three';
import { faceYaw as faceYawFrom, fitRim, fitSquare, fitCenter, tooClose, medianPoint, anchorBlend } from './calib.js';
import { layout, hitButton, coverRect } from './layout.js';

const UP = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;
const NEEDLE = 0.06;          // длина виртуальной иглы на контроллере, м
const HOLD_MS = 1500;         // удержание для разморозки
const LS_ANCHOR = 'bk_anchor_v1';
const LS_PREFS = 'bk_xr_prefs_v1';
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// --- суставы рук для «рук поверх картинки» ---
const JOINTS = ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
const BONES = [['wrist', 'thumb-metacarpal'], ['thumb-metacarpal', 'thumb-phalanx-proximal'],
  ['thumb-phalanx-proximal', 'thumb-phalanx-distal'], ['thumb-phalanx-distal', 'thumb-tip']];
for (const f of ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger']) {
  const seq = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((s) => `${f}-${s}`);
  JOINTS.push(...seq);
  BONES.push(['wrist', seq[0]]);
  for (let k = 0; k < seq.length - 1; k++) BONES.push([seq[k], seq[k + 1]]);
}

let renderer, scene, camera, session = null, refSpace = null, opts = null;
let rig, content, imgMat, guideTex, guideCanvas, texMain = null, texPhoto = null;
let panel, markers;
const ctrls = [];
const hands = [];
const raycaster = new THREE.Raycaster();
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
const headQ = new THREE.Quaternion();
const aPos = new THREE.Vector3(), aQuat = new THREE.Quaternion();
let lastT = 0;

const prefs = { showRim: true, showGrid: false, occl: true, step: 1, ...(LS.get(LS_PREFS) || {}) };
const st = {
  pos: new THREE.Vector3(0, 0.9, -0.45), yaw: 0, diam: 0.1, shape: 'circle',
  locked: false, anchor: null, anchorSeen: false, wantAnchor: false, anchorStatus: '—',
  calib: null, opacity: 0.85, view: 'main', hidden: false, hasPhoto: true,
  head: new THREE.Vector3(0, 1.5, 0), headFwd: new THREE.Vector3(0, 0, -1), trackingLost: false,
  initialized: false, measured: false, grab: null, hold: null,
  msg: '', msgUntil: 0, canRestore: false, markersUntil: 0, hcheck: false, headDist: 0,
};

function savePrefs() { LS.set(LS_PREFS, prefs); }
function msg(text, ms = 2600) { st.msg = text; st.msgUntil = performance.now() + ms; if (panel) panel.dirty = true; }
function rightVec(out = new THREE.Vector3()) { return out.set(-st.headFwd.z, 0, st.headFwd.x); }
function faceYaw(p) { return faceYawFrom(p, st.head); }
function yawFromQuat(q) { return new THREE.Euler().setFromQuaternion(q, 'YXZ').y; }
function buzz(c, k = 0.4, ms = 25) {
  try { c?.userData.src?.gamepad?.hapticActuators?.[0]?.pulse?.(k, ms); } catch {}
}

// =====================================================================
// Панель управления (canvas-текстура в пространстве)
// =====================================================================
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function fitFont(g, text, maxW, size, weight) {
  let s = size;
  for (;;) {
    g.font = `${weight} ${s}px system-ui, Roboto, "Noto Sans", sans-serif`;
    if (g.measureText(text).width <= maxW || s <= 18) return;
    s -= 2;
  }
}
const DEFAULT_COLORS = ['#00ff6a', '#ff2bd6', '#00e5ff', '#ffe600', '#ff3b30', '#2f6bff', '#000000', '#ffffff'];
const B = (id, label, o = {}) => ({ id, label, flex: 1, ...o });

// Страницы меню (картинку и трафарет можно менять и в заморозке: положение не трогается)
function buildRows() {
  switch (st.page) {
    case 'menu':
      return [
        { h: 1.3, items: [B('images', 'Картинки'), B('stencil', 'Трафарет')] },
        { h: 1, items: [B('calibMenu', 'Калибровка заново', { disabled: st.locked }), B('hcheckMenu', 'Проверка высоты', { disabled: st.locked })] },
        { h: 1.3, items: [B('back', '‹ Продолжить', { kind: 'primary' }), B('exitAsk', 'Выйти из AR', { kind: 'warn' })] },
      ];
    case 'exit':
      return [
        { h: 1.1, items: [B('lbl', st.locked
          ? 'Положение сохранится и вернётся само при следующем входе'
          : 'Картинка не заморожена, положение не сохранится', { kind: 'label' })] },
        { h: 1.5, items: [B('exitYes', 'Да, выйти', { kind: 'warn' }), B('back', 'Остаться', { kind: 'primary' })] },
      ];
    case 'images': {
      const rows = [];
      if (!st.recent) rows.push({ h: 3.2, items: [B('lbl', 'Загружаю…', { kind: 'label' })] });
      else if (!st.recent.length) rows.push({ h: 3.2, items: [B('lbl', 'Пока пусто: пришли фото с телефона', { kind: 'label' })] });
      else {
        for (let i = 0; i < Math.min(8, st.recent.length); i += 4) {
          const items = st.recent.slice(i, i + 4).map((r) => B('pick:' + r.id, '', { thumb: r.img, active: r.current }));
          while (items.length < 4) items.push(B('lbl', '', { kind: 'label' }));
          rows.push({ h: 1.6, items });
        }
        if (rows.length === 1) rows.push({ h: 1.6, items: [B('lbl', '', { kind: 'label' })] });
      }
      const code = opts?.phoneCode?.();
      rows.push({ h: 0.7, items: [B('lbl', code ? `С телефона: код ${code}, фото появится сразу` : 'С телефона: включи «С телефона» на странице', { kind: 'label' })] });
      rows.push({ h: 1, items: [B('toMenu', '‹ Меню'), B('back', 'К торту', { kind: 'primary' })] });
      return rows;
    }
    case 'stencil': {
      const s = st.stencil || {};
      const lines = s.mode === 'lines' || s.mode === 'mix';
      const modes = [['lines', 'Контур'], ['mix', 'Контур+фото'], ['fill', 'Пятна'], ['photo', 'Фото']];
      return [
        { h: 1, items: modes.map(([v, l]) => B('mode:' + v, l, { active: s.mode === v })) },
        { h: 1, items: [B('thick-', 'Тоньше', { disabled: !lines }), B('lbl', lines ? `линия ${(+s.thick || 0).toFixed(1)} мм` : 'толщина: только для контура', { kind: 'label', flex: 1.3 }), B('thick+', 'Толще', { disabled: !lines })] },
        { h: 1, items: [B('thr+', 'Меньше линий', { disabled: !lines }), B('thr-', 'Больше линий', { disabled: !lines })] },
        { h: 1, items: (opts?.colors || DEFAULT_COLORS).map((c) => B('color:' + c, '', { swatch: c, active: s.color === c, disabled: s.mode === 'photo' })) },
        { h: 1, items: [B('toMenu', '‹ Меню'), B('back', 'К торту', { kind: 'primary' })] },
      ];
    }
    default:
      return buildMainRows();
  }
}

function buildMainRows() {
  const view = B('view', st.view === 'main' ? 'Показ: трафарет' : 'Показ: фото', { flex: 1.5, disabled: !st.hasPhoto });
  const hide = B('hide', st.hidden ? 'Показать' : 'Скрыть', { active: st.hidden });
  const opRow = { h: 1, items: [B('opMinus', 'Прозр −'), B('opPlus', 'Прозр +'), view, hide] };
  const togRow = { h: 1, items: [B('rim', 'Обод', { active: prefs.showRim }), B('grid', 'Сетка', { active: prefs.showGrid }), B('occl', 'Руки поверх', { active: prefs.occl, flex: 1.3 })] };
  if (st.locked) {
    return [opRow, togRow, { h: 1.7, items: [B('unlock', 'Разморозить: держи 1.5 с', { flex: 2.4, hold: true, kind: 'warn' }), B('menu', 'Меню'), B('close', 'Убрать')] }];
  }
  const sq = st.shape === 'square';
  const r1 = [
    B('calibCenter', 'Центр · 1 точка', { active: st.calib?.mode === 'center' }),
    B('calibRim', sq ? '2 ближних угла' : 'Край · 3 точки', { active: st.calib?.mode === 'rim' }),
  ];
  if (st.calib) r1.push(st.calib.fit ? B('calibDone', 'Готово ✓', { kind: 'primary' }) : B('cancelCalib', 'Отмена'));
  else {
    if (st.canRestore) r1.push(B('restore', 'Прошлое место'));
    r1.push(B('hcheck', 'Проверка высоты', { active: st.hcheck }));
  }
  const s = prefs.step;
  return [
    { h: 1, items: r1 },
    { h: 1, items: [B('left', '←'), B('fwd', '↑ дальше'), B('back', '↓ ближе'), B('right', '→'), B('step', `Шаг ${s} мм`, { flex: 1.3 })] },
    { h: 1, items: [B('rotL', `↺ ${s}°`), B('rotR', `↻ ${s}°`), B('up', 'Выше'), B('down', 'Ниже'), B('smaller', 'Ø −'), B('bigger', 'Ø +')] },
    opRow,
    togRow,
    { h: 1.5, items: [B('lock', 'ЗАМОРОЗИТЬ', { flex: 2.4, kind: 'primary' }), B('menu', 'Меню'), B('close', 'Убрать')] },
  ];
}

function statusLines(now) {
  const d = (st.diam * 100).toFixed(1);
  const op = Math.round(st.opacity * 100);
  const flash = st.msg && now < st.msgUntil ? st.msg : null;
  const PAGES = {
    menu: ['Меню', 'Картинку и трафарет можно менять: положение не собьётся'],
    images: ['Картинки', 'Нажми на картинку, и она встанет на торт'],
    stencil: ['Трафарет', 'Изменения сразу видны на торте'],
    exit: ['Выйти из AR?', 'Вернёшься на страницу с настройками'],
  };
  if (PAGES[st.page]) return [PAGES[st.page][0], flash || PAGES[st.page][1]];
  let l1, l2;
  const dist = Math.round(st.headDist * 100);
  if (st.locked) {
    l1 = 'Картинка закреплена';
    l2 = `Ø ${d} см · якорь: ${st.anchorStatus} · до торта ${dist} см`;
  } else if (st.calib?.fit) {
    l1 = `Уточнение: ${st.calib.pts.length} точек · разброс ±${(st.calib.fit.rms * 1000).toFixed(1)} мм`;
    l2 = 'Ещё точки по краю делают круг точнее. Потом «Готово»';
  } else if (st.hcheck) {
    l1 = 'Проверка высоты: медленно качай головой влево-вправо';
    l2 = 'Едет ПРОТИВ головы → «Ниже». Едет ВМЕСТЕ с головой → «Выше»';
  } else if (st.calib) {
    const need = st.calib.mode === 'center' ? 1 : st.shape === 'square' ? 2 : 3;
    l1 = `Калибровка: точка ${st.calib.pts.length + 1} из ${need}`;
    l2 = st.calib.mode === 'center'
      ? 'Кончик иглы или щипок над центром верха торта, потом курок'
      : st.shape === 'square'
        ? 'Сначала ближний ЛЕВЫЙ угол верха, потом ближний ПРАВЫЙ'
        : 'Три точки по краю верха, подальше друг от друга';
  } else {
    l1 = `Ø ${d} см · прозр ${op}% · шаг ${prefs.step} мм`;
    l2 = 'Откалибруй, подгони и нажми ЗАМОРОЗИТЬ';
  }
  if (st.headDist > 0 && st.headDist < 0.3 && !st.calib) l1 = `⚠ Слишком близко (${dist} см): вблизи камеры шлема искажают`;
  if (st.trackingLost) l1 = '⚠ Трекинг потерян: посмотри вокруг, не закрывай камеры';
  if (st.msg && now < st.msgUntil) l2 = st.msg;
  return [l1, l2];
}

class Panel {
  constructor() {
    this.W = 1024; this.H = 900;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
    const w = 0.27;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, (w * this.H) / this.W),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, toneMapped: false }),
    );
    this.mesh.renderOrder = 20;
    this.buttons = [];
    this.key = '';
    this.lastDraw = 0;
    this.dirty = true;
  }
  raycast(c) {
    if (!this.mesh.visible) return null;
    v1.setFromMatrixPosition(c.matrixWorld);
    v2.set(0, 0, -1).transformDirection(c.matrixWorld);
    raycaster.set(v1, v2);
    const hit = raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || !hit.uv) return null;
    const px = hit.uv.x * this.W, py = (1 - hit.uv.y) * this.H;
    return { distance: hit.distance, button: hitButton(this.buttons, px, py) };
  }
  update(now) {
    if (!this.mesh.visible) return;
    if (this.anim != null) {
      const k = Math.min(1, (now - this.anim) / 200), e = 1 - (1 - k) ** 3;
      this.mesh.scale.setScalar(0.86 + 0.14 * e);
      this.mesh.material.opacity = e;
      if (k >= 1) this.anim = null;
    }
    const hover = ctrls.map((c) => c.userData.hoverId).filter(Boolean).join(',');
    const holdP = st.hold ? Math.min(1, (now - st.hold.t0) / HOLD_MS) : 0;
    const lines = statusLines(now);
    const key = [st.page, st.recent?.length, JSON.stringify(st.stencil || 0), st.locked, st.calib?.mode, st.calib?.pts.length, !!st.calib?.fit, st.hcheck, st.canRestore, prefs.step, st.view, st.hidden,
      prefs.showRim, prefs.showGrid, prefs.occl, hover, holdP.toFixed(2), lines.join('|')].join(';');
    if (!this.dirty && key === this.key) return;
    if (now - this.lastDraw < 60) return;
    this.key = key; this.dirty = false; this.lastDraw = now;
    this.draw(lines, new Set(hover.split(',')), holdP);
  }
  draw([l1, l2], hover, holdP) {
    const g = this.ctx, W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    rr(g, 2, 2, W - 4, H - 4, 44);
    const bg = g.createLinearGradient(0, 0, 0, H);
    if (st.locked) { bg.addColorStop(0, 'rgba(18,30,62,0.96)'); bg.addColorStop(1, 'rgba(10,17,38,0.96)'); }
    else { bg.addColorStop(0, 'rgba(32,30,38,0.96)'); bg.addColorStop(1, 'rgba(20,19,25,0.96)'); }
    g.fillStyle = bg; g.fill();
    g.lineWidth = 4;
    g.strokeStyle = st.locked ? 'rgba(116,192,252,0.7)' : 'rgba(255,143,171,0.35)';
    g.stroke();

    // плашка режима справа сверху
    const pill = st.locked ? ['ЗАМОРОЖЕНО', '#4dabf7'] : st.calib ? ['КАЛИБРОВКА', '#ffa94d'] : ['НАСТРОЙКА', '#ff8fab'];
    g.font = '800 26px system-ui, Roboto, sans-serif';
    const pw = g.measureText(pill[0]).width + 44;
    rr(g, W - 30 - pw, 26, pw, 48, 24);
    g.fillStyle = pill[1] + '33'; g.fill();
    g.fillStyle = pill[1]; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillText(pill[0], W - 30 - pw / 2, 51);

    g.textAlign = 'left';
    g.fillStyle = st.trackingLost ? '#ffd43b' : '#ffffff';
    fitFont(g, l1, W - 90 - pw, 42, 750); g.fillText(l1, 34, 52);
    g.fillStyle = 'rgba(255,255,255,0.72)';
    fitFont(g, l2, W - 68, 31, 500); g.fillText(l2, 34, 106);

    this.buttons = layout(buildRows(), 24, 144, W - 48, H - 144 - 24, 14);
    for (const b of this.buttons) {
      if (b.kind === 'label') {
        if (!b.label) continue;
        g.textAlign = 'center';
        g.fillStyle = 'rgba(255,255,255,0.72)';
        fitFont(g, b.label, b.w - 24, 34, 600);
        g.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 2);
        continue;
      }
      let fill = '#2b2a33', top = 'rgba(255,255,255,0.07)';
      if (b.active && !b.swatch) { fill = '#0f8f6a'; top = 'rgba(255,255,255,0.14)'; }
      if (b.kind === 'primary') { fill = g.createLinearGradient(0, b.y, 0, b.y + b.h); fill.addColorStop(0, '#f06595'); fill.addColorStop(1, '#c2255c'); }
      if (b.kind === 'warn') { fill = g.createLinearGradient(0, b.y, 0, b.y + b.h); fill.addColorStop(0, '#ff922b'); fill.addColorStop(1, '#d9480f'); }
      if (b.disabled) fill = '#202027';
      rr(g, b.x, b.y, b.w, b.h, 24);
      g.fillStyle = fill; g.fill();
      g.save(); g.clip(); g.fillStyle = top; g.fillRect(b.x, b.y, b.w, 4); g.restore();
      if (hover.has(b.id)) {
        rr(g, b.x, b.y, b.w, b.h, 24);
        g.fillStyle = 'rgba(255,255,255,0.16)'; g.fill();
        g.lineWidth = 5; g.strokeStyle = '#ffffff'; g.stroke();
      }
      if (b.thumb) {
        g.save(); rr(g, b.x + 6, b.y + 6, b.w - 12, b.h - 12, 18); g.clip();
        g.fillStyle = '#fff'; g.fillRect(b.x, b.y, b.w, b.h);
        const c = coverRect(b.thumb.width, b.thumb.height, b.x + 6, b.y + 6, b.w - 12, b.h - 12);
        g.drawImage(b.thumb, c.x, c.y, c.w, c.h);
        g.restore();
        if (b.active) { rr(g, b.x + 3, b.y + 3, b.w - 6, b.h - 6, 22); g.lineWidth = 7; g.strokeStyle = '#38d9a9'; g.stroke(); }
      }
      if (b.swatch) {
        const r = Math.min(b.w, b.h) * 0.3;
        g.beginPath(); g.arc(b.x + b.w / 2, b.y + b.h / 2, r, 0, Math.PI * 2);
        g.fillStyle = b.disabled ? 'rgba(255,255,255,0.15)' : b.swatch; g.fill();
        g.lineWidth = b.active ? 7 : 2; g.strokeStyle = b.active ? '#ffffff' : 'rgba(255,255,255,0.35)'; g.stroke();
      }
      if (b.hold && st.hold && st.hold.id === b.id && holdP > 0) {
        g.save(); rr(g, b.x, b.y, b.w, b.h, 22); g.clip();
        g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillRect(b.x, b.y, b.w * holdP, b.h);
        g.restore();
      }
      if (!b.label) continue;
      g.textAlign = 'center';
      g.fillStyle = b.disabled ? 'rgba(255,255,255,0.35)' : '#ffffff';
      fitFont(g, b.label, b.w - 24, b.kind ? 48 : 38, 650);
      g.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 2);
    }
    this.tex.needsUpdate = true;
  }
}

function placePanelInFront() {
  const r = rightVec(v3);
  panel.mesh.position.copy(st.head)
    .addScaledVector(st.headFwd, 0.42)
    .addScaledVector(r, -0.2)
    .add(v1.set(0, -0.13, 0));
  showPanel();
}
function placePanelAt(p) {
  panel.mesh.position.copy(p);
  showPanel();
}
function showPanel() {
  panel.mesh.lookAt(st.head);
  panel.mesh.visible = true;
  panel.anim = performance.now();
  panel.dirty = true;
}

// =====================================================================
// Текстуры
// =====================================================================
function dataTex(imgData) {
  const N = imgData.width, src = imgData.data, row = N * 4;
  const buf = new Uint8Array(src.length);
  for (let y = 0; y < N; y++) buf.set(src.subarray((N - 1 - y) * row, (N - y) * row), y * row);
  const t = new THREE.DataTexture(buf, N, N, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.needsUpdate = true;
  return t;
}

function drawGuides() {
  const g = guideCanvas.getContext('2d'), N = guideCanvas.width, c = N / 2;
  g.clearRect(0, 0, N, N);
  g.strokeStyle = 'rgba(0,229,255,0.95)';
  g.fillStyle = 'rgba(0,229,255,0.95)';
  const sq = st.shape === 'square';
  if (prefs.showRim) {
    g.lineWidth = 7;
    g.beginPath();
    if (sq) g.rect(4, 4, N - 8, N - 8); else g.arc(c, c, c - 5, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(c - 22, c); g.lineTo(c + 22, c); g.moveTo(c, c - 22); g.lineTo(c, c + 22); g.stroke();
    // метка «верх картинки» (дальняя сторона)
    g.beginPath(); g.moveTo(c - 18, 14); g.lineTo(c + 18, 14); g.lineTo(c, 40); g.closePath(); g.fill();
  }
  if (prefs.showGrid) {
    g.lineWidth = 2.5;
    g.globalAlpha = 0.75;
    g.beginPath();
    for (const f of [0.25, 0.5, 0.75]) {
      if (sq) { const h = c * f; g.rect(c - h, c - h, 2 * h, 2 * h); }
      else { g.moveTo(c + c * f, c); g.arc(c, c, c * f, 0, Math.PI * 2); }
    }
    g.moveTo(0, c); g.lineTo(N, c); g.moveTo(c, 0); g.lineTo(c, N);
    if (!sq) {
      const k = c * Math.SQRT1_2;
      g.moveTo(c - k, c - k); g.lineTo(c + k, c + k); g.moveTo(c + k, c - k); g.lineTo(c - k, c + k);
    }
    g.stroke();
    g.globalAlpha = 1;
  }
  guideTex.needsUpdate = true;
}

// =====================================================================
// Сцена
// =====================================================================
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 1, 0.01, 50);

  rig = new THREE.Group();
  scene.add(rig);
  content = new THREE.Group();
  content.rotation.x = -Math.PI / 2; // плоскость картинки → горизонтально, верх картинки = от себя
  rig.add(content);
  const plane = new THREE.PlaneGeometry(1, 1);
  imgMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const imgMesh = new THREE.Mesh(plane, imgMat);
  imgMesh.renderOrder = 1;
  content.add(imgMesh);

  guideCanvas = document.createElement('canvas');
  guideCanvas.width = guideCanvas.height = 1024;
  guideTex = new THREE.CanvasTexture(guideCanvas);
  guideTex.colorSpace = THREE.SRGBColorSpace;
  guideTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const guideMesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: guideTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  guideMesh.position.z = 0.0003;
  guideMesh.renderOrder = 2;
  content.add(guideMesh);

  panel = new Panel();
  panel.mesh.visible = false;
  scene.add(panel.mesh);

  markers = new THREE.Group();
  scene.add(markers);

  const pink = new THREE.MeshBasicMaterial({ color: 0xff2bd6, depthTest: false, toneMapped: false });
  const occMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const sphere = new THREE.SphereGeometry(1, 12, 8);
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const rayMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });

  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    c.addEventListener('connected', (e) => { c.userData.src = e.data; });
    c.addEventListener('disconnected', () => {
      c.userData.src = null; c.userData.hoverId = null;
      if (st.grab?.c === c) st.grab = null;
      if (st.hold?.ctrl === c) st.hold = null;
    });
    c.addEventListener('selectstart', () => onSelectStart(c));
    c.addEventListener('selectend', () => onSelectEnd(c));
    c.addEventListener('squeezestart', () => onSqueezeStart(c));
    c.addEventListener('squeezeend', () => { if (st.grab?.c === c) st.grab = null; });

    const ray = new THREE.Line(rayGeo, rayMat);
    ray.visible = false;
    c.add(ray);
    c.userData.ray = ray;

    const needle = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0007, 0.0007, NEEDLE, 6), pink);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = -NEEDLE / 2;
    const tip = new THREE.Mesh(sphere, pink);
    tip.scale.setScalar(0.0022);
    tip.position.z = -NEEDLE;
    needle.add(shaft, tip);
    needle.renderOrder = 30; shaft.renderOrder = 30; tip.renderOrder = 30;
    needle.visible = false;
    c.add(needle);
    c.userData.needle = needle;
    scene.add(c);
    ctrls.push(c);

    const hand = renderer.xr.getHand(i);
    scene.add(hand);
    const occ = new THREE.InstancedMesh(sphere, occMat, 64);
    occ.frustumCulled = false;
    occ.renderOrder = -1;
    occ.count = 0;
    scene.add(occ);
    const dot = new THREE.Mesh(sphere, pink);
    dot.scale.setScalar(0.0025);
    dot.renderOrder = 30;
    dot.visible = false;
    scene.add(dot);
    hands.push({ hand, occ, dot, palmT: 0 });
  }
  scene.userData.markerGeo = sphere;
  scene.userData.markerMat = pink;
}

// =====================================================================
// Ввод
// =====================================================================
function jointPos(hand, name, out) {
  const j = hand.joints?.[name];
  if (!j || !j.visible) return null;
  return j.getWorldPosition(out);
}

function tipPos(c) {
  const src = c.userData.src;
  if (!src) return null;
  if (src.hand) {
    const h = hands[ctrls.indexOf(c)].hand;
    const a = jointPos(h, 'thumb-tip', new THREE.Vector3());
    const b = jointPos(h, 'index-finger-tip', new THREE.Vector3());
    return a && b ? a.add(b).multiplyScalar(0.5) : null;
  }
  return new THREE.Vector3(0, 0, -NEEDLE).applyMatrix4(c.matrixWorld);
}

// Каждый кадр запоминаем кончик иглы/щипка за последние 0.6 с.
function recordTip(c, now) {
  const buf = (c.userData.samples ||= []);
  if (!st.calib || !c.userData.src) { buf.length = 0; return; }
  const p = tipPos(c);
  if (p) buf.push({ t: now, x: p.x, y: p.y, z: p.z });
  while (buf.length && now - buf[0].t > 600) buf.shift();
}
// Точка калибровки = медиана положений чуть ДО нажатия: нажатие курка дёргает контроллер.
function stableTip(c) {
  const now = performance.now();
  const hand = !!c.userData.src?.hand;
  const [a, b] = hand ? [120, -1] : [350, 60];
  const s = (c.userData.samples || []).filter((q) => now - q.t <= a && now - q.t >= b);
  if (s.length >= 3) { const m = medianPoint(s); return new THREE.Vector3(m.x, m.y, m.z); }
  return tipPos(c);
}

function onSelectStart(c) {
  if (!c.userData.src) return;
  const hit = panel.raycast(c);
  if (hit) {
    if (!hit.button) return;
    buzz(c);
    if (hit.button.hold) st.hold = { id: hit.button.id, t0: performance.now(), ctrl: c };
    else action(hit.button.id);
    return;
  }
  if (st.calib && !st.locked) {
    const p = stableTip(c);
    if (p) { buzz(c, 0.6, 40); addCalibPoint(p); }
    else msg('Не вижу кончик пальцев или иглы, попробуй ещё');
  }
}
function onSelectEnd(c) {
  if (st.hold && st.hold.ctrl === c) {
    if (performance.now() - st.hold.t0 < HOLD_MS) msg('Держи дольше, 1.5 секунды');
    st.hold = null;
  }
}
function controllerYaw(c) {
  v1.set(0, 0, -1).transformDirection(c.matrixWorld);
  return Math.atan2(-v1.x, -v1.z);
}
function onSqueezeStart(c) {
  const src = c.userData.src;
  if (st.locked || !src || src.hand) return;
  st.calib = null;
  st.grab = {
    c, p0: new THREE.Vector3().setFromMatrixPosition(c.matrixWorld), cy0: controllerYaw(c),
    pos0: st.pos.clone(), yaw0: st.yaw,
  };
  buzz(c, 0.3, 20);
}

function updateController(c, dt, now) {
  const { ray, needle } = c.userData;
  const src = c.userData.src;
  ray.visible = false; needle.visible = false;
  c.userData.hoverId = null;
  if (!src) return;
  const isHand = !!src.hand;
  if (panel.mesh.visible) {
    const hit = panel.raycast(c);
    ray.visible = true;
    ray.scale.z = hit ? hit.distance : 0.35;
    c.userData.hoverId = hit?.button?.id || null;
  }
  needle.visible = !!st.calib && !isHand;
  if (isHand || !src.gamepad) return;

  const gp = src.gamepad, ax = gp.axes;
  const dz = (v) => (Math.abs(v) < 0.15 ? 0 : Math.sign(v) * ((Math.abs(v) - 0.15) / 0.85) ** 2);
  const sx = dz(ax[2] || 0), sy = dz(ax[3] || 0);
  const isRight = src.handedness === 'right';
  if (!st.locked && !st.grab && (sx || sy)) {
    if (isRight) {
      const v = 0.03 * dt; // до 3 см/с
      st.pos.addScaledVector(st.headFwd, -sy * v).addScaledVector(rightVec(v3), sx * v);
    } else {
      st.yaw -= sx * 25 * DEG * dt;
      st.pos.y -= sy * 0.015 * dt;
    }
    panel.dirty = true;
  }
  const b4 = !!gp.buttons[4]?.pressed, b5 = !!gp.buttons[5]?.pressed;
  const prev = c.userData.prevBtn || { b4: false, b5: false };
  if (isRight) {
    if (b4 && !prev.b4) action('view');
    if (b5 && !prev.b5) action('hide');
  } else {
    if (b4 && !prev.b4) { if (panel.mesh.visible) panel.mesh.visible = false; else placePanelInFront(); }
    if (b5 && !prev.b5) {
      if (!st.locked) { action('lock'); buzz(c, 0.6, 60); }
      else st.hold = { id: 'unlock', t0: now, ctrl: c, viaButton: true };
    }
    if (!b5 && prev.b5 && st.hold?.viaButton) st.hold = null;
  }
  c.userData.prevBtn = { b4, b5 };
}

function updateGrab() {
  const g = st.grab;
  if (!g || st.locked) return;
  const cp = v1.setFromMatrixPosition(g.c.matrixWorld);
  const dy = controllerYaw(g.c) - g.cy0;
  const rel = v2.copy(g.pos0).sub(g.p0).applyAxisAngle(UP, dy);
  st.pos.set(cp.x + rel.x, g.pos0.y, cp.z + rel.z); // высота не трогается
  st.yaw = g.yaw0 + dy;
  panel.dirty = true;
}

function updateHold(now) {
  if (!st.hold) return;
  if (now - st.hold.t0 >= HOLD_MS) {
    const { id, ctrl } = st.hold;
    st.hold = null;
    buzz(ctrl, 0.8, 80);
    action(id, true);
  }
}

function updateHands(dt) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const P = {};
  for (let i = 0; i < 2; i++) {
    const { hand, occ, dot } = hands[i];
    const src = ctrls[i].userData.src;
    occ.count = 0; dot.visible = false;
    if (!src?.hand || !hand.joints) { hands[i].palmT = 0; continue; }
    let k = 0;
    for (const name of JOINTS) {
      const j = hand.joints[name];
      if (j && j.visible) { P[name] = j.getWorldPosition(P[name] || new THREE.Vector3()); P[name].r = j.jointRadius || 0.008; }
      else delete P[name];
    }
    if (prefs.occl) {
      const put = (p, r) => { if (k < 64) { m.compose(p, q, s.setScalar(Math.max(r, 0.007) * 1.4)); occ.setMatrixAt(k++, m); } };
      for (const name of JOINTS) if (P[name]) put(P[name], P[name].r);
      for (const [a, b] of BONES) {
        if (P[a] && P[b]) put(v1.copy(P[a]).add(P[b]).multiplyScalar(0.5), (P[a].r + P[b].r) / 2);
      }
      occ.count = k;
      occ.instanceMatrix.needsUpdate = true;
    }
    if (st.calib && P['thumb-tip'] && P['index-finger-tip']) {
      dot.position.copy(P['thumb-tip']).add(P['index-finger-tip']).multiplyScalar(0.5);
      dot.visible = true;
    }
    // ладонь вверх ~0.7 с → вызвать панель
    if (!panel.mesh.visible && P.wrist && P['index-finger-metacarpal'] && P['pinky-finger-metacarpal']) {
      const a = v1.copy(P['index-finger-metacarpal']).sub(P.wrist);
      const b = v2.copy(P['pinky-finger-metacarpal']).sub(P.wrist);
      const n = src.handedness === 'left' ? v3.crossVectors(b, a) : v3.crossVectors(a, b);
      n.normalize();
      const open = P['thumb-tip'] && P['index-finger-tip'] && P['thumb-tip'].distanceTo(P['index-finger-tip']) > 0.04;
      if (n.y > 0.75 && open) hands[i].palmT += dt; else hands[i].palmT = 0;
      if (hands[i].palmT > 0.7) {
        hands[i].palmT = 0;
        placePanelAt(v1.copy(P['middle-finger-metacarpal'] || P.wrist).add(v2.set(0, 0.17, 0)));
      }
    } else hands[i].palmT = 0;
  }
}

// =====================================================================
// Калибровка
// =====================================================================
function addMarker(p) {
  const mk = new THREE.Mesh(scene.userData.markerGeo, scene.userData.markerMat);
  mk.scale.setScalar(0.003);
  mk.position.copy(p);
  mk.renderOrder = 30;
  markers.add(mk);
}
function clearMarkers() { while (markers.children.length) markers.remove(markers.children[0]); }

function addCalibPoint(p) {
  const cal = st.calib;
  if (tooClose(cal.pts, p)) { msg('Слишком близко к прошлой точке, отойди дальше по краю'); return; }
  cal.pts.push(p.clone());
  addMarker(p);
  const need = cal.mode === 'center' ? 1 : st.shape === 'square' ? 2 : 3;
  if (cal.pts.length < need) { msg(`Точка ${cal.pts.length} принята`); panel.dirty = true; return; }

  const pts = cal.pts;
  const rim = cal.mode === 'rim' && st.shape !== 'square';
  const r = cal.mode === 'center' ? fitCenter(pts[0], st.head, st.diam)
    : st.shape === 'square' ? fitSquare(pts[0], pts[1], st.head)
      : fitRim(pts, st.head);
  if (r.error) {
    msg(r.error, 3500);
    if (r.miss) { pts.pop(); markers.remove(markers.children[markers.children.length - 1]); }
    else resetCalib();
    panel.dirty = true;
    return;
  }
  // высоту при уточнении не меняем, если её уже подогнали вручную
  const keepY = rim && cal.fit && cal.yTouched;
  st.pos.set(r.x, keepY ? st.pos.y : r.y, r.z);
  st.yaw = r.yaw;
  if (cal.mode !== 'center') { st.diam = r.diam; st.measured = true; }
  if (rim && pts.length < 8) {
    // круг уже стоит; можно добавить ещё точки по краю для точности
    cal.fit = r;
    msg(`Ø ${(st.diam * 100).toFixed(1)} см. Ещё точки по краю = точнее, потом «Готово»`, 5000);
    panel.dirty = true;
    return;
  }
  finishCalib();
}
function finishCalib() {
  st.calib = null;
  st.markersUntil = performance.now() + 3000;
  msg(`Готово: Ø ${(st.diam * 100).toFixed(1)} см. Проверь высоту и жми ЗАМОРОЗИТЬ`, 5000);
  panel.dirty = true;
}
function resetCalib() { if (st.calib) st.calib.pts = []; clearMarkers(); panel.dirty = true; }

// =====================================================================
// Заморозка и якоря
// =====================================================================
function readSaved() { return LS.get(LS_ANCHOR); }
async function deleteSavedAnchor() {
  const s = readSaved();
  LS.del(LS_ANCHOR);
  if (s?.uuid && session?.deletePersistentAnchor) { try { await session.deletePersistentAnchor(s.uuid); } catch {} }
}
function releaseAnchor() {
  if (st.anchor) { try { st.anchor.delete(); } catch {} }
  st.anchor = null;
  st.anchorSeen = false;
}

function createAnchorNow(frame) {
  const p = rig.position, q = rig.quaternion;
  const tr = new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w });
  frame.createAnchor(tr, refSpace).then(async (a) => {
    if (!st.locked || st.anchor) { try { a.delete(); } catch {} return; }
    st.anchor = a;
    st.anchorSeen = true; // создан точно на текущем месте
    st.anchorStatus = 'держит ✓';
    panel.dirty = true;
    if (a.requestPersistentHandle) {
      try {
        await deleteSavedAnchor();
        const uuid = await a.requestPersistentHandle();
        LS.set(LS_ANCHOR, { uuid, diam: st.diam, shape: st.shape, t: Date.now() });
        st.anchorStatus = 'держит ✓ сохранён';
        panel.dirty = true;
      } catch {}
    }
  }).catch(() => { st.anchorStatus = 'нет, стоит неподвижно'; panel.dirty = true; });
}

async function restorePersistent() {
  const s = readSaved();
  if (!s || !session?.restorePersistentAnchor) return;
  st.canRestore = false;
  msg('Ищу прошлое место…', 8000);
  try {
    const a = await session.restorePersistentAnchor(s.uuid);
    releaseAnchor();
    st.anchor = a;
    st.anchorSeen = false;
    st.locked = true;
    st.calib = null; st.grab = null;
    if (s.diam) st.diam = s.diam;
    st.anchorStatus = 'восстановлен';
    msg('Прошлое место восстановлено, заморожено', 4000);
  } catch {
    LS.del(LS_ANCHOR);
    msg('Прошлое место не нашлось, откалибруй заново', 4000);
  }
  panel.dirty = true;
}

// =====================================================================
// Действия кнопок
// =====================================================================
function setStencil(patch) {
  st.stencil = { ...(st.stencil || {}), ...patch };
  try { opts?.setStencil?.(patch); } catch {}
  panel.dirty = true;
}

function action(id, fromHold = false) {
  const s = prefs.step / 1000;
  const free = !st.locked;
  const colon = id.indexOf(':');
  if (colon > 0) {
    const k = id.slice(0, colon), v = id.slice(colon + 1);
    if (k === 'pick') {
      msg('Ставлю картинку…', 5000);
      Promise.resolve(opts?.pickRecent?.(v))
        .then(() => { st.page = 'main'; msg('Картинка заменена'); })
        .catch(() => msg('Не получилось открыть картинку'));
    } else if (k === 'mode') setStencil({ mode: v });
    else if (k === 'color') setStencil({ color: v });
    panel.dirty = true;
    return;
  }
  const sc = st.stencil || {};
  switch (id) {
    case 'menu': st.page = 'menu'; st.calib = null; st.hcheck = false; break;
    case 'back': st.page = 'main'; break;
    case 'toMenu': st.page = 'menu'; break;
    case 'images':
      st.page = 'images';
      st.recent = null;
      Promise.resolve(opts?.getRecent?.()).then((r) => { st.recent = r || []; panel.dirty = true; })
        .catch(() => { st.recent = []; panel.dirty = true; });
      break;
    case 'stencil': st.page = 'stencil'; st.stencil = opts?.getStencil?.() || {}; break;
    case 'calibMenu': if (free) { st.page = 'main'; st.calib = { mode: 'rim', pts: [] }; clearMarkers(); } break;
    case 'hcheckMenu': if (free) { st.page = 'main'; st.hcheck = true; } break;
    case 'exitAsk': st.page = 'exit'; break;
    case 'exitYes': try { session?.end(); } catch {} break;
    case 'thick-': setStencil({ thick: Math.max(0.3, Math.round(((+sc.thick || 0.8) - 0.2) * 10) / 10) }); break;
    case 'thick+': setStencil({ thick: Math.min(3, Math.round(((+sc.thick || 0.8) + 0.2) * 10) / 10) }); break;
    case 'thr+': setStencil({ thr: Math.min(0.5, Math.round(((+sc.thr || 0.12) + 0.03) * 100) / 100) }); break;
    case 'thr-': setStencil({ thr: Math.max(0.03, Math.round(((+sc.thr || 0.12) - 0.03) * 100) / 100) }); break;
    case 'calibCenter': if (free) { st.calib = { mode: 'center', pts: [] }; clearMarkers(); } break;
    case 'calibRim': if (free) { st.calib = { mode: 'rim', pts: [] }; clearMarkers(); } break;
    case 'cancelCalib': st.calib = null; clearMarkers(); break;
    case 'calibDone': if (st.calib) finishCalib(); break;
    case 'hcheck':
      st.hcheck = !st.hcheck;
      if (st.hcheck && !prefs.showRim) { prefs.showRim = true; drawGuides(); }
      break;
    case 'restore': restorePersistent(); break;
    case 'fwd': if (free) st.pos.addScaledVector(st.headFwd, s); break;
    case 'back': if (free) st.pos.addScaledVector(st.headFwd, -s); break;
    case 'right': if (free) st.pos.addScaledVector(rightVec(v3), s); break;
    case 'left': if (free) st.pos.addScaledVector(rightVec(v3), -s); break;
    case 'up': if (free) { st.pos.y += s; if (st.calib) st.calib.yTouched = true; } break;
    case 'down': if (free) { st.pos.y -= s; if (st.calib) st.calib.yTouched = true; } break;
    case 'rotL': if (free) st.yaw += prefs.step * DEG; break;
    case 'rotR': if (free) st.yaw -= prefs.step * DEG; break;
    case 'smaller': if (free) st.diam = Math.max(0.03, st.diam - s); break;
    case 'bigger': if (free) st.diam = Math.min(0.3, st.diam + s); break;
    case 'step': {
      const steps = [0.5, 1, 5];
      prefs.step = steps[(steps.indexOf(prefs.step) + 1) % steps.length];
      savePrefs();
      break;
    }
    case 'opMinus': st.opacity = Math.max(0.1, Math.round((st.opacity - 0.1) * 10) / 10); break;
    case 'opPlus': st.opacity = Math.min(1, Math.round((st.opacity + 0.1) * 10) / 10); break;
    case 'view': if (st.hasPhoto) st.view = st.view === 'main' ? 'photo' : 'main'; break;
    case 'hide': st.hidden = !st.hidden; break;
    case 'rim': prefs.showRim = !prefs.showRim; savePrefs(); drawGuides(); break;
    case 'grid': prefs.showGrid = !prefs.showGrid; savePrefs(); drawGuides(); break;
    case 'occl': prefs.occl = !prefs.occl; savePrefs(); break;
    case 'close': panel.mesh.visible = false; msg(''); break;
    case 'lock':
      if (st.locked) break;
      st.locked = true; st.calib = null; st.grab = null; st.hold = null; st.hcheck = false;
      clearMarkers();
      rig.position.copy(st.pos);
      rig.quaternion.setFromAxisAngle(UP, st.yaw);
      st.anchorStatus = 'создаю…';
      st.wantAnchor = true;
      msg('Заморожено. Разморозка: держать кнопку 1.5 с или Y', 4000);
      break;
    case 'unlock':
      if (!fromHold || !st.locked) break;
      releaseAnchor();
      deleteSavedAnchor();
      st.locked = false;
      st.pos.copy(rig.position);
      st.yaw = yawFromQuat(rig.quaternion);
      st.anchorStatus = '—';
      msg('Разморожено, можно двигать');
      break;
  }
  panel.dirty = true;
}

// =====================================================================
// Кадр
// =====================================================================
function onFrame(t, frame) {
  if (!frame) return;
  const now = performance.now();
  const dt = Math.min(0.05, (now - (lastT || now)) / 1000);
  lastT = now;

  const pose = frame.getViewerPose(refSpace);
  if (pose) {
    const p = pose.transform.position, o = pose.transform.orientation;
    st.head.set(p.x, p.y, p.z);
    headQ.set(o.x, o.y, o.z, o.w);
    st.headFwd.set(0, 0, -1).applyQuaternion(headQ).setY(0);
    if (st.headFwd.lengthSq() < 1e-4) st.headFwd.set(0, 0, -1);
    st.headFwd.normalize();
    st.trackingLost = !!pose.emulatedPosition;
    if (!st.initialized) {
      st.initialized = true;
      if (!st.locked) {
        st.pos.copy(st.head).addScaledVector(st.headFwd, 0.45);
        st.pos.y = Math.max(0.4, st.head.y - 0.45);
        st.yaw = faceYaw(st.pos);
      }
      placePanelInFront();
    }
  }
  scene.updateMatrixWorld();

  // якорь
  if (st.wantAnchor) {
    st.wantAnchor = false;
    if (frame.createAnchor) createAnchorNow(frame);
    else { st.anchorStatus = 'нет, стоит неподвижно'; panel.dirty = true; }
  }
  if (st.locked && st.anchor) {
    if (!frame.trackedAnchors || frame.trackedAnchors.has(st.anchor)) {
      const ap = frame.getPose(st.anchor.anchorSpace, refSpace);
      if (ap) {
        const p = ap.transform.position, o = ap.transform.orientation;
        aPos.set(p.x, p.y, p.z);
        aQuat.set(o.x, o.y, o.z, o.w);
        // микродрожь якоря (<0.7 мм) игнорируем, мелкие поправки плавно, большие сразу
        const k = st.anchorSeen ? anchorBlend(rig.position.distanceTo(aPos), rig.quaternion.angleTo(aQuat), dt) : 1;
        if (k > 0) { rig.position.lerp(aPos, k); rig.quaternion.slerp(aQuat, k); }
        if (!st.anchorSeen) { st.anchorSeen = true; st.anchorStatus = 'держит ✓'; panel.dirty = true; }
      }
    } else if (st.anchorStatus !== 'ищет…') { st.anchorStatus = 'ищет…'; panel.dirty = true; }
  } else if (!st.locked) {
    updateGrab();
    rig.position.copy(st.pos);
    rig.quaternion.setFromAxisAngle(UP, st.yaw);
  }
  content.scale.set(st.diam, st.diam, 1);
  rig.visible = !st.hidden && !(st.locked && st.anchor && !st.anchorSeen);
  const map = st.view === 'photo' ? texPhoto : texMain;
  if (imgMat.map !== map) { imgMat.map = map; imgMat.needsUpdate = true; }
  imgMat.opacity = st.opacity;

  st.headDist = st.head.distanceTo(rig.position);
  for (const c of ctrls) { recordTip(c, now); updateController(c, dt, now); }
  updateHold(now);
  updateHands(dt);
  markers.visible = !!st.calib || now < st.markersUntil;
  if (!markers.visible && markers.children.length && !st.calib) clearMarkers();
  panel.update(now);

  renderer.render(scene, camera);
}

function onReset(e) {
  // пользователь пересобрал центр (долгое нажатие Meta): компенсируем, чтобы картинка не прыгнула
  if (!e.transform) return;
  const T = new THREE.Matrix4().fromArray(e.transform.matrix).invert();
  const apply = (o) => {
    const m = new THREE.Matrix4().compose(o.position, o.quaternion, new THREE.Vector3(1, 1, 1)).premultiply(T);
    m.decompose(o.position, o.quaternion, new THREE.Vector3());
  };
  if (!(st.locked && st.anchor)) {
    if (!st.locked) { rig.position.copy(st.pos); rig.quaternion.setFromAxisAngle(UP, st.yaw); }
    apply(rig);
    if (!st.locked) { st.pos.copy(rig.position); st.yaw = yawFromQuat(rig.quaternion); }
  }
  apply(panel.mesh);
}

// =====================================================================
// Старт / стоп
// =====================================================================
export async function startXR(o) {
  if (session) return;
  opts = o;
  if (!renderer) init();

  if (texPhoto && texPhoto !== texMain) texPhoto.dispose();
  if (texMain) texMain.dispose();
  texMain = dataTex(o.main);
  texPhoto = o.photo === o.main ? texMain : dataTex(o.photo);
  st.hasPhoto = texPhoto !== texMain;
  Object.assign(st, {
    shape: o.shape, diam: o.diameterCm / 100, opacity: o.opacity, view: 'main', hidden: false,
    locked: false, anchor: null, anchorSeen: false, wantAnchor: false, anchorStatus: '—', calib: null,
    initialized: false, measured: false, grab: null, hold: null, msg: '', msgUntil: 0, hcheck: false,
    page: 'main', recent: null, stencil: null,
  });
  imgMat.map = texMain; imgMat.needsUpdate = true;
  drawGuides();
  clearMarkers();

  const s = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'anchors'],
  });
  session = s;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFramebufferScaleFactor(1.2);
  await renderer.xr.setSession(s);
  try { renderer.xr.setFoveation(0); } catch {}
  refSpace = renderer.xr.getReferenceSpace();
  refSpace.addEventListener('reset', onReset);
  s.addEventListener('end', onEnd);

  const saved = readSaved();
  st.canRestore = !!(saved && s.restorePersistentAnchor);
  lastT = 0;
  renderer.setAnimationLoop(onFrame);
  // торт обычно не двигали: сразу пробуем вернуть прошлое замороженное положение
  if (st.canRestore && Date.now() - (saved.t || 0) < 6 * 3600e3) restorePersistent();
}

/** Для разработки: нарисовать панель шлема на обычной странице (без AR). */
export function previewPanel(page = 'main', state = {}, bridge = {}) {
  if (session) return null;
  opts = { ...(opts || {}), ...bridge };
  Object.assign(st, { page, ...state });
  const p = new Panel();
  panel = panel || p;
  p.draw(statusLines(performance.now()), new Set(state.hover ? [state.hover] : []), 0);
  return p.canvas;
}

export function isActive() { return !!session; }
/** Измеренный в этой сессии диаметр, см (или null). */
export function measuredDiameterCm() { return session && st.measured ? st.diam * 100 : null; }
export function notify(text) { if (session) msg(text, 4000); }

/** Заменить картинку прямо в AR (пришла с телефона) — положение и заморозка не меняются. */
export function updateImages(main, photo) {
  if (!session) return;
  const oldMain = texMain, oldPhoto = texPhoto;
  texMain = dataTex(main);
  texPhoto = photo === main ? texMain : dataTex(photo);
  st.hasPhoto = texPhoto !== texMain;
  if (!st.hasPhoto) st.view = 'main';
  imgMat.map = st.view === 'photo' ? texPhoto : texMain;
  imgMat.needsUpdate = true;
  if (oldPhoto && oldPhoto !== oldMain) oldPhoto.dispose();
  if (oldMain) oldMain.dispose();
  panel.dirty = true;
}

function onEnd() {
  renderer.setAnimationLoop(null);
  try { refSpace?.removeEventListener('reset', onReset); } catch {}
  const saved = st.locked && !!readSaved();
  st.anchor = null; // якоря сессии умирают вместе с ней, сохранённый остаётся
  st.locked = false;
  st.page = 'main';
  session = null;
  refSpace = null;
  opts?.onEnd?.({ opacity: st.opacity, diameterCm: st.measured ? st.diam * 100 : null, saved });
}
