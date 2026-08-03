/**
 * Generische Bodenwerte-Zeile für Zahlenwerte (Temperatur/Taupunkt, Böen, ...)
 * — ein Row-Typ für beliebige Serien, damit neue Zeilen ohne neuen
 * Zeichencode ergänzt werden können (s. Plan, "generisches Row-System").
 */

export const NUMBER_ROW_HEIGHT = 34;

/**
 * @param series [{ values: Float32Array, fmt: (v)=>string, color }]
 * gestapelt untereinander in der Zeile (z. B. T über Taupunkt).
 */
export function drawNumberRow(ctx, times, x, top, height, series, opts = {}) {
  const minGapPx = opts.minGapPx ?? 34;
  const lineH = height / (series.length + 1);
  ctx.font = opts.font ?? "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let lastX = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const px = x(times[i]);
    if (px - lastX < minGapPx) continue;
    let any = false;
    series.forEach((s, row) => {
      const v = s.values[i];
      if (!Number.isFinite(v)) return;
      any = true;
      ctx.fillStyle = s.color ?? "#0b1220";
      ctx.fillText(s.fmt(v), px, top + lineH * (row + 1));
    });
    if (any) lastX = px;
  }
}
