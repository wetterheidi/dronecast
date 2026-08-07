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
import { drawClouds, cbCells, drawCbShafts, drawCbAnvils } from "./texture.js";
import { hashSeed, hashRand } from "./noise.js";
import { drawWindRow, WIND_ROW_HEIGHT, drawWindBarbOverlay } from "./rows/wind.js";
import { drawNumberRow, NUMBER_ROW_HEIGHT } from "./rows/numberRow.js";
import { niceLogHeights, niceTicks, fmtH } from "../crosssection.js";
import { CHART_PX_PER_HOUR } from "../windbarb.js";
import { fmtHeight, fmtWind, fmtTemp, fmtDir } from "../units.js";
import { metarWeather } from "../briefing.js";
import * as fog from "./hazards/fog.js";

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

// Bodenstreifen unter dem Hauptpanel. GRAMET ist eine reine Punktprognose
// (ein Ort über die Zeit, nicht eine Route über den Raum) -- ein Geländeprofil
// wie im Cross-Section-Chart ergibt hier keinen Sinn, die Höhe des einen
// Punkts ändert sich ja nicht. Statt einer Silhouette also ein schmaler,
// horizontaler Streifen im ohnehin leeren GAP zwischen Hauptpanel und
// Zahlenzeilen -- reine Bodenkontakt-Anzeige, kein Höhenprofil, verdrängt
// darum auch keine echten Daten (s. Feedback).
const GROUND_H = 14;
// Folgt derselben Tag/Nacht-Kurve wie der Himmel (`view.daylight`), damit
// Boden und Himmel zur selben Stunde gemeinsam dunkeln/hellen. Deutlich
// dunkler als eine "natürliche" Erdfarbe gewählt (nicht nur ein anderer
// Farbton, sondern spürbar geringere Leuchtdichte als NIGHT_COLOR/DAY_COLOR)
// -- mit einer nur leicht dunkleren Erdfarbe verschwamm der Boden mit dem
// Himmel zu ähnlich heller Fläche, die Horizontlinie blieb die einzige
// Trennung (s. Feedback).
const GROUND_NIGHT = "#0a0603", GROUND_DAY = "#076f30";
// Zieht den Bodenton zusätzlich Richtung Reifweiß, wenn `surface.t2m` <= 0 °C
// ist -- keine neue Datenquelle nötig, das Feld liegt in `grid.surface`
// ohnehin schon für die T/Taupunkt-Zeile bereit. Für Drohnenpiloten ist eine
// Frostnacht am Startpunkt relevant, das Signal soll also sichtbar sein.
const GROUND_FROST = "#dfe6ea";

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
// Vereisungssymbol bewusst in Rot statt im Cb-Schwarz -- hebt sich von der
// grünen Kontur-Füllung (ICING_STYLES) ab und markiert die Fläche als
// Warnung, dieselbe Rotstufe wie TURB_STYLES.severe (konsistente Alarmfarbe).
const ICING_SYMBOL_INK = "#c62828";
// Turbulenzsymbol nur in "severe"-Flächen (stärkste Stufe, analog Vereisung)
// -- dieselbe Rotstufe wie TURB_STYLES.severe, kein eigener Warnton nötig.
const TURB_SYMBOL_INK = "#c62828";

// Isothermen (rot/blau, gestrichelt) und Isotachen (violett, Strich-Punkt)
// bewusst in unterschiedlichen Farbfamilien UND unterschiedlichem Strich-
// muster -- vorher beide gestrichelt und in ähnlich stumpfen Tönen (Rot vs.
// Oliv), auf dem Tag/Nacht-Verlauf kaum zu trennen (s. Feedback).
const ISOTACH_COLOR = "#7b2fbf";
const ISOTACH_DASH = [7, 3, 1, 3];

const ROW_DEFS = {
  wind: {
    height: WIND_ROW_HEIGHT, label: ["Wind", "10 m"],
    draw: (ctx, grid, view, x, top, h) => drawWindRow(ctx, grid, x, top, h),
  },
  tempdew: {
    height: NUMBER_ROW_HEIGHT, label: ["T /", "Taupunkt"],
    draw: (ctx, grid, view, x, top, h) => drawNumberRow(ctx, grid.times, x, top, h, [
      { values: grid.surface.t2m, fmt: (v) => fmtTemp(v), color: "#c0392b" },
      { values: grid.surface.td2m, fmt: (v) => fmtTemp(v), color: "#2980b9" },
    ]),
  },
  gust: {
    height: NUMBER_ROW_HEIGHT * 0.7, label: ["Böen", "10 m"],
    draw: (ctx, grid, view, x, top, h) => drawNumberRow(ctx, grid.times, x, top, h, [
      { values: grid.surface.gust, fmt: (v) => fmtWind(v), color: "#6a3d9a" },
    ]),
  },
  pressure: {
    height: NUMBER_ROW_HEIGHT * 0.7, label: ["SLP", "hPa"],
    draw: (ctx, grid, view, x, top, h) => drawNumberRow(ctx, grid.times, x, top, h, [
      { values: grid.surface.pmsl, fmt: (v) => String(Math.round(v)), color: "#1a6b4a" },
    ]),
  },
  weather: {
    height: NUMBER_ROW_HEIGHT * 0.55, label: ["Wetter", "(METAR)"],
    draw: (ctx, grid, view, x, top, h) => drawWeatherRow(ctx, grid, view, x, top, h),
  },
};

