import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { layout, hitButton, coverRect } from '../layout.js';
import { clampSettings, MODES } from '../imageproc.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// ---------- раскладка панели в шлеме ----------
test('layout: ряды заполняют ширину и высоту без наложений', () => {
  const rows = [
    { h: 1, items: [{ id: 'a' }, { id: 'b' }, { id: 'c', flex: 2 }] },
    { h: 2, items: [{ id: 'd' }] },
  ];
  const bs = layout(rows, 24, 140, 976, 736, 14);
  assert.equal(bs.length, 4);
  const [a, b, c, d] = bs;
  assert.ok(Math.abs(c.x + c.w - (24 + 976)) < 1e-9, 'ряд до правого края');
  assert.ok(Math.abs(c.w - 2 * a.w) < 1e-9, 'flex 2 = вдвое шире');
  assert.ok(a.x + a.w + 14 - b.x < 1e-9, 'зазор между кнопками');
  assert.ok(Math.abs(d.h - 2 * a.h) < 1e-9, 'вес высоты');
  assert.ok(Math.abs(d.y + d.h - (140 + 736)) < 1e-9, 'до низа');
  for (const p of bs) for (const q of bs) {
    if (p === q) continue;
    const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    assert.ok(!overlap, `${p.id} и ${q.id} не пересекаются`);
  }
});

test('hitButton: попадание, мимо, подписи и выключенные не нажимаются', () => {
  const bs = layout([{ h: 1, items: [{ id: 'ok' }, { id: 'lbl', kind: 'label' }, { id: 'off', disabled: true }] }], 0, 0, 300, 100, 0);
  assert.equal(hitButton(bs, 50, 50).id, 'ok');
  assert.equal(hitButton(bs, 150, 50), null);
  assert.equal(hitButton(bs, 250, 50), null);
  assert.equal(hitButton(bs, 50, 150), null);
});

test('coverRect: заполняет рамку без полос, по центру', () => {
  const r = coverRect(400, 200, 0, 0, 100, 100);
  assert.equal(r.h, 100); assert.equal(r.w, 200); assert.equal(r.x, -50); assert.equal(r.y, 0);
  const t = coverRect(100, 300, 10, 10, 60, 60);
  assert.equal(t.w, 60); assert.ok(t.h >= 60); assert.ok(t.y <= 10);
});

// ---------- настройки ----------
test('clampSettings: чинит битые и выходящие за рамки значения', () => {
  const s = clampSettings({ thick: 99, thr: -1, diameter: 'abc', opacity: 0.5, mode: 'weird', shape: 'heart', color: 'red', zoom: 1.2 });
  assert.equal(s.thick, 3);
  assert.equal(s.thr, 0.03);
  assert.equal(s.diameter, 6);
  assert.equal(s.opacity, 0.5);
  assert.equal(s.mode, 'lines');
  assert.equal(s.shape, 'circle');
  assert.equal(s.color, '#00ff6a');
  assert.equal(s.zoom, 1.2);
  assert.ok(MODES.includes(clampSettings({ mode: 'photo' }).mode));
  assert.equal(clampSettings({ color: '#FF2BD6' }).color, '#FF2BD6');
});

// ---------- офлайн и установка ----------
test('sw.js: все файлы из офлайн-кэша существуют', () => {
  const src = readFileSync(root + 'sw.js', 'utf8');
  const list = JSON.parse(src.match(/const CORE = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(list.length > 10);
  for (const f of list) {
    const p = f === './' ? 'index.html' : f.replace('./', '');
    assert.ok(existsSync(root + p), `нет файла ${p}`);
  }
  // каждый js-модуль приложения должен быть в кэше, иначе офлайн сломается
  for (const m of ['main.js', 'xr.js', 'imageproc.js', 'calib.js', 'layout.js', 'transfer.js', 'store.js', 'send.js']) {
    assert.ok(list.includes('./' + m), `${m} не в кэше`);
  }
});

test('manifest: иконки на месте, есть maskable', () => {
  const m = JSON.parse(readFileSync(root + 'manifest.webmanifest', 'utf8'));
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(existsSync(root + i.src), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  const png = readFileSync(root + 'icons/icon-512.png');
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 512);
});
