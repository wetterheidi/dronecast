/**
 * GRAMET-Meteogramm — Canvas-Renderer (anders als die SVG-Cross-Section:
 * Wolkenschraffur mit vielen Einzelstrichen ist auf Canvas günstiger).
 * Einstieg: `renderGramet(host, grid, view, state)`, `state = { zMin, zMax,
 * axis: "log"|"lin", activeRows, layerToggles }`. Höhenumschalter (axis/
 * zMin/zMax) folgt demselben State/Mechanismus wie `crosssection.js`
 * (`settings.xsZoom`) — dieselbe Umschaltfläche bedient beide Ansichten.
 *
 * Vereinfachung ggü. Plan: kein Offscreen-Cache für die Wolkentextur und kein
 * separates Overlay-Canvas fürs Hover-Fadenkreuz — jede State-Änderung baut
 * (wie bei `crosssection.js`) den ganzen Canvas neu auf, das ist bei
 * nt*nk im niedrigen 5-stelligen Bereich schnell genug (s. `texture.js`).
 * Hover zeigt die Werte als reines DOM-Overlay (Tooltip-Div), ohne
 * Fadenkreuz-Redraw.
 */

import { sampleAt } from "./grid.js";
import { contour } from "./derive.js";
import { drawClouds, drawCbShafts, drawCbAnvils } from "./texture.js";
import { hashSeed, hashRand } from "./noise.js";
import { drawWindRow, WIND_ROW_HEIGHT } from "./rows/wind.js";
import { drawNumberRow, NUMBER_ROW_HEIGHT } from "./rows/numberRow.js";
import { niceLogHeights, niceTicks, fmtH } from "../crosssection.js";
import { CHART_PX_PER_HOUR } from "../windbarb.js";
import { fmtHeight, fmtWind, fmtTemp, fmtDir } from "../units.js";
import { metarWeather } from "../briefing.js";

const INK = "#0b0b0b", MUTED = "#52514e", GRID = "#d9d8d3";
// Rechter Rand: Platz für die Beschriftungskästchen der Isothermen/Isotachen/
// Tropopause, die am rechten Ende ihrer Polylinie sitzen (also i. d. R. exakt
// auf `x.right`) -- mit dem alten 16 px wurden sie abgeschnitten.
const TOPAX = 22, GAP = 16, BOT = 22, M = { l: 50, r: 52 };

// Füllfarbe des mitscrollenden Achsenstreifens: deckend, damit der Chart beim
// horizontalen Scrollen darunter verschwindet (Panel-Hintergrund von #gramet).
const PANEL_BG = "#fcfcfb";

// Dunkleres Blau als im ersten Entwurf (das helle Himmelblau ließ die weiße
// Wolkenschraffur verschwinden) -- näher am Original-GRAMET-Kontrast.
const NIGHT_COLOR = "#050b1e", DAY_COLOR = "#2b5c93";

// Hazard-Flächen als Kontur-Umriss (marching squares, s. `derive.js`
// `contour()`) statt Zellraster -- entspricht der GRAMET-Konvention aus dem
// Referenz-Screenshot (gestrichelt umrandete Fläche statt Pixelraster).
// icing: Grün (klassische Vereisungsfarbe), turbulence: Gelb->Orange->Rot
// (steigender Schweregrad), analog zur gelb umrandeten Fläche im Original.
const ICING_STYLES = { light: "#2e7d32", moderate: "#1b5e20", severe: "#0d3b10" };
const TURB_STYLES = { light: "#f9a825", moderate: "#ef6c00", severe: "#c62828" };
const HAZARD_LEVELS = { light: 1, moderate: 2, severe: 3 };

// Cb/TCU: sandfarbener Schaft + Amboss (Ellipsentechnik, s. `texture.js`), dazu
// als Kennzeichnung die WOLKENSYMBOLE DER BODENEINTRAGUNGSSYSTEMATIK (WMO-
// Schlüssel C_L) statt eines frei erfundenen Glyphs -- die kennt jeder
// Meteorologe von der Bodenkarte. Reine Strichzeichnung in Schwarz, wie auf
// der Karte; darunter ein weißer Halo, sonst geht der dünne Strich in der
// gefleckten Wolkentextur unter.
const CB_SYMBOL_INK = "#12161c";
const CB_SYMBOL_HALO = "rgba(255,255,255,0.9)";

