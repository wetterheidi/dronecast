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
import { hashSeed, mulberry32 } from "./noise.js";

// Strichdichte in PIXELN (Striche je 1000 px² bei voller Bedeckung) — bewusst
// NICHT als feste Strichzahl je Gitterzelle: dieselbe Falle wie beim
// Niederschlagsvorhang (s. `render.js` `precipSpacingPx`). Modell-Level liegen
// am Boden dicht beieinander und oben weit auseinander, die Höhenachse staucht
// zusätzlich (log) bzw. streckt (lin). Bei fester Zahl je Zelle schwankte die
// sichtbare Dichte dadurch um Faktor ~35 über die Achse: auf der log-Achse
// wirkten 75 % Bedeckung am Boden etwa 5x dünner als in 10 km Höhe, im
// lin-Zoom kippte es ins Gegenteil (unten verklumpt, oben ausgedünnt).
// Über die Pixelfläche gezählt bleibt der Eindruck in beiden Achsenmodi gleich.
// Der Wert ist die eine Stellschraube für die Gesamtdichte -- rein optisch
// eingestellt, nicht gegen echte GRAMETs kalibriert.
const STROKES_PER_1000PX2 = 50;

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
      const hPx = yBot - yTop;
      const nExact = STROKES_PER_1000PX2 * cf * (x1 - x0) * Math.max(0, hPx) / 1000;
      // Nachkommaanteil stochastisch runden (mit demselben seeded PRNG, bleibt
      // also reproduzierbar): erzwänge man je Zelle mindestens einen Strich,
      // würde ein Stapel sehr dünner Zellen — am Boden im lin-Zoom sind das
      // 1-2 px pro Level — wieder überzeichnet. So stimmt die Dichte auch über
      // einen solchen Stapel im Mittel.
      const n = Math.floor(nExact) + (rng() < nExact % 1 ? 1 : 0);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1;
      for (let s = 0; s < n; s++) {
        const rx = x0 + rng() * (x1 - x0);
        const ry = yTop + rng() * Math.max(1, hPx);
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
