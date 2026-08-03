/**
 * Wind-Row (Bodenwerte-Zeile 1): Fiederpfeile aus surface.ws10/wd10, wie die
 * SVG-Fiedern in windbarb.js/crosssection.js — hier aber Canvas-nativ
 * gezeichnet (windBarbMarkup() liefert nur SVG-Markup, das sich nicht direkt
 * in einen Canvas-Kontext einbetten lässt). Dieselben Größenverhältnisse wie
 * windbarb.js (SHAFT/BW/BS/SW-Fraktionen von `size`), damit Meteogramm/
 * Cross-Section/GRAMET optisch zusammenpassen.
 */

const KT_PER_MS = 1.94384;

export const WIND_ROW_HEIGHT = 34;

export function drawWindRow(ctx, grid, x, top, height, opts = {}) {
  const { surface, times } = grid;
  if (!surface) return;
  const size = opts.size ?? 22;
  const color = opts.color ?? "#0b1220";
  const minGapPx = opts.minGapPx ?? size * 1.1;
  const cy = top + height / 2;

  let lastX = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const px = x(times[i]);
    if (px - lastX < minGapPx) continue;
    const spd = surface.ws10[i], dir = surface.wd10[i];
    if (!Number.isFinite(spd) || !Number.isFinite(dir)) continue;
    drawBarb(ctx, px, cy, spd * KT_PER_MS, dir, { size, color });
    lastX = px;
  }
}

/** Herkunft/Geschwindigkeit (kt) als Fieder, Ursprung = Symbolzentrum,
 *  unrotiert zeigt der Schaft nach oben (Nordhalbkugel-Fähnchen). */
function drawBarb(ctx, cx, cy, spdKt, dirDeg, { size = 22, color = "#0b1220" } = {}) {
  const SHAFT = size * 0.409, BW = size * 0.227, BS = size * 0.102, SW = Math.max(1, size * 0.045);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = SW; ctx.lineCap = "round";

  if (spdKt < 2.5) {
    ctx.beginPath(); ctx.arc(0, 0, size * 0.091, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, size * 0.182, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.rotate(dirDeg * Math.PI / 180);
  ctx.beginPath(); ctx.arc(0, 0, size * 0.045, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -SHAFT); ctx.stroke();

  let rem = Math.round(spdKt / 5) * 5;
  const penn = Math.floor(rem / 50); rem -= penn * 50;
  const full = Math.floor(rem / 10); rem -= full * 10;
  const half = rem >= 5 ? 1 : 0;

  let y = -SHAFT;
  for (let i = 0; i < penn; i++) {
    const y0 = y, y1 = y + BS * 2;
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(0, y1); ctx.lineTo(BW, (y0 + y1) / 2); ctx.closePath(); ctx.fill();
    y += BS * 2 + 1;
  }
  for (let i = 0; i < full; i++) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(BW, y); ctx.stroke();
    y += BS;
  }
  if (half) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(BW * 0.5, y); ctx.stroke(); }
  ctx.restore();
}
