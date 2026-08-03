/**
 * Wolken-Schraffur: pro Zelle mit cloudFrac über Schwellwert kurze weiße
 * Striche (Zufalls-Offset/-Länge/-Krümmung, n skaliert mit Fraktion) plus
 * Grundton bei hoher Fraktion. Seeded PRNG (mulberry32) aus Ort + Zeitreihen-
 * start, für reproduzierbares Muster zwischen Re-Renders derselben Daten.
 *
 * Vereinfachung gegenüber dem ursprünglichen Plan: kein Offscreen-Canvas mit
 * Blit-Ausschnitt. `render.js` baut ohnehin bei jeder State-Änderung (Höhen-
 * umschalter, Layer-Toggle) den ganzen Canvas neu auf (gleiches Muster wie
 * `crosssection.js`, das komplett neu zeichnet) — ein zweites Cache-Level nur
 * für die Wolkentextur hätte hier keinen sichtbaren Effekt. nt*nk liegt selbst
 * bei ICON-EU/langem Horizont im niedrigen 5-stelligen Bereich, direktes
 * Zeichnen ist dafür schnell genug. Bei Bedarf (Kalibrierphase, M8) hier
 * nachrüsten.
 */

import { CF_FEW, CF_BKN } from "../clouds.js";

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zeichnet die Wolkenschraffur direkt in den Haupt-Canvas-Kontext. */
export function drawClouds(ctx, grid, cloudFrac, x, y) {
  const { nk, times, meta } = grid, nt = times.length;
  const dt = nt > 1 ? times[1] - times[0] : 3600;
  const rng = mulberry32(hashSeed(`${meta.lat},${meta.lon},${meta.elevation},${times[0]}`));

  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < nt; i++) {
    const x0 = x(times[i] - dt / 2), x1 = x(times[i] + dt / 2);
    if (x1 < x.left || x0 > x.right) continue;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      const cf = cloudFrac[ix];
      if (!(cf >= CF_FEW)) continue;
      const zLo = k > 0 ? (grid.z[ix] + grid.z[ix - 1]) / 2 : grid.z[ix];
      const zHi = k < nk - 1 ? (grid.z[ix] + grid.z[ix + 1]) / 2 : grid.z[ix];
      const yTop = y(zHi), yBot = y(zLo);
      if (yBot <= y.top || yTop >= y.bot) continue; // außerhalb des sichtbaren Höhenbands

      if (cf >= CF_BKN) {
        ctx.fillStyle = `rgba(255,255,255,${(0.12 + 0.35 * cf).toFixed(2)})`;
        ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
      }
      const n = Math.max(1, Math.round(cf * 6));
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1;
      for (let s = 0; s < n; s++) {
        const rx = x0 + rng() * (x1 - x0);
        const ry = yTop + rng() * Math.max(1, yBot - yTop);
        const len = 3 + rng() * 6;
        const curve = (rng() - 0.5) * 3;
        ctx.beginPath();
        ctx.moveTo(rx - len / 2, ry);
        ctx.quadraticCurveTo(rx, ry + curve, rx + len / 2, ry);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