const ROW_DEFS = {
  wind: {
    height: WIND_ROW_HEIGHT, label: ["Wind", "10 m"],
    draw: (ctx, grid, x, top, h) => drawWindRow(ctx, grid, x, top, h),
  },
  tempdew: {
    height: NUMBER_ROW_HEIGHT, label: ["T /", "Taupunkt"],
    draw: (ctx, grid, x, top, h) => drawNumberRow(ctx, grid.times, x, top, h, [
      { values: grid.surface.t2m, fmt: (v) => fmtTemp(v), color: "#c0392b" },
      { values: grid.surface.td2m, fmt: (v) => fmtTemp(v), color: "#2980b9" },
    ]),
  },
  gust: {
    height: NUMBER_ROW_HEIGHT * 0.7, label: ["Böen", "10 m"],
    draw: (ctx, grid, x, top, h) => drawNumberRow(ctx, grid.times, x, top, h, [
      { values: grid.surface.gust, fmt: (v) => fmtWind(v), color: "#6a3d9a" },
    ]),
  },
  pressure: {
    height: NUMBER_ROW_HEIGHT * 0.7, label: ["SLP", "hPa"],
    draw: (ctx, grid, x, top, h) => drawNumberRow(ctx, grid.times, x, top, h, [
      { values: grid.surface.pmsl, fmt: (v) => String(Math.round(v)), color: "#1a6b4a" },
    ]),
  },
  weather: {
    height: NUMBER_ROW_HEIGHT * 0.55, label: ["Wetter", "(METAR)"],
    draw: (ctx, grid, x, top, h) => drawWeatherRow(ctx, grid, x, top, h),
  },
};

const DEFAULT_ROWS = ["wind", "tempdew", "gust", "pressure", "weather"];

export function renderGramet(host, grid, view, state = {}) {
  host.innerHTML = "";
  const { times, nk } = grid;
  if (!times || times.length < 2) { host.textContent = "Keine Gitterdaten."; return null; }

  const activeRows = (state.activeRows ?? DEFAULT_ROWS).filter((id) => ROW_DEFS[id]);
  const lin = state.axis === "lin";
  const hMinData = Math.max(10, grid.z[0] || 10);
  const hMaxData = grid.z[nk - 1];
  const zMin = state.zMin ?? hMinData, zMax = state.zMax ?? hMaxData;

  const hours = Math.max(1, (times[times.length - 1] - times[0]) / 3600);
  const containerPw = Math.max(host.clientWidth || 0, 360) - M.l - M.r;
  const pw = Math.max(hours * CHART_PX_PER_HOUR, containerPw);

  const rowsH = activeRows.reduce((s, id) => s + ROW_DEFS[id].height, 0);
  const mainH = Math.max(240, (host.clientHeight || 560) - TOPAX - rowsH - GAP * 2 - BOT);

  const W = M.l + pw + M.r;
  const H = TOPAX + mainH + GAP + rowsH + GAP + BOT;
  const dpr = window.devicePixelRatio || 1;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  canvas.className = "gm-canvas";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const t0 = times[0], t1 = times[times.length - 1];
  const x = (t) => M.l + (t - t0) / (t1 - t0) * pw;
  x.left = M.l; x.right = M.l + pw;

  const mainTop = TOPAX, mainBot = TOPAX + mainH;
  const y = makeYScale(mainTop, mainBot, zMin, zMax, lin);

  const toggles = state.layerToggles ?? {};
  drawBackground(ctx, grid, view, x, mainTop, mainBot);
  drawHazardArea(ctx, grid, view.hazards.icing, ICING_STYLES, x, y);
  if (toggles.cb !== false) drawCbShafts(ctx, grid, view.cb, x, y);
  if (toggles.clouds !== false) drawClouds(ctx, grid, view.cloudFrac, x, y);
  if (toggles.cb !== false) {
    drawCbAnvils(ctx, grid, view.cb, x, y);
    drawCbGlyphs(ctx, view.cb, times, x, y);
  }
  const seed = hashSeed(`${grid.meta.lat},${grid.meta.lon},${grid.meta.elevation},${times[0]}`);
  if (toggles.precip !== false) drawPrecip(ctx, view.precip, times, x, y, seed);
  drawHazardArea(ctx, grid, view.hazards.turbulence, TURB_STYLES, x, y);
  if (toggles.isotherms !== false) drawIsotherms(ctx, view.isotherms, x, y);
  if (toggles.isotachs !== false) drawIsotachs(ctx, view.isotachs, x, y);
  if (toggles.tropopause !== false) drawTropopause(ctx, view.tropopause, x, y);

  ctx.strokeStyle = MUTED; ctx.lineWidth = 1;
  ctx.strokeRect(x.left + 0.5, mainTop + 0.5, pw - 1, mainH - 1);
  drawHeightAxis(ctx, y, zMin, zMax, x, lin);
  timeGridLines(ctx, times, x, mainTop, mainBot);

  let rowTop = mainBot + GAP;
  for (const id of activeRows) {
    const def = ROW_DEFS[id];
    ctx.save();
    ctx.beginPath(); ctx.rect(x.left, rowTop, pw, def.height); ctx.clip();
    def.draw(ctx, grid, x, rowTop, def.height);
    ctx.restore();
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.strokeRect(x.left + 0.5, rowTop + 0.5, pw - 1, def.height - 1);
    // Beschriftung im linken Randfeld (wie die Höhenachse), nicht über den
    // Werten -- dort war sie kaum lesbar (überlagert von Fiedern/Zahlen).
    drawRowLabel(ctx, def.label, x.left - 4, rowTop, def.height);
    rowTop += def.height;
  }

  drawTimeAxis(ctx, times, x, mainTop, rowTop);
  ctx.fillStyle = INK; ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "left";
  ctx.fillText("GRAMET", x.left, 13);

  const axis = makeStickyAxis(canvas, W, H, dpr);
  const plot = document.createElement("div");
  plot.className = "gm-plot";
  plot.append(axis, canvas);

  host.append(plot);
  setupHover(host, canvas, axis, grid, { x, y, mainTop, mainBot });
  return canvas;
}