const DEFAULT_ROWS = ["wind", "gust", "tempdew", "pressure", "weather"];

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
  const mainH = Math.max(240, (host.clientHeight || 560) - TOPAX - GROUND_H - rowsH - GAP * 2 - BOT);

  const W = M.l + pw + M.r;
  const H = TOPAX + mainH + GROUND_H + GAP + rowsH + GAP + BOT;
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
  drawBackground(ctx, grid, view, x, y, mainTop, mainBot);
  // BR/HZ (kein cloudFrac-Signal, s. `drawFogHaze`) vor Wolken/Hazards/
  // Niederschlag, damit die auf dem Schleier noch klar lesbar bleiben statt
  // darin zu verschwimmen. FG dagegen ALS FLÄCHE (`drawFogBlock`, s. dort) --
  // die normale Ellipsentextur wirkt für Nebel zu "gefleckt"/wolkig, echter
  // Bodennebel ist optisch eintönig (s. Feedback) -- deshalb auch VOR den
  // Wolken, damit `drawClouds()` (s. u., mit maskierter cloudFrac) darin
  // nichts mehr zu zeichnen hat.
  drawFogHaze(ctx, grid, view, x, y, mainTop, mainBot);
  drawFogBlock(ctx, grid, view, x, y);
  // Zellzerlegung einmal ziehen: Schaft, Amboss und Symbol müssen auf demselben
  // Turm sitzen (s. `cbCells`).
  const cells = toggles.cb !== false ? cbCells(grid, view.cb, x, y) : [];
  if (toggles.cb !== false) drawCbShafts(ctx, cells, x, y);
  // FG-Zellen aus der Ellipsentextur ausblenden (s. `drawFogBlock`) -- sonst
  // säße die "Reiskorn"-Wolkentextur unter/über dem flachen Nebelblock.
  if (toggles.clouds !== false) drawClouds(ctx, grid, maskFog(grid, view.cloudFrac, view.fog), x, y);
  if (toggles.cb !== false) {
    drawCbAnvils(ctx, cells, x, y);
    drawCbGlyphs(ctx, cells);
  }
  const seed = hashSeed(`${grid.meta.lat},${grid.meta.lon},${grid.meta.elevation},${times[0]}`);
  if (toggles.precip !== false) drawPrecip(ctx, view.precip, times, x, y, seed);
  // Vereisung/Turbulenz bewusst ÜBER Wolken/Niederschlag: beides sind Gefahren-
  // hinweise, die auf der Wolke "aufsitzen" sollen, statt darunter zu verschwinden
  // -- die Kontur-Füllung ist transparent genug (s. `drawHazardArea`), dass die
  // Wolkentextur durchscheint.
  if (toggles.hazards !== false) {
    drawHazardArea(ctx, grid, view.hazards.icing, ICING_STYLES, x, y);
    drawIcingSevereGlyphs(ctx, grid, view.hazards.icing, x, y);
    drawHazardArea(ctx, grid, view.hazards.turbulence, TURB_STYLES, x, y);
    drawTurbulenceSevereGlyphs(ctx, grid, view.hazards.turbulence, x, y);
  }
  if (toggles.isotherms !== false) drawIsotherms(ctx, view.isotherms, x, y);
  if (toggles.isotachs !== false) drawIsotachs(ctx, view.isotachs, x, y);
  if (toggles.tropopause !== false) drawTropopause(ctx, view.tropopause, x, y);

  // Windfiedern: opt-in (Default aus, s. settings.js), weil sie die ohnehin
  // volle Hauptfläche (Wolken/Hazards/Niederschlag) zusätzlich belasten --
  // deshalb das dämpfende Fade darunter, statt jedem Fähnchen einen eigenen
  // Halo zu geben (Test auf Wunsch, s. Feedback).
  // nRows=14 statt der Cross-Section-Vorgabe (7): GRAMETs Hauptfläche ist
  // ohne die feste Panelhöhe der Cross-Section i. d. R. deutlich höher,
  // doppelte Zeilenzahl bleibt darin noch überlappungsfrei (s. Feedback).
  if (toggles.windbarbs) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillRect(x.left, mainTop, x.right - x.left, mainBot - mainTop);
    drawWindBarbOverlay(ctx, grid, x, y, { nRows: 14 });
  }

  ctx.strokeStyle = MUTED; ctx.lineWidth = 1;
  ctx.strokeRect(x.left + 0.5, mainTop + 0.5, pw - 1, mainH - 1);
  drawHeightAxis(ctx, y, zMin, zMax, x, lin);
  timeGridLines(ctx, times, x, mainTop, mainBot);
  drawGround(ctx, grid, view, x, mainBot, GROUND_H);

  let rowTop = mainBot + GROUND_H + GAP;
  for (const id of activeRows) {
    const def = ROW_DEFS[id];
    ctx.save();
    ctx.beginPath(); ctx.rect(x.left, rowTop, pw, def.height); ctx.clip();
    def.draw(ctx, grid, view, x, rowTop, def.height);
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
  setupHover(host, canvas, axis, grid, { x, y, mainTop, mainBot, view });
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

function drawBackground(ctx, grid, view, x, y, top, bot) {
  const { times } = grid;
  const span = x.right - x.left, h = bot - top;

  // Grundverlauf Tag/Nacht -- waagerecht, unverändert.
  const grad = ctx.createLinearGradient(x.left, 0, x.right, 0);
  let lastOff = -1;
  for (let i = 0; i < times.length; i++) {
    let off = clamp((x(times[i]) - x.left) / span, 0, 1);
    if (off <= lastOff) off = Math.min(1, lastOff + 1e-4);
    grad.addColorStop(off, mixHex(NIGHT_COLOR, DAY_COLOR, view.daylight[i]));
    lastOff = off;
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x.left, top, span, h);

  // Senkrechte Tiefe: Zenit dunkler als Horizont, multiplikativ statt additiv
  // aufgetragen -- bei Nacht ist der Grundton schon fast schwarz, ein
  // additiver dunkler Schleier hätte dort nichts mehr zu vertiefen (unten
  // bliebe er sichtbar grau) und bei Tag hätte er den ganzen Himmel gleich
  // stark eingetrübt statt nur oben. Multiplikativ skaliert die Vertiefung
  // stattdessen mit dem, was schon da ist.
  //
  // An der tatsächlichen HÖHE festgemacht (`y.inv`), nicht an der Panel-
  // Pixelposition -- sonst hätte dieselbe Höhe in "Gesamthöhe" und "bis
  // Flughöhe" unterschiedliche Farbe, weil dort jeweils etwas anderes an der
  // Panel-Oberkante steht (s. Feedback). Dafür reicht ein simpler 2-Stopp-
  // Gradient nicht: `y.inv` ist bei log-Achse nichtlinear in der Pixel-
  // koordinate, also wird die Kurve wie beim Tag/Nacht-Verlauf aus vielen
  // Stopps abgetastet -- hier gleichmäßig über die PIXEL (nicht über die
  // Höhe), damit die Auflösung unabhängig vom aktuellen Zoomfenster reicht.
  const depth = ctx.createLinearGradient(0, top, 0, bot);
  const DEPTH_STEPS = 40;
  for (let s = 0; s <= DEPTH_STEPS; s++) {
    const py = top + h * s / DEPTH_STEPS;
    const alpha = DEPTH_MAX_ALPHA * depthAt(y.inv(py));
    depth.addColorStop(s / DEPTH_STEPS, `rgba(2,6,16,${alpha})`);
  }
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = depth;
  ctx.fillRect(x.left, top, span, h);
  ctx.restore();
}

// Feste Referenzspanne für die Zenit-Verdunklung, bewusst UNABHÄNGIG von
// `grid.z`/`zMax` (s. Kommentar oben): 10 m (derselbe Bodenwert wie
// `hMinData` in `renderGramet`) bis 12000 m, grob Tropopausenniveau -- ab da
// ist der Himmel ohnehin schon fast im vollen Zenit-Ton, höher als in der
// Praxis gezeigt lohnt keine weitere Abstufung.
const DEPTH_REF_MIN = 10, DEPTH_REF_MAX = 12000;
const DEPTH_MAX_ALPHA = 0.55;
function depthAt(z) {
  return clamp((z - DEPTH_REF_MIN) / (DEPTH_REF_MAX - DEPTH_REF_MIN), 0, 1);
}

// --- Nebel/Dunst (BR/HZ) -------------------------------------------------------
//
// FG braucht hier nichts -- läuft komplett über `drawClouds()` (`cloudFrac`
// ist am Boden bereits hoch) plus das Label in der Wetter-Zeile. BR/HZ haben
// per Definition (s. `hazards/fog.js`) KEIN cloudFrac-Signal -- Luft ist
// nicht gesättigt -- und brauchen daher einen eigenen Schleier.
//
// Zwei UNABHÄNGIGE Verläufe (waagerecht: welche Stunde/welcher Typ+welche
// Stärke, senkrecht: wie nah am Boden) lassen sich nicht in einem einzigen
// Canvas-Gradient kombinieren. Deshalb der Offscreen-Umweg (gleiche Technik
// wie die Zenit-Tiefe oben, nur mit vertauschten Rollen): zuerst waagerecht
// Farbe+Stärke je Stunde aufmalen (wie der Tag/Nacht-Grundverlauf in
// `drawBackground`, nur mit BR-/HZ-Farbe statt Nacht/Tag), danach per
// `destination-in` mit der senkrechten Form maskieren (Boden voll, ab
// `HAZE_REF_MAX` nichts mehr) -- an der tatsächlichen HÖHE festgemacht wie
// `DEPTH_REF_MAX` oben, nicht an Panel-Pixeln, sonst hätte dieselbe Höhe bei
// "Gesamthöhe" und "bis Flughöhe" unterschiedlich viel Schleier.
const HAZE_REF_MIN = 10, HAZE_REF_MAX = 400; // m AGL -- Reichweite des Schleiers
// Kräftiger als im ersten Entwurf (0.5/gedämpfte Baseline) -- BR/HZ waren
// dort kaum vom normalen Himmel zu unterscheiden (s. Feedback).
const HAZE_MAX_ALPHA = 0.7;
const BR_COLOR = "225,235,238"; // weißlich -- BR ist feucht (Diesigkeit)
const HZ_COLOR = "196,155,74";  // ockerfarben -- HZ simuliert trockenen Staubdunst

/** Schleierfarbe+-stärke einer Stunde. Grenzen aus `hazards/fog.js`, damit
 *  Visual und Label deckungsgleich einsetzen. Baseline+Rampe statt reinem
 *  0..1-Verhältnis, damit "gerade eben BR/HZ" nicht schon fast unsichtbar
 *  ist -- rein optisch gewählt, nicht kalibriert. */
function hazeColorAlpha(entry, rh0) {
  if (!entry || !Number.isFinite(rh0)) return null;
  if (entry.type === "BR") {
    const t = clamp((rh0 - fog.BR_RH_MIN) / (100 - fog.BR_RH_MIN), 0, 1);
    return { color: BR_COLOR, alpha: HAZE_MAX_ALPHA * (0.65 + 0.35 * t) };
  }
  if (entry.type === "HZ") {
    const t = clamp((rh0 - fog.HZ_RH_MIN) / (fog.BR_RH_MIN - fog.HZ_RH_MIN), 0, 1);
    return { color: HZ_COLOR, alpha: HAZE_MAX_ALPHA * (0.45 + 0.4 * t) };
  }
  return null;
}

function drawFogHaze(ctx, grid, view, x, y, top, bot) {
  const { times, nk } = grid;
  const span = x.right - x.left, h = bot - top;
  if (span <= 0 || h <= 0 || !view.fog) return;

  // Waagerecht: Farbe+Stärke je Stunde, wie der Tag/Nacht-Grundverlauf.
  const colorGrad = ctx.createLinearGradient(x.left, 0, x.right, 0);
  let lastOff = -1, anyHaze = false;
  for (let i = 0; i < times.length; i++) {
    let off = clamp((x(times[i]) - x.left) / span, 0, 1);
    if (off <= lastOff) off = Math.min(1, lastOff + 1e-4);
    const ca = hazeColorAlpha(view.fog[i], grid.rh[i * nk]);
    if (ca) anyHaze = true;
    colorGrad.addColorStop(off, ca ? `rgba(${ca.color},${ca.alpha})` : "rgba(0,0,0,0)");
    lastOff = off;
  }
  if (!anyHaze) return; // nichts zu zeichnen -- Offscreen-Aufwand sparen

  const dpr = window.devicePixelRatio || 1;
  const offCanvas = document.createElement("canvas");
  offCanvas.width = Math.max(1, Math.round(span * dpr));
  offCanvas.height = Math.max(1, Math.round(h * dpr));
  const octx = offCanvas.getContext("2d");
  octx.scale(dpr, dpr);
  octx.translate(-x.left, -top);

  octx.fillStyle = colorGrad;
  octx.fillRect(x.left, top, span, h);

  // Senkrecht: Form als Maske, an der tatsächlichen Höhe festgemacht (s. o.).
  const shape = octx.createLinearGradient(0, top, 0, bot);
  const HAZE_SHAPE_STEPS = 24;
  for (let s = 0; s <= HAZE_SHAPE_STEPS; s++) {
    const py = top + h * s / HAZE_SHAPE_STEPS;
    const z = y.inv(py);
    const a = clamp(1 - (z - HAZE_REF_MIN) / (HAZE_REF_MAX - HAZE_REF_MIN), 0, 1);
    shape.addColorStop(s / HAZE_SHAPE_STEPS, `rgba(0,0,0,${a})`);
  }
  octx.globalCompositeOperation = "destination-in";
  octx.fillStyle = shape;
  octx.fillRect(x.left, top, span, h);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.drawImage(offCanvas, x.left, top, span, h);
  ctx.restore();
}

// --- Nebel (FG) als Fläche ------------------------------------------------------
//
// Echter Bodennebel ist optisch eintönig -- keine einzelnen Quellwolken,
// sondern eine gleichmäßig grau verhangene Schicht (s. Feedback: die normale
// Ellipsentextur von `drawClouds()` sah für Nebel zu "gefleckt"/wolkig aus).
// Deshalb eine eigene, FLACHE Fläche statt der Ellipsentechnik: `contour()`
// (marching squares, dieselbe Funktion wie für Isotachen/Hazard-Flächen)
// liefert eine glatte Umrisslinie um alle FG-Zellen, gefüllt mit einem
// einzigen Grauton statt Textur.
//
// Ersatz-Obergrenze, wenn die Klassifikation keine liefert (WW-Code-Fallback
// ohne RH/Kondensat-Top, s. hazards/fog.js): eine typische flache Nebelschicht,
// rein optisch gewählt, nicht kalibriert.
const FG_BLOCK_FALLBACK_M = 100;
const FOG_BLOCK_NIGHT = "#3a3d40", FOG_BLOCK_DAY = "#9aa0a6";
const FOG_BLOCK_ALPHA = 0.88;

/** FG-Obergrenze einer Stunde, mit Ersatzwert (s. o.). `null`, wenn die
 *  Stunde kein FG ist. */
function fgTopAt(entry) {
  if (!entry || entry.type !== "FG") return null;
  return entry.top ?? FG_BLOCK_FALLBACK_M;
}

/** 0/1-Feld (nt*nk): 1, wo eine Zelle innerhalb der FG-Schicht der jeweiligen
 *  Stunde liegt -- Grundlage sowohl für `drawFogBlock()` (Fläche) als auch
 *  für `maskFog()` (Ellipsentextur dort aussparen). */
function fgField(grid, fogCols) {
  const { nk, times } = grid;
  const field = new Float32Array(times.length * nk);
  let any = false;
  for (let i = 0; i < times.length; i++) {
    const topZ = fgTopAt(fogCols?.[i]);
    if (topZ == null) continue;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      if (grid.z[ix] <= topZ) { field[ix] = 1; any = true; }
    }
  }
  return any ? field : null;
}

