/**
 * Windspinne: Polardarstellung des Windprofils (Windrichtung × Höhe) zu EINEM
 * Zeitpunkt (Masterzeit) -- Ergänzung zu Meteogramm/Cross-Section/GRAMET, die
 * den Zeitverlauf zeigen. Radius = Höhe AGL (Anzeigeeinheit), Winkel =
 * Windrichtung (Herkunft, N oben, im Uhrzeigersinn), Farbe =
 * Windgeschwindigkeit.
 *
 * Farbcodierung (`opts.colorStops`): BEWUSST kein fest verdrahteter Import
 * von windoverlay.js `WIND_FILL_STOPS` (drohnenspezifische Grenzwerte, s.
 * dortiger Kommentar) -- dieses Modul ist als Kandidat für eine
 * app-übergreifend wiederverwendbare Komponente gedacht (Drohnen UND z. B.
 * Fallschirmspringer als denkbare Nutzer, s. Nutzerfeedback), und die
 * Bedeutung von "gefährlich schnell" unterscheidet sich je Aktivität. Der
 * Host reicht seine eigene Farbskala über `opts.colorStops` herein (Format
 * wie `WIND_FILL_STOPS`: `{max, rgb:[r,g,b]}[]`, aufsteigend, letzter Eintrag
 * `max: Infinity`); ohne Angabe greift `DEFAULT_COLOR_STOPS` (Beaufort-
 * orientiert, aktivitätsneutral) als Fallback. Dronecast selbst übergibt
 * weiterhin `WIND_FILL_STOPS`, damit die Windfarbe innerhalb der App
 * dieselbe Bedeutung behält wie beim Windflächen-Kartenlayer.
 *
 * Erwartetes `profile` (aus `column.js` `sliceColumnAtTime()`):
 *   { z: number[] (Höhe AGL in m, aufsteigend, Level 0 unten),
 *     u: number[], v: number[] (m/s, je Level) }
 *
 * Interpolation zwischen zwei Modell-Leveln: Richtung und Betrag GETRENNT
 * interpoliert -- Betrag linear, Richtung über den kürzeren Bogen (wie im
 * DZMaster-Original `linearInterpolateAngle`), NICHT die rohen u/v-
 * Komponenten (frühere Version dieses Moduls, s. Nutzerfeedback). Grund:
 * bei zwei ähnlich schwachen, aber entgegengesetzt gerichteten Leveln (z. B.
 * 112°/1 kt und 297°/1 kt) verläuft die Gerade in u/v-Raum nahe am Nullpunkt
 * -- das erfindet einen Flaute-Einbruch in der Mitte der Schicht, den die
 * Daten nicht hergeben, UND macht die geschwungene Richtung hochempfindlich
 * gegenüber kleinsten Eingabeänderungen (mal kürzerer, mal längerer Bogen,
 * rein zufällig je nach genauer Vektorgeometrie -- keine verlässliche
 * "kürzester Weg"-Wahl). Weder das eine noch das andere Verfahren kennt den
 * TATSÄCHLICHEN Verlauf zwischen zwei Leveln (das geben die Daten nicht her)
 * -- der kürzere Bogen ist aber die plausiblere, deterministische Annahme
 * für eine Scherschicht und entspricht DZMasters Konvention.
 *
 * Abtastschritt: wie im DZMaster-Original ZWEI getrennte Raster --
 * `LINE_STEP_M` (fest 50 m, unabhängig von der Maximalhöhe) für die
 * Verbindungslinie, damit rasche Drehungen (Scherschichten, z. B. Ost über
 * Nord auf Nordwest innerhalb weniger hundert Meter) tatsächlich als Kurve
 * sichtbar werden statt als gerade Sekante zwischen zwei weit auseinander-
 * liegenden Stützpunkten. `PROFILE_STEP_TIERS` (gröber, höhenabhängig)
 * bestimmt nur noch die Stützpunkt-MARKER samt Tooltip -- sonst wären bei
 * großen Maximalhöhen Hunderte Marker übereinander.
 *
 * Reines SVG (kein Chart.js) -- folgt derselben Konvention wie
 * meteogram.js/crosssection.js statt einer neuen Abhängigkeit. Legende ist
 * Teil desselben SVG (nicht separates HTML) -- ein einziger Export
 * (`exportPng()`) erfasst damit Chart UND Legende in einem Bild.
 */