// Der linke Randstreifen (Höhenachse + Zeilenbeschriftung) wird als Kopie der
// ersten `M.l` Pixel des fertigen Charts in ein eigenes, `position: sticky`
// gesetztes Canvas gespiegelt: beim horizontalen Scrollen bleibt die
// Beschriftung stehen, der Chart läuft darunter durch. Bewusst eine Kopie und
// kein eigener Zeichenpfad -- so bleibt genau ein Renderpfad, und das
// Haupt-Canvas enthält weiterhin alles (der PNG-Export braucht keine
// Sonderbehandlung).
function makeStickyAxis(canvas, W, H, dpr) {
  const axis = document.createElement("canvas");
  axis.className = "gm-axis";
  axis.width = Math.round(M.l * dpr);
  axis.height = Math.round(H * dpr);
  axis.style.width = `${M.l}px`;
  axis.style.height = `${H}px`;
  const actx = axis.getContext("2d");
  actx.scale(dpr, dpr);
  actx.fillStyle = PANEL_BG;
  actx.fillRect(0, 0, M.l, H);
  actx.drawImage(canvas, 0, 0, Math.round(M.l * dpr), canvas.height, 0, 0, M.l, H);
  // Negativer Rand: das Haupt-Canvas beginnt unter dem Streifen, die Summe der
  // Flex-Breiten bleibt damit W (kein zusätzlicher Scrollweg).
  canvas.style.marginLeft = `${-M.l}px`;
  return axis;
}