/** `cloudFrac`, mit auf 0 gesetzten FG-Zellen -- für `drawClouds()`, damit
 *  dort keine Ellipsentextur unter/über dem flachen Nebelblock entsteht.
 *  `view.cloudFrac` selbst bleibt unverändert (Vereisung/Wolkenbasis/Hover-
 *  Tooltip sollen Nebel weiterhin als echte Wolke sehen -- physikalisch ist
 *  er das ja auch, nur die TEXTUR soll ihn nicht mehr zeichnen). */
function maskFog(grid, cloudFrac, fogCols) {
  const field = fgField(grid, fogCols);
  if (!field) return cloudFrac;
  const out = Float32Array.from(cloudFrac);
  for (let ix = 0; ix < out.length; ix++) if (field[ix]) out[ix] = 0;
  return out;
}

function drawFogBlock(ctx, grid, view, x, y) {
  const field = fgField(grid, view.fog);
  if (!field) return;

  // Farbverlauf wie der Himmel/Boden: bei Tag heller/durchscheinender Nebel,
  // bei Nacht dunkler -- dieselbe Stopptechnik wie `drawBackground`.
  const grad = ctx.createLinearGradient(x.left, 0, x.right, 0);
  const span = x.right - x.left;
  let lastOff = -1;
  for (let i = 0; i < grid.times.length; i++) {
    let off = clamp((x(grid.times[i]) - x.left) / span, 0, 1);
    if (off <= lastOff) off = Math.min(1, lastOff + 1e-4);
    grad.addColorStop(off, mixHex(FOG_BLOCK_NIGHT, FOG_BLOCK_DAY, view.daylight[i]));
    lastOff = off;
  }

  const polylines = contour(grid, field, 0.5);
  ctx.save();
  ctx.globalAlpha = FOG_BLOCK_ALPHA;
  ctx.fillStyle = grad;
  for (const pl of polylines) {
    if (pl.length < 2) continue;
    ctx.beginPath();
    pl.forEach((p, idx) => {
      const px = x(p.t), py = y(p.z);
      if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// --- Boden ---------------------------------------------------------------------

// Schmaler Streifen direkt unter dem Hauptpanel, s. Kommentar an `GROUND_H`.
// Gleiche Verlaufstechnik wie `drawBackground` (ein Farbstopp je Zeitschritt),
// zusätzlich pro Stopp Richtung `GROUND_FROST` gezogen, wenn die Bodentemperatur
// an oder unter dem Gefrierpunkt liegt -- linear ausgereizt bis -5 °C, damit ein
// Streifen mit nur -0.5 °C nicht schon voll bereift wirkt.
const GROUND_FROST_SPAN = 5;
function drawGround(ctx, grid, view, x, top, h) {
  const { times, surface } = grid;
  const span = x.right - x.left;
  const grad = ctx.createLinearGradient(x.left, 0, x.right, 0);
  let lastOff = -1;
  for (let i = 0; i < times.length; i++) {
    let off = clamp((x(times[i]) - x.left) / span, 0, 1);
    if (off <= lastOff) off = Math.min(1, lastOff + 1e-4);
    const dayNight = blend3(GROUND_NIGHT, GROUND_DAY, view.daylight[i]);
    const t2m = surface?.t2m?.[i];
    const frostT = Number.isFinite(t2m) ? clamp(-t2m / GROUND_FROST_SPAN, 0, 1) : 0;
    grad.addColorStop(off, rgbStr(blendRGB(dayNight, hex(GROUND_FROST), frostT)));
    lastOff = off;
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x.left, top, span, h);

  // Horizontlinie: dunkler Kontaktschatten, wo der Himmel auf den Boden trifft.
  ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x.left, top + 0.5); ctx.lineTo(x.right, top + 0.5); ctx.stroke();
}

// --- Hazard-Flächen (Vereisung berechnet, s. hazards/icing.js; Turbulenz noch
// Stub -> zeichnet nichts) -----------------------------------------------------

// Kontur-Umriss statt Zellraster: reicht die Schweregrad-Zeichenkette (none/
// light/moderate/severe) als Zahlenfeld an `contour()` (marching squares,
// dieselbe Funktion wie für die Isotachen) durch und zeichnet je Schwelle
// eine gestrichelt umrandete, leicht gefüllte Fläche -- wie im Referenz-
// Screenshot (gelb umrandete Fläche um den Amboss), nicht als Pixelraster.
// `contour()` polstert das Gitter am Rand (s. dort), damit Flächen, die eine
// Gitterkante durchgehend erfüllen (z. B. Turbulenz schon zur ersten Stunde
// oder am untersten Level), als geschlossene Polylinie zurückkommen, statt
// dass `closePath()` sie mit einer geraden Linie quer durchs Bild schließt.
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

// --- Vereisung: Symbol in "severe"-Flächen -----------------------------------

// Eigenes Konturfeld nur für "severe" (Schwellen s. hazards/icing.js): ein
// Symbol je zusammenhängender Fläche, an deren (Polylinien-)Schwerpunkt --
// analog zum Cb-Symbol (ein Symbol je Fläche/Zelle statt Textur-Streusaat),
// mit demselben Mindestabstand `GLYPH_MIN_GAP` gegen Überlappung bei
// mehreren knapp benachbarten Flächen.
function drawIcingSevereGlyphs(ctx, grid, hazardArr, x, y) {
  const n = grid.times.length * grid.nk;
  const field = new Float32Array(n);
  for (let ix = 0; ix < n; ix++) field[ix] = hazardArr[ix] === "severe" ? 1 : 0;
  const polylines = contour(grid, field, 0.5);
  const size = 20;
  const centers = polylines
    .filter((pl) => pl.length >= 2)
    .map((pl) => ({
      cx: pl.reduce((s, p) => s + x(p.t), 0) / pl.length,
      cy: pl.reduce((s, p) => s + y(p.z), 0) / pl.length,
    }))
    .sort((a, b) => a.cx - b.cx);

  let lastX = -Infinity;
  for (const c of centers) {
    if (c.cx - lastX < size * GLYPH_MIN_GAP) continue;
    strokeSymbol(ctx, icingSeverePath(c.cx, c.cy, size), size, ICING_SYMBOL_INK);
    lastX = c.cx;
  }
}

/**
 * Starke Vereisung (Severe Icing). Kartensymbol: Ein weiter Bogen (U-Form),
 * der von zwei parallelen, vertikalen Linien geschnitten wird.
 */
function icingSeverePath(cx, cy, size) {
  const p = new Path2D();
  const w = size * 0.35;
  const curveTopY = cy - size * 0.25;

  // U-förmiger Bogen (mittels quadratischer Bezier-Kurve)
  p.moveTo(cx - w, curveTopY);
  // Kontrollpunkt liegt tiefer, um den schönen runden Bauch zu erzeugen
  p.quadraticCurveTo(cx, cy + size * 0.6, cx + w, curveTopY);

  // Parameter für die beiden vertikalen Linien
  const lineOffset = size * 0.08;
  const lineTopY = cy - size * 0.05;
  const lineBottomY = cy + size * 0.45;

  // Linke vertikale Linie
  p.moveTo(cx - lineOffset, lineTopY);
  p.lineTo(cx - lineOffset, lineBottomY);

  // Rechte vertikale Linie
  p.moveTo(cx + lineOffset, lineTopY);
  p.lineTo(cx + lineOffset, lineBottomY);

  return p;
}

// --- Turbulenz: Symbol in "severe"-Flächen -----------------------------------

// Wie `drawIcingSevereGlyphs` -- ein Symbol je zusammenhängender "severe"-
// Fläche (stärkste TFI-Kategorie) an deren Schwerpunkt, gleicher
// Mindestabstand. Leichtere Kategorien (light/moderate) bleiben reine
// Kontur-Farbfläche ohne Symbol, wie bei Vereisung.
function drawTurbulenceSevereGlyphs(ctx, grid, hazardArr, x, y) {
  const n = grid.times.length * grid.nk;
  const field = new Float32Array(n);
  for (let ix = 0; ix < n; ix++) field[ix] = hazardArr[ix] === "severe" ? 1 : 0;
  const polylines = contour(grid, field, 0.5);
  const size = 20;
  const centers = polylines
    .filter((pl) => pl.length >= 2)
    .map((pl) => ({
      cx: pl.reduce((s, p) => s + x(p.t), 0) / pl.length,
      cy: pl.reduce((s, p) => s + y(p.z), 0) / pl.length,
    }))
    .sort((a, b) => a.cx - b.cx);

  let lastX = -Infinity;
  for (const c of centers) {
    if (c.cx - lastX < size * GLYPH_MIN_GAP) continue;
    strokeSymbol(ctx, turbulenceModeratePath(c.cx, c.cy, size), size, TURB_SYMBOL_INK);
    lastX = c.cx;
  }
}

/**
 * Mäßige Turbulenz (Moderate Turbulence), Standard-ICAO-SIGWX-Symbol.
 * Kartensymbol: Waagerechte Linie, die in der Mitte spitz nach oben verläuft
 * (Dach- bzw. Zacken-Form). Hier auf die stärkste TFI-Kategorie ("severe")
 * angewendet -- dasselbe Verfahren wie bei Vereisung, wo ebenfalls nur die
 * höchste Stufe ein Symbol bekommt, kein eigenes Glyph je Zwischenstufe.
 */
function turbulenceModeratePath(cx, cy, size) {
  const p = new Path2D();
  const w = size * 0.4;
  const baseY = cy + size * 0.2;
  const peakY = cy - size * 0.3;
  const peakHalfWidth = size * 0.15;

  // Durchgehender Linienzug von links nach rechts
  p.moveTo(cx - w, baseY);              // Startpunkt ganz links
  p.lineTo(cx - peakHalfWidth, baseY);  // Bis zum linken Fuß der Spitze
  p.lineTo(cx, peakY);                  // Hinauf zur Spitze (Apex)
  p.lineTo(cx + peakHalfWidth, baseY);  // Hinab zum rechten Fuß
  p.lineTo(cx + w, baseY);              // Endpunkt ganz rechts

  return p;
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
// Ein Symbol je Zelle, nicht mehr je Stunde: seit `cbCells` die Läufe in
// einzelne Türme zerlegt, ist die Zelle die zeichnerische Einheit, und die
// Symbole verteilen sich mit den Türmen von selbst. Der Mindestabstand darunter
// ist nur noch die Rückfallebene für sehr schmale Stunden (langer
// Vorhersagezeitraum), wo die Türme selbst schon fast aneinanderstoßen.
const GLYPH_MIN_GAP = 1.4; // Vielfaches der Symbolgröße zwischen zwei Mitten

function drawCbGlyphs(ctx, cells) {
  let lastX = -Infinity;
  for (const c of cells) {
    // Größer als der alte Glyph: die Kartensymbole sind reine Strichzeichnung,
    // unter ~22 px läuft der Halo in die Binnenform und der Umriss verklumpt.
    const size = Math.min(24, c.hw * 1.9);
    if (c.cx - lastX < size * GLYPH_MIN_GAP) continue;
    const cy = c.yTop + (c.yBot - c.yTop) * 0.45;
    strokeSymbol(ctx, c.kind === "cb" ? cl9Path(c.cx, cy, size) : cl3Path(c.cx, cy, size), size);
    lastX = c.cx;
  }
}

/**
 * C_L 9 — Cumulonimbus mit Amboss. Kartensymbol: Große Quellwolkenkuppel
 * auf flacher Basis, darüber ein waagerechter Ambossdeckel, dessen schräge 
 * Flanken direkt auf die Kuppel treffen (siehe image_e7b248.png).
 */
function cl9Path(cx, cy, size) {
  const R = size * 0.42;
  const baseY = cy + R * 0.5;
  const p = new Path2D();

  // Basis mit großer Kuppel (durchgehender Halbkreis)
  p.moveTo(cx - R, baseY);
  p.arc(cx, baseY, R, Math.PI, 0);
  p.lineTo(cx - R, baseY);

  // Amboss (umgedrehtes Trapez auf der Kuppel)
  const topW = R * 0.7;
  const topY = cy - R * 0.9;
  
  // Berührungspunkte der schrägen Ambossflanken auf der Kuppel
  const touchX = R * 0.48;
  const touchY = baseY - Math.sqrt(R * R - touchX * touchX);

  // Deckel und rechte Flanke zeichnen
  p.moveTo(cx - topW, topY);
  p.lineTo(cx + topW, topY);
  p.lineTo(cx + touchX, touchY);
  
  // Linke Flanke zeichnen
  p.moveTo(cx - topW, topY);
  p.lineTo(cx - touchX, touchY);

  return p;
}

/**
 * C_L 3 — Cumulonimbus calvus. Kartensymbol: Große Quellwolkenkuppel
 * auf flacher Basis. Darauf sitzt eine kleinere Kuppel, die durch eine
 * vertikale Linie vom Scheitel der großen bis zum Scheitel der kleinen
 * Kuppel halbiert wird (siehe image_e7aa63.png).
 */
function cl3Path(cx, cy, size) {
  const R = size * 0.42;
  const baseY = cy + R * 0.5;
  const p = new Path2D();

  // Große Basis-Kuppel
  p.moveTo(cx - R, baseY);
  p.arc(cx, baseY, R, Math.PI, 0);
  p.lineTo(cx - R, baseY);

  // Kleine Kuppel on top
  const r2 = R * 0.35; // Radius der aufgesetzten kleinen Kuppel
  
  // Die y-Koordinate, an der die Eckpunkte der kleinen Kuppel den großen Bogen berühren
  const smallCenterY = baseY - Math.sqrt(R * R - r2 * r2);

  // Bogen der kleinen Kuppel
  p.moveTo(cx - r2, smallCenterY);
  p.arc(cx, smallCenterY, r2, Math.PI, 0);

  // Vertikale Linie (Mast) exakt zwischen den beiden Scheitelpunkten
  const largeApexY = baseY - R;
  const smallApexY = smallCenterY - r2;

  p.moveTo(cx, largeApexY);
  p.lineTo(cx, smallApexY);

  return p;
}

// Zweimal stroken: erst breit in Weiß (Halo), dann schmal in Schwarz. Auf der
// gefleckten Schaft- bzw. Wolkentextur ist der Strich sonst kaum auszumachen.
// Der Halo wächst ADDITIV mit der Strichstärke, nicht proportional zur Größe:
// proportional (0.24*size) fraß er bei kleinen Symbolen die Binnenform auf --
// die Sanduhrtaille lief zu, die Kuppel wurde ein weißer Klecks.
function strokeSymbol(ctx, path, size, inkColor = CB_SYMBOL_INK) {
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const ink = Math.max(1.2, size * 0.075);
  ctx.strokeStyle = CB_SYMBOL_HALO; ctx.lineWidth = ink + 2.2;
  ctx.stroke(path);
  ctx.strokeStyle = inkColor; ctx.lineWidth = ink;
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

// Zeitliche Verschiebung des Vorhangs, als Anteil der Stundenspalte nach LINKS.
// Open-Meteo gibt `precipitation` als Summe der VORANGEHENDEN Stunde aus: der
// Wert am Zeitstempel t beschreibt t-1h..t. Am Zeitstempel gezeichnet stand der
// Vorhang also am rechten Rand seines Bezugszeitraums; 0,5 setzt ihn auf dessen
// Mitte. Bewusst als Stellschraube herausgezogen -- 0 stellt das alte Verhalten
// wieder her.
// Vorbehalt: `weather_code` gilt momentan (nicht rückwärts akkumuliert), und
// Vorhänge, die nur daraus stammen (Menge unter der Schwelle, s.
// `precipEntries`), werden hier trotzdem mitverschoben -- eine getrennte
// Behandlung würde die Vorhänge benachbarter Stunden ungleich verteilen.
const PRECIP_TIME_SHIFT = 0.5;

function drawPrecip(ctx, entries, times, x, y, seed) {
  const dt = times.length > 1 ? times[1] - times[0] : 3600;
  const colW = Math.max(1, x(times[0] + dt) - x(times[0]));
  ctx.save();
  for (const e of entries) {
    // Auf den Rahmen begrenzen: die erste Stunde rutscht sonst mit ihrem
    // halben Versatz links aus dem Chart in die Höhenachse.
    const cx = clamp(x(e.t - PRECIP_TIME_SHIFT * dt), x.left, x.right);
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
      // Oberhalb der Nullgradgrenze immer Schnee (physikalisch, unabhängig
      // vom Boden-METAR), darunter immer Regen -- `type` entscheidet nur,
      // wenn keine Nullgradgrenze im Profil gefunden wurde (s. Feedback:
      // "sn" durfte den ganzen Vorhang bis zum Boden einfärben, auch weit
      // unterhalb der Nullgradgrenze).
      const snowHere = Number.isFinite(e.freezingZ) ? z > e.freezingZ : e.type === "sn";
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

function drawPolyline(ctx, pl, x, y, color, dash, width = 1.4) {
  if (pl.length < 2) return;
  ctx.save();
  ctx.setLineDash(dash);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#fff"; ctx.lineWidth = width + 1.6;
  pathFor(ctx, pl, x, y); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = width;
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
    for (const pl of polylines) drawPolyline(ctx, pl, x, y, ISOTACH_COLOR, ISOTACH_DASH, 1.7);
    const last = rightmost(polylines);
    const p = last[last.length - 1];
    labelBox(ctx, x(p.t), y(p.z), `${kt} kt`, ISOTACH_COLOR, x.right + M.r);
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
  const { x, y, mainTop, mainBot, view } = info;
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
    // WW gilt für den Boden (weather_code ist ein Oberflächenfeld), nicht für
    // die gehoverte Höhe -- daher explizit gekennzeichnet.
    const code = grid.surface?.wcode?.[i];
    const ww = Number.isFinite(code)
      ? `${metarWeather(code, fog.toPhenomenon(view.fog?.[i]))} (ww ${String(code).padStart(2, "0")})`
      : "N/A";
    // Menge ebenfalls Boden und zusätzlich rückwärtsgewandt: Open-Meteo gibt
    // `precipitation` als Summe der VORANGEHENDEN Stunde aus, während ww zum
    // Zeitstempel gilt. Beides nebeneinander, damit beim Kalibrieren sichtbar
    // wird, welches der beiden Signale den Vorhang ausgelöst hat (das Gate in
    // `precipEntries` ist ein ODER aus Menge > PRECIP_MIN_RATE und ww).
    // Zwei Nachkommastellen, weil die Schwelle bei 0,05 mm/h liegt.
    const mm = grid.surface?.precip?.[i];
    const cm = grid.surface?.snow?.[i];
    const num = (v, d = 2) => v.toLocaleString("de-DE", { maximumFractionDigits: d });
    const amount = Number.isFinite(mm) ? `${num(mm)} mm` : "N/A";
    const snow = Number.isFinite(cm) && cm > 0 ? ` · Schnee ${num(cm, 1)} cm` : "";
    tip.style.display = "block";
    tip.style.left = `${px + 12}px`;
    tip.style.top = `${py + 12}px`;
    tip.innerHTML = [
      `<b>${new Date(grid.times[i] * 1000).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" })}</b>`,
      `Höhe ${fmtHeight(h)}`,
      `Temp ${fmtTemp(s.T - 273.15)}`,
      `Wind ${fmtDir(dir)} ${fmtWind(Math.hypot(s.u, s.v))}`,
      `Wolken ${Math.round((s.cloudFrac || 0) * 100)} %`,
      `WW (Boden) ${ww}`,
      `Nd (Vorstunde) ${amount}${snow}`,
    ].join("<br>");
  });
  canvas.addEventListener("pointerleave", () => { tip.style.display = "none"; });
}

// --- Helfer --------------------------------------------------------------------

// weather_code als METAR-nahes Kürzel (dieselbe Tabelle wie im Briefing) --
// "NSW"/"N/A" (kein signifikantes Wetter) wird wie im echten METAR weggelassen.
function drawWeatherRow(ctx, grid, view, x, top, height) {
  const { times, surface } = grid;
  if (!surface?.wcode) return;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const cy = top + height / 2;
  let lastX = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const code = surface.wcode[i];
    if (!Number.isFinite(code)) continue;
    const entry = view?.fog?.[i];
    const label = metarWeather(code, fog.toPhenomenon(entry));
    if (label === "NSW" || label === "N/A") continue;
    const px = x(times[i]);
    if (px - lastX < 30) continue;
    // Unsichere Befunde (RH-Fallback statt CLC/Kondensat, s. hazards/fog.js)
    // gedämpft statt in der vollen Warnfarbe -- Konfidenz-Konvention wie bei
    // der Wolkenbasislinie im Meteogramm (dort gestrichelt statt Farbe, hier
    // reicht Alpha, weil Text keine Linienart hat).
    ctx.globalAlpha = entry && entry.certain === false ? 0.55 : 1;
    ctx.fillStyle = weatherColor(label);
    ctx.fillText(label, px, cy);
    ctx.globalAlpha = 1;
    lastX = px;
  }
}
function weatherColor(label) {
  if (label.includes("TS")) return "#b71c1c";
  if (label.includes("SN") || label.includes("SG")) return "#1565c0";
  if (label.includes("FZ")) return "#6a1b9a";
  if (label === "FG") return "#616161";
  if (label === "BR") return "#78909c";
  if (label === "HZ") return "#8d6e63";
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
// RGB-Varianten von `mixHex`/`hex`, für den Bodenstreifen: dort wird in zwei
// Schritten gemischt (Tag/Nacht, dann Richtung Reif), `mixHex` nimmt aber nur
// Hex-Strings entgegen und liefert bereits einen "rgb(...)"-String zurück --
// den könnte man kein zweites Mal durch `hex()` parsen.
function blendRGB(a, b, f) {
  const ff = clamp(f, 0, 1);
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * ff));
}
function blend3(hexA, hexB, f) { return blendRGB(hex(hexA), hex(hexB), f); }
function rgbStr(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