import { classFor, hex } from "./overlayshared.js";
import {
  heightToDisplay, heightFromDisplay, heightUnit,
  windToDisplay, windUnit, fmtHeight, fmtWind, fmtDirPadded,
} from "./units.js";

const NS = "http://www.w3.org/2000/svg";
const INK = "#0b0b0b", MUTED = "#52514e", GRID = "#d9d8d3";
const D = 560; // Breite der Zeichenfläche (quadratisch), skaliert responsiv per CSS
const PAD = 56; // Rand für Grad-/Höhenlabels
const LEGEND_H = 54; // zusätzliche Höhe unterhalb des Kreises für die Legende

// Beaufort-Grenzen (m/s, aufgerundet) -- aktivitätsneutraler Default, falls
// ein Host keine eigenen `colorStops` übergibt (s. Doc-Kommentar oben).
export const DEFAULT_COLOR_STOPS = [
  { max: 3.3, rgb: [148, 195, 230] },  // Bft 0-2: still bis schwache Brise
  { max: 5.4, rgb: [104, 178, 205] },  // Bft 3: leichte Brise
  { max: 7.9, rgb: [124, 189, 132] },  // Bft 4: mäßige Brise
  { max: 10.7, rgb: [206, 202, 92] },  // Bft 5: frische Brise
  { max: 13.8, rgb: [227, 156, 69] },  // Bft 6: starker Wind
  { max: 17.1, rgb: [216, 92, 63] },   // Bft 7: steifer Wind
  { max: Infinity, rgb: [150, 45, 110] }, // Bft 8+: stürmisch und mehr
];

// Feste Abtastung der LINIE (m, SI) -- unabhängig von der Maximalhöhe, exakt
// wie im DZMaster-Original (dort `lineStep = 50` m). Sorgt dafür, dass auch
// bei großer Maximalhöhe (z. B. 6000 m) rasche Windrichtungsänderungen über
// wenige hundert Meter als Kurve statt als Gerade erscheinen.
const LINE_STEP_M = 50;

// Abtastschritt der MARKER (m, SI) je nach eingestellter Maximalhöhe --
// feiner nahe am Boden, wo Scherung für Drohnen am wichtigsten ist, gröber
// in großer Höhe (sonst zu viele Marker/Tooltips übereinander).
const PROFILE_STEP_TIERS = [
  { upTo: 300, step: 25 },
  { upTo: 1000, step: 100 },
  { upTo: 4000, step: 200 },
  { upTo: Infinity, step: 500 },
];
function profileStepM(maxHeightM) {
  return PROFILE_STEP_TIERS.find((t) => maxHeightM <= t.upTo).step;
}

function mk(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, val);
  return el;
}

/** ~6 Ringe, "runde" Schrittweite -- funktioniert für jede Größenordnung
 *  (120 m Drohnen-Deckel bis 10000 m Flughöhenoption). Unabhängig von der
 *  (feineren) Abtastschrittweite der Profildaten -- reine Lesbarkeit des
 *  Gitters, nicht an die Datenpunkte gekoppelt. */
function niceStep(max) {
  if (!(max > 0)) return 1;
  const target = max / 6;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const norm = target / mag;
  const mult = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return mult * mag;
}

/** Richtung/Betrag je Level EINMAL aus u/v ableiten (nicht pro Abfrage --
 *  beide Abtastraster fragen denselben Levelsatz mehrfach ab). */
function levelDirSpd(u, v) {
  const n = u.length;
  const dir = new Array(n), spd = new Array(n);
  for (let k = 0; k < n; k++) {
    spd[k] = Math.hypot(u[k], v[k]);
    dir[k] = (Math.atan2(-u[k], -v[k]) * 180 / Math.PI + 360) % 360;
  }
  return { dir, spd };
}

/** Kürzester Bogen zwischen zwei Richtungen (Grad), s. Doc-Kommentar oben --
 *  Δ auf ±180° geklammert, bevor interpoliert wird. */