export function exportPng(canvas, nameParts) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${nameParts.filter(Boolean).join("_")}.png`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// --- Skalen ------------------------------------------------------------------

function makeYScale(top, bot, hMin, hMax, lin) {
  const safeMin = Math.max(hMin, lin ? hMin : 1);
  const la = lin ? safeMin : Math.log(safeMin), lb = lin ? hMax : Math.log(hMax);
  const f = (h) => {
    const s = lin ? clamp(h, safeMin, hMax) : Math.log(clamp(h, safeMin, hMax));
    return bot - (s - la) / (lb - la) * (bot - top);
  };
  f.top = top; f.bot = bot;
  f.inv = (py) => {
    const frac = clamp((bot - py) / (bot - top), 0, 1);
    return lin ? hMin + frac * (hMax - hMin) : Math.exp(la + frac * (lb - la));
  };
  return f;
}

// --- Hintergrund (Tag/Nacht) --------------------------------------------------

function drawBackground(ctx, grid, view, x, top, bot) {
  const { times } = grid;
  const span = x.right - x.left;
  const grad = ctx.createLinearGradient(x.left, 0, x.right, 0);
  let lastOff = -1;
  for (let i = 0; i < times.length; i++) {
    let off = clamp((x(times[i]) - x.left) / span, 0, 1);
    if (off <= lastOff) off = Math.min(1, lastOff + 1e-4);
    grad.addColorStop(off, mixHex(NIGHT_COLOR, DAY_COLOR, view.daylight[i]));
    lastOff = off;
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x.left, top, span, bot - top);
}

// --- Hazard-Flächen (Vereisung/Turbulenz, aktuell Stubs -> zeichnet nichts) --

// Kontur-Umriss statt Zellraster: reicht die Schweregrad-Zeichenkette (none/
// light/moderate/severe) als Zahlenfeld an `contour()` (marching squares,
// dieselbe Funktion wie für die Isotachen) durch und zeichnet je Schwelle
// eine gestrichelt umrandete, leicht gefüllte Fläche -- wie im Referenz-
// Screenshot (gelb umrandete Fläche um den Amboss), nicht als Pixelraster.
// Offene Polylinien (Kontur trifft den Gitterrand) werden trotzdem gefüllt
// (canvas schließt sie automatisch mit einer Geraden); bei echten Hazard-
// Daten ggf. visuell nachjustieren -- mit den aktuellen "none"-Stubs zeichnet
// das noch nichts.
function drawHazardArea(ctx, grid, hazardArr, styles, x, y) {
  const n = grid.times.length * grid.nk;
  const field = new Float32Array(n);
  for (let ix = 0; ix < n; ix++) field[ix] = HAZARD_LEVELS[hazardArr[ix]] || 0;

  for (const [level, key] of [[1, "light"], [2, "moderate"], [3, "severe"]]) {
    const polylines = contour(grid, field, level - 0.5);
    if (!polylines.length) continue;
    const color = styles[key];
    for (const pl of polylines) {
      if (pl.length < 2) continue;
      ctx.beginPath();
      pl.forEach((p, i) => {
        const px = x(p.t), py = y(p.z);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = `${color}33`;
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color; ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// --- Konvektion (TCU/Cb) — Klassifikation in derive.js, s. dort --------------

// Schaft: `drawCbShafts` (texture.js), vor den Wolken gezeichnet, damit die
// weißen Wolkenellipsen darüberliegen (wie im Referenz-GRAMET). Amboss und
// Symbol danach, sie sollen oben liegen.
//
// `kind` aus derive.js bestimmt das Symbol:
//   "cb"  -> C_L 9 (Cumulonimbus capillatus, mit Amboss)
//   "tcu" -> C_L 3 (Cumulonimbus calvus, noch ohne Amboss)
// Streng nach Schlüssel wäre eine Cumulus congestus C_L 2; C_L 3 ist hier
// bewusst gesetzt (so vorgegeben) und passt zur Klassifikation in derive.js
// insofern, als eine ausgelöste, mächtige Zelle ohne vergletscherten Oberrand
// genau der calvus-Stufe entspricht.
function drawCbGlyphs(ctx, cb, times, x, y) {
  const dt = times.length > 1 ? times[1] - times[0] : 3600;
  for (let i = 0; i < times.length; i++) {
    const c = cb[i];
    if (!c) continue;
    const cx = x(times[i]), cellW = x(times[i] + dt / 2) - x(times[i] - dt / 2);
    const yTop = y(c.top), yBot = y(Math.max(0, c.base));
    const cy = yTop + (yBot - yTop) * 0.45, size = Math.min(18, cellW * 0.8);
    strokeSymbol(ctx, c.kind === "cb" ? cl9Path(cx, cy, size) : cl3Path(cx, cy, size), size);
  }
}

/**
 * C_L 9 — Cumulonimbus mit Amboss. Kartensymbol: waagerechter Deckel oben,
 * waagerechte Basis unten, dazwischen zur Mitte hin eingeschnürte Flanken
 * (Sanduhr-Umriss).
 */
function cl9Path(cx, cy, size) {
  const w = size * 0.42, h = size * 0.48;
  const p = new Path2D();
  p.moveTo(cx - w, cy - h); p.lineTo(cx + w, cy - h);      // Ambossdeckel
  p.moveTo(cx - w, cy + h); p.lineTo(cx + w, cy + h);      // Basis
  p.moveTo(cx - w, cy - h); p.lineTo(cx, cy);              // Flanken zur Taille
  p.lineTo(cx + w, cy - h);
  p.moveTo(cx - w, cy + h); p.lineTo(cx, cy);
  p.lineTo(cx + w, cy + h);
  return p;
}

/**
 * C_L 3 — Cumulonimbus calvus. Kartensymbol: Quellwolkenkuppel auf flacher
 * Basis, darüber der kurze Stiel mit Querbalken (der beginnende, noch nicht
 * ausgebreitete Oberrand).
 */
function cl3Path(cx, cy, size) {
  const r = size * 0.42;
  const baseY = cy + r * 0.62, apexY = baseY - r;
  const p = new Path2D();
  p.moveTo(cx - r, baseY);
  p.arc(cx, baseY, r, Math.PI, 0);                          // Kuppel
  p.lineTo(cx - r, baseY);                                  // Basislinie
  p.moveTo(cx, apexY); p.lineTo(cx, apexY - r * 0.32);      // Stiel
  p.moveTo(cx - r * 0.45, apexY - r * 0.32);                // Querbalken
  p.lineTo(cx + r * 0.45, apexY - r * 0.32);
  return p;
}

// Zweimal stroken: erst breit in Weiß (Halo), dann schmal in Schwarz. Auf der
// gefleckten Schaft- bzw. Wolkentextur ist der Strich sonst kaum auszumachen.
function strokeSymbol(ctx, path, size) {
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = CB_SYMBOL_HALO; ctx.lineWidth = Math.max(3, size * 0.24);
  ctx.stroke(path);
  ctx.strokeStyle = CB_SYMBOL_INK; ctx.lineWidth = Math.max(1.2, size * 0.09);
  ctx.stroke(path);
  ctx.restore();
}

// --- Niederschlag --------------------------------------------------------------

// Symbolabstand in PIXELN — bewusst NICHT in Höhenmetern: die Höhenachse ist
// logarithmisch, gleich große Höhenschritte werden dadurch oben gestaucht und
// unten gedehnt. Bei fester Symbolzahl über die Höhe ballten sich die Symbole
// oben zusammen und rissen darunter kilometerweit auf (ein "-RA" zerfiel in
// Flocken oben, ein paar Tropfen, Lücke, ein Tropfen am Boden — s. Feedback).
// Über die Pixelachse verteilt bleibt der Vorhang in beiden Achsenmodi (log
// wie lin) optisch gleichmäßig. Dichte weiterhin aus der Intensität (mm/h);
// die Stufung ist grob und nicht kalibriert.
// tanh-Kennlinie statt linear, damit sich auch kräftiger Niederschlag noch
// abstuft (linear lief schon ab ~5 mm/h in den Minimalabstand und sah dann
// bei 5 wie bei 50 mm/h aus). RATE_SCALE = Rate, bei der ~76 % der Spanne
// ausgeschöpft sind. Stufung grob, nicht kalibriert.
const PRECIP_SPACING_MAX_PX = 30, PRECIP_SPACING_MIN_PX = 11, PRECIP_RATE_SCALE = 6;
function precipSpacingPx(rateMmH) {
  const r = Math.max(0, Number.isFinite(rateMmH) ? rateMmH : 0.5);
  const span = PRECIP_SPACING_MAX_PX - PRECIP_SPACING_MIN_PX;
  return PRECIP_SPACING_MAX_PX - span * Math.tanh(r / PRECIP_RATE_SCALE);
}

// Streuung der Symbole um ihre Rasterposition, damit der Vorhang nicht wie
// eine gezogene Linie wirkt (s. Wolkenschraffur, die schon so arbeitet).
// X als Anteil der Stundenspalte, Y als Anteil des Symbolabstands -- beide
// bewusst moderat: bei mehr als ~0,35 Spaltenbreite laufen die Vorhänge
// benachbarter Stunden ineinander und die Zuordnung "Vorhang unter dieser
// Stunde" geht verloren. Werte rein optisch gewählt.
const PRECIP_JITTER_X = 0.30, PRECIP_JITTER_Y = 0.32;
const PRECIP_SIZE_MIN = 0.80, PRECIP_SIZE_SPAN = 0.45;

function drawPrecip(ctx, entries, times, x, y, seed) {
  const dt = times.length > 1 ? times[1] - times[0] : 3600;
  const colW = Math.max(1, x(times[0] + dt) - x(times[0]));
  ctx.save();
  for (const e of entries) {
    const cx = x(e.t);
    const pyBot = y.bot - 4; // knapp innerhalb des Rahmens: Vorhang endet am Boden
    const pyTop = Math.max(y.top, y(Math.max(0, e.zTop)));
    const span = pyBot - pyTop;
    // Abstand auf die Spanne einrasten, damit der Vorhang exakt von der
    // Wolkenoberkante bis zum Boden reicht (sonst bliebe oben bis zu ein
    // ganzer Symbolabstand frei und der Vorhang wirkte abgeschnitten).
    const steps = span > 0 ? Math.max(1, Math.round(span / precipSpacingPx(e.rate))) : 0;
    const step = steps > 0 ? span / steps : 0;
    // Stundenindex statt Schleifenzähler als Hash-Koordinate: jeder Vorhang
    // würfelt damit unabhängig von allen anderen. Mit einem fortlaufenden
    // PRNG-Strom (wie bei den Wolken) hinge das Muster einer Stunde daran, wie
    // viele Symbole die Stunden davor gezogen haben -- ändert sich deren
    // Symbolzahl (Höhenumschalter), verschöbe sich der ganze Rest mit.
    // Die Symbolzahl je Vorhang hängt weiterhin an der Höhenachse, ein
    // umgeschalteter Vorhang sieht also anders aus -- aber nur er.
    const col = Math.round((e.t - times[0]) / dt);
    for (let s = 0; s <= steps; s++) {
      // Erstes und letztes Symbol NICHT vertikal versetzen: der Vorhang soll
      // weiterhin exakt an der Wolkenoberkante ansetzen und den Boden
      // erreichen (dieselbe Eigenschaft, die das Einrasten oben herstellt).
      const jy = (s === 0 || s === steps)
        ? 0
        : (hashRand(seed, col, s, 1) - 0.5) * 2 * PRECIP_JITTER_Y * step;
      const py = pyBot - s * step + jy;
      // Seitlich in der Spalte streuen, aber innerhalb des Chartrahmens
      // bleiben -- sonst rutschte die erste/letzte Stunde über die Höhenachse
      // bzw. in den rechten Rand mit den Linien-Labels.
      const jx = (hashRand(seed, col, s, 0) - 0.5) * 2 * PRECIP_JITTER_X * colW;
      const px = clamp(cx + jx, x.left + 3, x.right - 3);
      // Phase aus der Höhe, die dieses Pixel tatsächlich meint.
      const z = y.inv(py);
      const snowHere = e.type === "sn" || (Number.isFinite(e.freezingZ) && z > e.freezingZ);
      const size = PRECIP_SIZE_MIN + hashRand(seed, col, s, 2) * PRECIP_SIZE_SPAN;
      const rot = hashRand(seed, col, s, 3);
      // Flocke: Drehung über 60° reicht, ein 3-Strich-Stern ist so periodisch.
      if (snowHere) drawAsterisk(ctx, px, py, 3.2 * size, rot * Math.PI / 3);
      else drawDash(ctx, px, py, 4.5 * size, rot);
    }
  }
  ctx.restore();
}
// Weißes Halo zuerst (wie bei den Isothermen/Isotachen), dann die eigentliche
// Farbe -- sonst geht das Symbol im dunkleren Himmelblau unter (s. Feedback).
const PRECIP_COLOR = "#134a7a";
function drawAsterisk(ctx, cx, cy, r, rot = 0) {
  for (const [stroke, width] of [["#fff", 2.6], [PRECIP_COLOR, 1.2]]) {
    ctx.strokeStyle = stroke; ctx.lineWidth = width;
    for (const deg of [0, 60, 120]) {
      const rad = deg * Math.PI / 180 + rot;
      ctx.beginPath();
      ctx.moveTo(cx - r * Math.cos(rad), cy - r * Math.sin(rad));
      ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
      ctx.stroke();
    }
  }
}
// `tilt` in [0,1) variiert die Neigung des Tropfenstrichs (0.15..0.45 der
// Länge seitlich) -- gleichmäßig geneigte Striche lasen sich als Raster.
function drawDash(ctx, cx, cy, len, tilt = 0.5) {
  const dx = len * (0.15 + tilt * 0.3);
  for (const [stroke, width] of [["#fff", 2.8], [PRECIP_COLOR, 1.4]]) {
    ctx.strokeStyle = stroke; ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(cx - dx, cy - len * 0.5);
    ctx.lineTo(cx + dx, cy + len * 0.5);
    ctx.stroke();
  }
}

// --- Linien: Isothermen/Isotachen/Tropopause ---------------------------------

function drawPolyline(ctx, pl, x, y, color, dash) {
  if (pl.length < 2) return;
  ctx.save();
  ctx.setLineDash(dash);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
  pathFor(ctx, pl, x, y); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 1.4;
  pathFor(ctx, pl, x, y); ctx.stroke();
  ctx.restore();
}
function pathFor(ctx, pl, x, y) {
  ctx.beginPath();
  pl.forEach((p, i) => {
    const px = x(p.t), py = y(p.z);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
}
// `limitX` = rechte Kante, hinter die das Kästchen nicht laufen darf (CSS-
// Pixel). Vorher stand hier `ctx.canvas.width` -- das sind Geräte-Pixel
// (W * dpr), die Begrenzung hat also nie gegriffen.
function labelBox(ctx, px, py, text, color, limitX) {
  ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "start"; ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 8;
  const bx = Math.min(px + 2, limitX - w - 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(bx, py - 8, w, 16);
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(bx, py - 8, w, 16);
  ctx.fillStyle = color; ctx.fillText(text, bx + 4, py);
}
function rightmost(polylines) {
  return polylines.reduce((a, b) => (b[b.length - 1].t > a[a.length - 1].t ? b : a));
}

function drawIsotherms(ctx, isotherms, x, y) {
  for (const { tempC, polylines } of isotherms) {
    if (!polylines.length) continue;
    const color = tempC === 0 ? "#1d4c8c" : "#7a1414";
    for (const pl of polylines) drawPolyline(ctx, pl, x, y, color, [5, 3]);
    const last = rightmost(polylines);
    const p = last[last.length - 1];
    labelBox(ctx, x(p.t), y(p.z), `${tempC}°C`, color, x.right + M.r);
  }
}
function drawIsotachs(ctx, isotachs, x, y) {
  for (const { kt, polylines } of isotachs) {
    if (!polylines.length) continue;
    for (const pl of polylines) drawPolyline(ctx, pl, x, y, "#6b6b1f", [3, 3]);
    const last = rightmost(polylines);
    const p = last[last.length - 1];
    labelBox(ctx, x(p.t), y(p.z), `${kt} kt`, "#6b6b1f", x.right + M.r);
  }
}
function drawTropopause(ctx, line, x, y) {
  if (line.length < 2) return;
  drawPolyline(ctx, line, x, y, "#cc0000", []);
  const p = line[line.length - 1];
  labelBox(ctx, x(p.t), y(p.z), "Trop", "#cc0000", x.right + M.r);
}

// --- Achsen --------------------------------------------------------------------

function drawHeightAxis(ctx, y, hMin, hMax, x, lin) {
  const ticks = lin ? niceTicks(hMin, hMax, 6) : niceLogHeights(hMin, hMax);
  ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "middle";
  for (const hM of ticks) {
    const py = y(hM);
    ctx.strokeStyle = GRID; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x.left, py); ctx.lineTo(x.right, py); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = MUTED; ctx.textAlign = "right";
    ctx.fillText(fmtH(hM), x.left - 4, py);
  }
}

// Zeilenbeschriftung im linken Randfeld (gleiche Spalte wie die Höhenachse),
// zweizeilig zentriert auf die Zeilenhöhe.
function drawRowLabel(ctx, lines, rightX, top, height) {
  ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  const lh = 11, cy = top + height / 2 - (lines.length - 1) * lh / 2;
  lines.forEach((line, i) => ctx.fillText(line, rightX, cy + i * lh));
}

function timeGridLines(ctx, times, x, top, bot) {
  let lastDay = null;
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i] * 1000);
    if (d.getMinutes() !== 0) continue;
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      ctx.strokeStyle = "#c9c8c2"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x(times[i]), top); ctx.lineTo(x(times[i]), bot); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawTimeAxis(ctx, times, x, yTop, yBot) {
  let lastDay = null;
  ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "alphabetic";
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i] * 1000);
    if (d.getMinutes() !== 0) continue;
    const h = d.getHours(), dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      ctx.fillStyle = INK; ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "left";
      ctx.fillText(d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }), x(times[i]) + 3, yBot + 12);
      ctx.font = "10px system-ui, sans-serif";
    } else if (h === 6 || h === 12 || h === 18) {
      ctx.fillStyle = MUTED; ctx.textAlign = "center";
      ctx.fillText(String(h).padStart(2, "0"), x(times[i]), yBot + 12);
    }
  }
}

// --- Hover (DOM-Overlay) -------------------------------------------------------

function setupHover(host, canvas, axis, grid, info) {
  const { x, y, mainTop, mainBot } = info;
  host.style.position = host.style.position || "relative";
  const tip = document.createElement("div");
  tip.className = "gm-tip";
  tip.style.display = "none";
  host.append(tip);
  // Über dem festen Achsenstreifen liegt kein sichtbarer Chart -- Tooltip aus,
  // sonst bliebe der letzte Wert stehen, sobald der Zeiger den Streifen
  // erreicht (der Streifen fängt die Pointer-Events ab).
  axis.addEventListener("pointerenter", () => { tip.style.display = "none"; });

  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (py < mainTop || py > mainBot || px < x.left || px > x.right) { tip.style.display = "none"; return; }
    const t0 = grid.times[0], t1 = grid.times[grid.times.length - 1];
    const frac = (px - x.left) / (x.right - x.left);
    const tGuess = t0 + frac * (t1 - t0);
    let i = 0, best = Infinity;
    for (let j = 0; j < grid.times.length; j++) {
      const d = Math.abs(grid.times[j] - tGuess);
      if (d < best) { best = d; i = j; }
    }
    const h = y.inv(py);
    const s = sampleAt(grid, i, h);
    const dir = (Math.atan2(-s.u, -s.v) * 180 / Math.PI + 360) % 360;
    tip.style.display = "block";
    tip.style.left = `${px + 12}px`;
    tip.style.top = `${py + 12}px`;
    tip.innerHTML = [
      `<b>${new Date(grid.times[i] * 1000).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" })}</b>`,
      `Höhe ${fmtHeight(h)}`,
      `Temp ${fmtTemp(s.T - 273.15)}`,
      `Wind ${fmtDir(dir)} ${fmtWind(Math.hypot(s.u, s.v))}`,
      `Wolken ${Math.round((s.cloudFrac || 0) * 100)} %`,
    ].join("<br>");
  });
  canvas.addEventListener("pointerleave", () => { tip.style.display = "none"; });
}

