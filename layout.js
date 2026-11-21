// Раскладка кнопок панели в шлеме: ряды с весами высоты, кнопки с весами ширины.
// Чистая функция без three.js (тестируется в Node).

/**
 * rows: [{ h, items: [{ id, label, flex? }] }]
 * → плоский список кнопок с координатами { ...item, x, y, w, h } в пикселях канваса.
 */
export function layout(rows, x0, y0, w, h, gap) {
  const total = rows.reduce((s, r) => s + r.h, 0);
  const unit = (h - gap * (rows.length - 1)) / total;
  const out = [];
  let y = y0;
  for (const r of rows) {
    const rh = r.h * unit;
    const tf = r.items.reduce((s, it) => s + (it.flex || 1), 0);
    const uw = (w - gap * (r.items.length - 1)) / tf;
    let x = x0;
    for (const it of r.items) {
      const bw = (it.flex || 1) * uw;
      out.push({ ...it, x, y, w: bw, h: rh });
      x += bw + gap;
    }
    y += rh + gap;
  }
  return out;
}

/** Кнопка под точкой (px, py), пропуская подписи и выключенные. */
export function hitButton(buttons, px, py) {
  return buttons.find((b) => !b.disabled && b.kind !== 'label'
    && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) || null;
}

/** Прямоугольник «cover»: вписать картинку iw×ih в рамку, обрезав лишнее. */
export function coverRect(iw, ih, x, y, w, h) {
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}