function lerpAngle(a0, a1, f) {
  const delta = ((a1 - a0 + 540) % 360) - 180;
  return (a0 + delta * f + 360) % 360;
}

/** Bracket + Interpolation über die Höhe: Betrag linear, Richtung über den
 *  kürzeren Bogen (s. `lerpAngle`). */
function sampleAt(z, dirLevel, spdLevel, h) {
  const n = z.length;
  if (n === 0) return null;
  if (n === 1 || h <= z[0]) return { dir: dirLevel[0], spd: spdLevel[0] };
  if (h >= z[n - 1]) return { dir: dirLevel[n - 1], spd: spdLevel[n - 1] };
  let k = 1;
  while (k < n && z[k] < h) k++;
  const k0 = k - 1, f = (h - z[k0]) / (z[k] - z[k0]);
  return {
    dir: lerpAngle(dirLevel[k0], dirLevel[k], f),
    spd: spdLevel[k0] + f * (spdLevel[k] - spdLevel[k0]),
  };
}

/** Kompassrichtung (Herkunft, r=Pixel-Radius) -> {x,y} relativ zum Zentrum,
 *  N oben, im Uhrzeigersinn (Bildschirm-Y wächst nach unten). */
function toXY(rPx, dirDeg) {
  const rad = dirDeg * Math.PI / 180;
  return { x: rPx * Math.sin(rad), y: -rPx * Math.cos(rad) };
}

function txt(x, y, s, fill, size, anchor = "start", weight = 400) {
  const t = mk("text", { x, y, fill, "font-size": size, "text-anchor": anchor, "font-weight": weight });
  t.textContent = s;
  return t;
}

/** Gestylte Tooltip-Box an der Cursorposition, mit Kantenumbruch -- exakt
 *  dasselbe Muster wie meteogram.js/crosssection.js `drawTip()` (dort je
 *  eigene Kopie, hier ebenfalls lokal statt geteiltem Modul, s. Dateikonvention). */
function drawTip(ov, px, py, lines, W, H) {
  const pad = 7, lh = 15, w = 150, h = pad * 2 + lines.length * lh;
  let tx = px + 14, ty = py + 14;
  if (tx + w > W) tx = px - 14 - w;
  if (ty + h > H) ty = py - 14 - h;
  ov.append(mk("rect", { x: tx, y: ty, width: w, height: h, rx: 5, fill: "rgba(252,252,251,0.97)", stroke: "#c9c8c2", "stroke-width": 1 }));
  lines.forEach((ln, j) => {
    ov.append(txt(tx + pad, ty + pad + lh * (j + 1) - 4, ln, j === 0 ? INK : MUTED, 11, "start", j === 0 ? 700 : 400));
  });
}

/** Textbreite ohne DOM-Messung (Canvas 2D `measureText`, funktioniert auch
 *  vor dem Einhängen ins Dokument) -- für den Legenden-Zeilenumbruch. */
const measureCtx = document.createElement("canvas").getContext("2d");
function textWidth(str, font) {
  measureCtx.font = font;
  return measureCtx.measureText(str).width;
}

function drawLegend(svg, stops, top) {
  const font = "11px system-ui, sans-serif";
  const chipR = 5, chipGap = 5, itemGap = 16, rowH = 18;
  let last = 0;
  const items = stops.map((s) => {
    const label = s.max === Infinity
      ? `> ${Math.round(windToDisplay(last))}`
      : `${Math.round(windToDisplay(last))}–${Math.round(windToDisplay(s.max))}`;
    last = s.max;
    return { label, rgb: s.rgb, w: chipR * 2 + chipGap + textWidth(label, font) };
  });

  const maxRowW = D - 24;
  const rows = [];
  let row = [], rowW = 0;
  for (const it of items) {
    const addW = it.w + (row.length ? itemGap : 0);
    if (row.length && rowW + addW > maxRowW) { rows.push({ row, rowW }); row = []; rowW = 0; }
    row.push(it);
    rowW += it.w + (row.length > 1 ? itemGap : 0);
  }
  if (row.length) rows.push({ row, rowW });

  let y = top + 14;
  for (const { row, rowW } of rows) {
    let x = (D - rowW) / 2;
    for (const it of row) {
      const g = mk("g");
      g.append(mk("circle", { cx: x + chipR, cy: y - 4, r: chipR, fill: hex(it.rgb) }));
      const t = mk("text", { x: x + chipR * 2 + chipGap, y, "font-size": 11, fill: MUTED });
      t.textContent = it.label;
      g.append(t);
      svg.append(g);
      x += it.w + itemGap;
    }
    y += rowH;
  }
  const u = mk("text", { x: D / 2, y, "font-size": 10, fill: MUTED, "text-anchor": "middle" });
  u.textContent = windUnit();
  svg.append(u);
}