// --- Helfer --------------------------------------------------------------------

// weather_code als METAR-nahes Kürzel (dieselbe Tabelle wie im Briefing) --
// "NSW"/"N/A" (kein signifikantes Wetter) wird wie im echten METAR weggelassen.
function drawWeatherRow(ctx, grid, x, top, height) {
  const { times, surface } = grid;
  if (!surface?.wcode) return;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const cy = top + height / 2;
  let lastX = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const code = surface.wcode[i];
    if (!Number.isFinite(code)) continue;
    const label = metarWeather(code);
    if (label === "NSW" || label === "N/A") continue;
    const px = x(times[i]);
    if (px - lastX < 30) continue;
    ctx.fillStyle = weatherColor(label);
    ctx.fillText(label, px, cy);
    lastX = px;
  }
}
function weatherColor(label) {
  if (label.includes("TS")) return "#b71c1c";
  if (label.includes("SN") || label.includes("SG")) return "#1565c0";
  if (label.includes("FZ")) return "#6a1b9a";
  if (label.includes("FG")) return "#616161";
  return "#01579b";
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function mixHex(a, b, f) {
  const ca = hex(a), cb = hex(b), ff = clamp(f, 0, 1);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * ff);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * ff);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * ff);
  return `rgb(${r},${g},${bl})`;
}
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