/** Zeichnet die Windspinne in `host` (Container wird geleert) und liefert
 *  das erzeugte `<svg>`-Element zurück (für `exportPng()`). */
export function renderWindspinne(host, profile, opts = {}) {
  host.innerHTML = "";
  const z = profile?.z, u = profile?.u, v = profile?.v;
  if (!z?.length) { host.textContent = "Kein Höhenprofil verfügbar."; return null; }

  const { dir: dirLevel, spd: spdLevel } = levelDirSpd(u, v);
  const colorStops = opts.colorStops || DEFAULT_COLOR_STOPS;
  const maxHeightM = opts.maxHeightM > 0 ? opts.maxHeightM : Math.max(...z);
  const maxR = Math.max(1, Math.round(heightToDisplay(maxHeightM)));
  const ringStep = niceStep(maxR);
  const cx = D / 2, cy = D / 2, R = D / 2 - PAD;
  const px = (rDisplay) => (rDisplay / maxR) * R;

  const svg = mk("svg", {
    viewBox: `0 0 ${D} ${D + LEGEND_H}`, width: "100%", height: "100%",
    preserveAspectRatio: "xMidYMid meet", class: "ws-svg",
  });

  // -- Gitter: konzentrische Ringe + Radialspeichen -----------------------
  const gGrid = mk("g", { stroke: GRID, "stroke-width": 1, fill: "none" });
  svg.append(gGrid);
  for (let r = ringStep; r <= maxR + ringStep * 0.001; r += ringStep) {
    const rr = Math.min(r, maxR);
    gGrid.append(mk("circle", { cx, cy, r: px(rr) }));
    const t = mk("text", {
      x: cx + 4, y: cy - px(rr) - 4, fill: MUTED, "font-size": 10, "text-anchor": "start",
    });
    t.textContent = `${Math.round(rr)} ${heightUnit()}`;
    svg.append(t);
    if (rr >= maxR) break;
  }
  const CARDINAL = { 0: "N", 90: "O", 180: "S", 270: "W" };
  for (let deg = 0; deg < 360; deg += 30) {
    const p = toXY(R, deg);
    gGrid.append(mk("line", { x1: cx, y1: cy, x2: cx + p.x, y2: cy + p.y }));
    const lp = toXY(R + 16, deg);
    const t = mk("text", {
      x: cx + lp.x, y: cy + lp.y, fill: MUTED, "font-size": deg in CARDINAL ? 13 : 10,
      "font-weight": deg in CARDINAL ? 700 : 400,
      "text-anchor": "middle", "dominant-baseline": "middle",
    });
    t.textContent = CARDINAL[deg] || `${deg}°`;
    svg.append(t);
  }

  // -- Profil: feine Linie (LINE_STEP_M, löst Scherschichten auf) + gröbere
  //    Stützpunkt-Marker mit Tooltip (PROFILE_STEP_TIERS) -- zwei getrennte
  //    Raster wie im DZMaster-Original, s. Doc-Kommentar oben. -----------
  const sampleRange = (stepM) => {
    const out = [];
    for (let hSI = 0; ; hSI += stepM) {
      const h = Math.min(hSI, maxHeightM);
      const s = sampleAt(z, dirLevel, spdLevel, h);
      if (s) {
        const rDisplay = heightToDisplay(h);
        out.push({ h, rDisplay, ...s, ...toXY(px(rDisplay), s.dir) });
      }
      if (h >= maxHeightM) break;
    }
    return out;
  };
  const linePts = sampleRange(LINE_STEP_M);
  const markerPts = sampleRange(profileStepM(maxHeightM));

  const gLine = mk("g", { "stroke-linecap": "round" });
  svg.append(gLine);
  for (let i = 1; i < linePts.length; i++) {
    const a = linePts[i - 1], b = linePts[i];
    const rgb = classFor((a.spd + b.spd) / 2, colorStops).rgb;
    gLine.append(mk("line", {
      x1: cx + a.x, y1: cy + a.y, x2: cx + b.x, y2: cy + b.y,
      stroke: hex(rgb), "stroke-width": 2.5,
    }));
  }

  const gPts = mk("g");
  svg.append(gPts);
  for (const p of markerPts) {
    const rgb = classFor(p.spd, colorStops).rgb;
    gPts.append(mk("circle", { cx: cx + p.x, cy: cy + p.y, r: 3.5, fill: hex(rgb) }));
  }

  drawLegend(svg, colorStops, D);

  // -- Hover: stufenloses Fadenkreuz wie in Meteogramm/Cross-Section, aber
  //    polar -- Cursor-Radius -> Höhe (kontinuierlich, per heightFromDisplay),
  //    Richtung/Speed dann per sampleAt() an genau dieser Höhe abgelesen (der
  //    Cursor-WINKEL bleibt dabei bewusst unberücksichtigt: die Windrichtung
  //    ist wie bei der Profillinie selbst eine Funktion der Höhe, keine vom
  //    Nutzer wählbare zweite Achse). Ersetzt das bisherige native `<title>`
  //    auf den Marker-Punkten (Browser-Tooltipverzögerung, kleine Trefferfläche
  //    -- s. Nutzerfeedback), Trefferfläche ist jetzt die ganze Kreisfläche.
  const ov = mk("g", { "pointer-events": "none" });
  svg.append(ov);
  const clearOv = () => { while (ov.firstChild) ov.removeChild(ov.firstChild); };

  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (D / r.width);
    const my = (e.clientY - r.top) * ((D + LEGEND_H) / r.height);
    const rPx = Math.hypot(mx - cx, my - cy);
    if (rPx > R + 8) { clearOv(); return; }

    const rDisplay = Math.min((rPx / R) * maxR, maxR);
    const h = Math.min(heightFromDisplay(rDisplay), maxHeightM);
    const s = sampleAt(z, dirLevel, spdLevel, h);
    const rgb = classFor(s.spd, colorStops).rgb;
    const dot = toXY(px(rDisplay), s.dir);

    clearOv();
    ov.append(mk("circle", { cx: cx + dot.x, cy: cy + dot.y, r: 5, fill: "none", stroke: "#fff", "stroke-width": 2.4 }));
    ov.append(mk("circle", { cx: cx + dot.x, cy: cy + dot.y, r: 5, fill: "none", stroke: hex(rgb), "stroke-width": 1.8 }));
    drawTip(ov, mx, my, [
      `${fmtHeight(h)} AGL`,
      `${fmtDirPadded(s.dir)} · ${fmtWind(s.spd)}`,
    ], D, D + LEGEND_H);
  });
  svg.addEventListener("pointerleave", clearOv);

  host.append(svg);
  return svg;
}

/** SVG -> PNG (Canvas-Rasterung, da `<svg width="100%">` kein eigenes
 *  Intrinsic-Maß für `Image` hat -- Klon mit expliziten Pixelmaßen aus der
 *  viewBox). Muster wie `gramet/render.js` `exportPng()`, dort direkt auf
 *  einem `<canvas>`; hier zusätzlich der Rasterisierungsschritt davor. */
export function exportPng(svgEl, nameParts, scale = 2) {
  if (!svgEl) return;
  const vb = svgEl.viewBox.baseVal;
  const clone = svgEl.cloneNode(true);
  clone.setAttribute("width", vb.width);
  clone.setAttribute("height", vb.height);
  clone.setAttribute("xmlns", NS);

  const xml = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = vb.width * scale;
    canvas.height = vb.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fcfcfb";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = dlUrl;
      a.download = `${nameParts.filter(Boolean).join("_")}.png`;
      a.click();
      URL.revokeObjectURL(dlUrl);
    });
  };
  img.src = url;
}
