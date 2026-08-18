/**
 * Meteogramm für den Operationsraum als gestapelte Panels mit gemeinsamer
 * Zeitachse. Reines SVG, ohne Abhängigkeiten. Drohnen-Anpassung: das
 * Wind-Panel zeigt den Mittelwind auf der Operations-Obergrenze aus Michaels
 * Modell-Leveln (nicht nur 10 m), Böen als Warnlinie darüber.
 *
 * Erwartetes Modell (alles rohe SI-Werte, Formatierung via units.js):
 *   { time: number[] (unix s), nights: [{sunrise,sunset}],
 *     vars: { temperature_2m, dew_point_2m, relative_humidity_2m,
 *             precipitation, weather_code, cloud_cover_low/mid/high,
 *             wind_gusts_10m (km/h), visibility (m) },
 *     units: {},
 *     lowestLayer?: ({baseM, cover, cf}|null)[],  // unterste Wolkenschicht je
 *       Stunde (aus clouds.js `cloudLayers`, erste Schicht — `cover` ist die
 *       Okta-Kategorie FEW/SCT/BKN/OVC), verfeinert die LCL-Schätzung der
 *       Wolkenbasis — optional, fehlt z. B. wenn die Säule (noch) nicht
 *       geladen ist (dann reine LCL-Schätzung).
 *     fog?: ({type:"FG"|"BR"|"HZ", certain, freezing}|null|undefined)[] }  // sicht-
 *       basierte Nebel/Dunst-Diagnose je Stunde (clouds.js `classifyFog`,
 *       dieselbe Priorität wie GRAMETs `hazards/fog.js` `classifyColumn`) —
 *       optional, ERSETZT die reine `weather_code`-Nebelerkennung im
 *       Bewölkungs-Panel (vorher ODER-verknüpft, konnte GRAMET widersprechen,
 *       s. Feedback). `undefined` je Stunde markiert, dass die Säule dort
 *       real endet (z. B. ICON Global: Modell-Level nur bis +36 h) — dort
 *       bleibt roher `weather_code` die Nebelquelle, wie wenn `fog` ganz fehlt.
 * Wind wird aus den 10-m-Bodenfeldern gezeichnet (Höhenwinde -> Cross-Section).
 */

import {
  heightToDisplay, heightUnit,
  windToDisplay, windUnit, tempToDisplay, tempUnit,
  fmtHeight, fmtWind, fmtDir, fmtTemp,
} from "meteokit/units";
import { refineCloudBase } from "meteokit/clouds";
import { placeWindBarb, CHART_PX_PER_HOUR, CHART_BARB_SIZE } from "meteokit/windbarb";

const KT_PER_MS = 1.94384;

const NS = "http://www.w3.org/2000/svg";
const INK = "#0b0b0b";
const MUTED = "#52514e";
const GRID = "#e8e7e3";
const NIGHT = "rgba(60,66,82,0.15)";

const COL = {
  temp: "#e34948", dew: "#2a78d6", rh: "#2a78d6",
  windMean: "#2a78d6", windFill: "rgba(42,120,214,0.22)", gust: "#e34948",
  base: "#6b5f45", vis: "#eda100",
  cloudLow: "rgba(70,74,82,0.55)", cloudMid: "rgba(120,124,132,0.45)", cloudHigh: "rgba(175,178,185,0.40)",
  fog: "rgba(237,161,0,0.55)",
};

const PANEL_H = 108;
const GAP = 6;
const TOPAXIS = 26;
const M = { l: 48, r: 46 };

export function renderMeteogram(host, model) {
  host.innerHTML = "";
  const time = model.time || [];
  if (time.length < 2) { host.textContent = "Keine Zeitreihe."; return; }

  // Panelbreite: fester Pixelabstand pro Stunde (Windfiedern brauchen dafür
  // genug Platz, siehe drawWind), Containerbreite nur als UNTERGRENZE für
  // kurze Horizonte. Bei langen Horizonten wächst die Breite entsprechend
  // mit — #mg-body hat overflow:auto, das Panel scrollt dann horizontal statt
  // die Fiedern bis zur Unlesbarkeit zusammenzuquetschen.
  const hours = Math.max(1, (time[time.length - 1] - time[0]) / 3600);
  const containerPw = Math.max(host.clientWidth || 0, 340) - M.l - M.r;
  const pw = Math.max(hours * CHART_PX_PER_HOUR, containerPw);
  const W = pw + M.l + M.r;
  const t0 = time[0], t1 = time[time.length - 1];
  const x = (t) => M.l + ((t - t0) / (t1 - t0)) * pw;
  x.right = M.l + pw; // rechte Plotkante (für Rahmen/Achsen)

  // Panels mit eigenen Höhen (Mond/Wetter-Leisten dünn, Rest voll).
  const panels = [
    { draw: drawMoonRow, h: 42 },
    { draw: drawWeatherRibbon, h: 34 },
    { draw: drawTemp, h: PANEL_H },
    { draw: drawPrecip, h: PANEL_H },
    { draw: drawWind, h: PANEL_H },
    { draw: drawCloud, h: PANEL_H },
    { draw: drawBaseVis, h: PANEL_H },
  ];
  const H = TOPAXIS + panels.reduce((s, p) => s + p.h, 0) + (panels.length - 1) * GAP + 4;

  const svg = mk("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "mg-svg" });
  const stackTop = TOPAXIS;
  const stackBot = H - 4;

  // Nachtschattierung über den gesamten Panel-Stapel.
  for (const iv of nightIntervals(model.nights, t0, t1)) {
    svg.append(mk("rect", {
      x: x(iv.a), y: stackTop, width: Math.max(0, x(iv.b) - x(iv.a)), height: stackBot - stackTop,
      fill: NIGHT,
    }));
  }
  // Tagestrenner + Datum, Stundenmarken (06/12/18) oben; Zeitzonen-Hinweis Eck oben links.
  svg.append(txt(2, 10, "loc", MUTED, 9, "start"));
  drawTimeAxis(svg, time, x, stackTop, stackBot);

  let yTop = TOPAXIS;
  const bounds = [];
  for (const p of panels) {
    const g = mk("g", {});
    p.draw(g, model, x, yTop, yTop + p.h, pw);
    svg.append(g);
    bounds.push([yTop, yTop + p.h]);
    yTop += p.h + GAP;
  }

  host.append(svg);
  setupHover(svg, model, { x, time, W, H, bounds, stackTop, stackBot });
}

// --- Hover-Ablesung --------------------------------------------------------

// Fadenkreuz wie in der Cross-Section: Zeit gerastet (stündlich), senkrechte
// Linie über den ganzen Stapel, waagerechte im überfahrenen Panel, Tooltip
// mit allen Werten der Stunde (Formatierung in Anzeigeeinheiten).
function setupHover(svg, m, ctx) {
  const { x, time, W, H, bounds, stackTop, stackBot } = ctx;
  const t0 = time[0], t1 = time[time.length - 1], dt = time[1] - time[0], T = time.length;
  const ov = mk("g", { "pointer-events": "none" });
  svg.append(ov);
  const clearOv = () => { while (ov.firstChild) ov.removeChild(ov.firstChild); };

  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width);
    const py = (e.clientY - r.top) * (H / r.height);
    if (px < M.l || px > x.right || py < stackTop || py > stackBot) { clearOv(); return; }

    const i = clamp(Math.round(((px - M.l) / (x.right - M.l)) * (t1 - t0) / dt), 0, T - 1);
    const sx = x(time[i]);
    clearOv();
    ov.append(mk("line", { x1: sx, y1: stackTop, x2: sx, y2: stackBot, stroke: INK, "stroke-width": 0.8, opacity: 0.55 }));
    const panel = bounds.find(([a, b]) => py >= a && py <= b);
    if (panel) {
      ov.append(mk("line", { x1: M.l, y1: py, x2: x.right, y2: py, stroke: INK, "stroke-width": 0.8, opacity: 0.55 }));
      ov.append(mk("circle", { cx: sx, cy: py, r: 3.2, fill: "none", stroke: "#fff", "stroke-width": 2.4 }));
      ov.append(mk("circle", { cx: sx, cy: py, r: 3.2, fill: "none", stroke: INK, "stroke-width": 1.3 }));
    }

    const V = m.vars;
    const F = (v, fn) => (Number.isFinite(v) ? fn(v) : "–");
    const pct = (v) => F(v, (p) => `${Math.round(p)} %`);
    const spd = Number.isFinite(V.wind_speed_10m[i]) ? V.wind_speed_10m[i] / 3.6 : NaN;
    const gust = Number.isFinite(V.wind_gusts_10m[i]) ? V.wind_gusts_10m[i] / 3.6 : NaN;
    const base = refineCloudBase(V.temperature_2m[i], V.dew_point_2m[i], V.cloud_cover_low[i],
      m.lowestLayer ? m.lowestLayer[i] : null);
    const lines = [
      new Date(time[i] * 1000).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" }),
      `Temp ${F(V.temperature_2m[i], fmtTemp)} · Td ${F(V.dew_point_2m[i], fmtTemp)}`,
      `Feuchte ${pct(V.relative_humidity_2m[i])} · Nied. ${F(V.precipitation[i], (p) => `${p < 1 ? p.toFixed(2) : p.toFixed(1)} mm/h`)}`,
      `Wind ${F(V.wind_direction_10m[i], fmtDir)} ${F(spd, fmtWind)} Böen ${F(gust, fmtWind)}`,
      `Wolken t ${pct(V.cloud_cover_low[i])} · m ${pct(V.cloud_cover_mid[i])} · h ${pct(V.cloud_cover_high[i])}`,
      `Basis ${base ? fmtHeight(base.baseM) : "–"} · Sicht ${F(V.visibility[i], (v) => `${(v / 1000).toFixed(1)} km`)}`,
    ];
    const ww = fogWwCat(m.fog, i, V.weather_code[i]);
    if (ww) {
      const fog = m.fog ? m.fog[i] : null;
      lines.splice(1, 0, `Wetter: ${ww.label}${ww.key === "fog" && fog?.freezing ? " (gefrierend)" : ""}`);
    }
    drawTip(ov, px, py, lines, W, H);
  });
  svg.addEventListener("pointerleave", clearOv);
}

function drawTip(ov, px, py, lines, W, H) {
  const pad = 7, lh = 15, w = 212, h = pad * 2 + lines.length * lh;
  let tx = px + 14, ty = py + 14;
  if (tx + w > W) tx = px - 14 - w;
  if (ty + h > H) ty = py - 14 - h;
  ov.append(mk("rect", { x: tx, y: ty, width: w, height: h, rx: 5, fill: "rgba(252,252,251,0.97)", stroke: "#c9c8c2", "stroke-width": 1 }));
  lines.forEach((ln, j) => {
    ov.append(txt(tx + pad, ty + pad + lh * (j + 1) - 4, ln, j === 0 ? INK : MUTED, 11, "start", j === 0 ? 700 : 400));
  });
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// --- Panels ----------------------------------------------------------------

// Mond: Auf-/Untergangspfeile mit Mondscheibe in aktueller Phase.
function drawMoonRow(g, m, x, yTop, yBot) {
  frame(g, yTop, yBot, x, "Mond");
  if (!m.moon || !m.moon.events.length) return;
  const cy = yTop + 22;
  for (const ev of m.moon.events) {
    const px = x(ev.t / 1000); // Ereigniszeit in ms -> Achse rechnet in s
    vArrow(g, px - 7, cy, ev.type === "rise" ? -1 : 1);
    moonGlyph(g, px + 3, cy - 1, 6, ev.illum, ev.waxing);
    g.append(txt(px, yBot - 4, hhmm(ev.t), MUTED, 9, "middle"));
  }
}

// Signifikantes Wetter (WMO ww) pro Stunde als farbige Zellen — auch für
// Erscheinungen ohne Niederschlagsmenge (Nebel, Gewitter). Nebel: sichtbasierte
// Diagnose aus der Säule (m.fog, clouds.js `classifyFog`, s. `fogWwCat`) statt
// des rohen weather_code — dieselbe Priorität wie GRAMET, damit sich beide
// Ansichten nicht widersprechen (s. Feedback).
function drawWeatherRibbon(g, m, x, yTop, yBot) {
  const WC = m.vars.weather_code;
  frame(g, yTop, yBot, x, "Wetter (ww)");
  const cellW = Math.max(1.5, (x(m.time[1]) - x(m.time[0])) * 0.95);
  const cy0 = yTop + 16, ch = yBot - cy0 - 3;
  const present = new Set();
  m.time.forEach((t, i) => {
    const cat = fogWwCat(m.fog, i, WC[i]);
    if (!cat) return;
    present.add(cat.key);
    g.append(mk("rect", { x: x(t) - cellW / 2, y: cy0, width: cellW, height: ch, fill: cat.color }));
  });
  const items = WW_TYPES.filter((t) => present.has(t.key)).map((t) => [t.label, t.color]);
  if (items.length) legend(g, M.l + 78, yTop + 12, items);
}

function drawTemp(g, m, x, yTop, yBot) {
  const T = m.vars.temperature_2m, D = m.vars.dew_point_2m;
  const vals = [...T, ...D].filter(Number.isFinite).map(tempToDisplay);
  const [lo, hi] = padded(Math.min(...vals), Math.max(...vals), 1);
  const y = scale(lo, hi, yBot - 6, yTop + 14);
  frame(g, yTop, yBot, x, `Temperatur / Taupunkt (${tempUnit()})`);
  yTicks(g, lo, hi, y, x, MUTED);
  polyline(g, m.time, D, (v) => y(tempToDisplay(v)), x, COL.dew, 1.6);
  polyline(g, m.time, T, (v) => y(tempToDisplay(v)), x, COL.temp, 1.8);
  legend(g, M.l + 4, yBot - 6, [["Temp", COL.temp], ["Taupunkt", COL.dew]]);
}

function drawPrecip(g, m, x, yTop, yBot) {
  const P = m.vars.precipitation, RH = m.vars.relative_humidity_2m, WC = m.vars.weather_code;
  const pmax = Math.max(0.2, ...P.filter(Number.isFinite));
  const yL = scale(0, pmax, yBot - 6, yTop + 14);
  const yR = scale(0, 100, yBot - 6, yTop + 14);
  frame(g, yTop, yBot, x, `Niederschlag (mm/h) · rel. Feuchte (%)`);
  yTicks(g, 0, pmax, yL, x, MUTED, (v) => v.toFixed(v < 1 ? 2 : 1));
  yTicksRight(g, 0, 100, yR, x, COL.rh);

  const bw = Math.max(1.5, (x(m.time[1]) - x(m.time[0])) * 0.7);
  const present = new Set();
  m.time.forEach((t, i) => {
    const p = P[i];
    if (!Number.isFinite(p) || p <= 0) return;
    const cat = precipCat(WC[i]);
    present.add(cat.key);
    g.append(mk("rect", {
      x: x(t) - bw / 2, y: yL(p), width: bw, height: (yBot - 6) - yL(p), fill: cat.color,
    }));
  });
  polyline(g, m.time, RH, (v) => yR(v), x, COL.rh, 1.4);
  // Legende nur der tatsächlich auftretenden Niederschlagsarten.
  const items = PRECIP_TYPES.filter((t) => present.has(t.key)).map((t) => [t.label, t.color]);
  if (items.length) legend(g, M.l + 4, yBot - 6, items);
}

function drawWind(g, m, x, yTop, yBot) {
  // 10-m-Bodenwind (km/h in der API) und Böen.
  const spd = m.vars.wind_speed_10m.map((v) => (Number.isFinite(v) ? v / 3.6 : null));
  const dir = m.vars.wind_direction_10m;
  const gustMs = m.vars.wind_gusts_10m.map((v) => (Number.isFinite(v) ? v / 3.6 : null));
  const all = [...spd, ...gustMs].filter(Number.isFinite).map(windToDisplay);
  const hi = padded(0, Math.max(1, ...all), 0.5)[1];
  const y = scale(0, hi, yBot - 6, yTop + 22);
  frame(g, yTop, yBot, x, `Wind 10 m · Böen (${windUnit()})`);
  yTicks(g, 0, hi, y, x, MUTED);

  // Mittelwind als Fläche + Linie.
  areaUnder(g, m.time, spd, (v) => y(windToDisplay(v)), x, yBot - 6, COL.windFill);
  polyline(g, m.time, spd, (v) => y(windToDisplay(v)), x, COL.windMean, 1.8);
  // Böen als rote Warnlinie.
  polyline(g, m.time, gustMs, (v) => y(windToDisplay(v)), x, COL.gust, 1.4, "3 3");

  // Windfiedern (WMO-Barbs) stündlich am oberen Panelrand — kleine Symbolgröße
  // (CHART_BARB_SIZE), dafür Panelbreite mit fester Pixeldichte pro Stunde
  // (siehe renderMeteogram), sonst wären stündliche Fiedern bei langen
  // Horizonten unlesbar zusammengequetscht.
  const ay = yTop + 14;
  for (let i = 0; i < m.time.length; i++) {
    const d = dir[i], s = spd[i];
    if (!Number.isFinite(d) || !Number.isFinite(s)) continue;
    g.append(placeWindBarb(x(m.time[i]), ay, s * KT_PER_MS, d, { size: CHART_BARB_SIZE, color: INK }));
  }
  legend(g, M.l + 4, yBot - 6, [["Mittel", COL.windMean], ["Böen", COL.gust]]);
}

function drawCloud(g, m, x, yTop, yBot) {
  const lo = m.vars.cloud_cover_low, mi = m.vars.cloud_cover_mid, hi = m.vars.cloud_cover_high, WC = m.vars.weather_code;
  const y = scale(0, 100, yBot - 6, yTop + 14);
  frame(g, yTop, yBot, x, `Bewölkung (%)`);
  yTicks(g, 0, 100, y, x, MUTED);
  // Von hoch (hell) nach tief (dunkel) überlagern.
  areaUnder(g, m.time, hi, (v) => y(v), x, yBot - 6, COL.cloudHigh);
  areaUnder(g, m.time, mi, (v) => y(v), x, yBot - 6, COL.cloudMid);
  areaUnder(g, m.time, lo, (v) => y(v), x, yBot - 6, COL.cloudLow);
  // Nebel als orange Marker am Boden: dieselbe sichtbasierte Diagnose wie im
  // Wetter-Ribbon (`fogWwCat`) -- kein eigener weather_code-Check mehr, sonst
  // liefe dieser Marker der Ribbon-/GRAMET-Diagnose leise auseinander.
  const bw = Math.max(1.5, (x(m.time[1]) - x(m.time[0])) * 0.9);
  m.time.forEach((t, i) => {
    if (fogWwCat(m.fog, i, WC[i])?.key === "fog") {
      g.append(mk("rect", { x: x(t) - bw / 2, y: yBot - 10, width: bw, height: 8, fill: COL.fog }));
    }
  });
  legend(g, M.l + 4, yBot - 6, [["tief", COL.cloudLow], ["mittel", COL.cloudMid], ["hoch", COL.cloudHigh], ["Nebel", COL.fog]]);
}

function drawBaseVis(g, m, x, yTop, yBot) {
  const T = m.vars.temperature_2m, Td = m.vars.dew_point_2m;
  const lo = m.vars.cloud_cover_low, V = m.vars.visibility;
  // Wolkenbasis: LCL (Espy) verfeinert mit der untersten Modell-Wolkenschicht,
  // falls vorhanden (siehe clouds.js/column.js). Trigger bleibt cloud_cover_low.
  const refined = m.time.map((t, i) => refineCloudBase(T[i], Td[i], lo[i], m.lowestLayer ? m.lowestLayer[i] : null));
  // y-Achse deckt immer die Vorhersagehöhe ab, expandiert bei Bedarf für eine
  // höhere tiefe Basis, gedeckelt auf das tiefe Stockwerk (~2500 m AGL). Höhere
  // Ceilings (z. B. Cirrus-BKN) gehören nicht in dieses Tief-Panel → nicht
  // zeichnen (das ICAO-Ceiling ohne Cutoff bleibt für Go/No-Go erhalten).
  const LOW_TOP_M = 2500;
  const base = refined.map((r) => (r && r.baseM <= LOW_TOP_M ? r.baseM : null));
  const confident = refined.map((r) => (r ? r.confident : false));
  let maxBaseM = 0;
  for (const v of base) if (Number.isFinite(v) && v > maxBaseM) maxBaseM = v;
  const topM = Math.min(LOW_TOP_M, Math.max(m.maxHeightM || 300, maxBaseM, 300));
  const hHi = heightToDisplay(topM);
  const yL = scale(0, hHi, yBot - 6, yTop + 14);
  const yR = scale(0, 15, yBot - 6, yTop + 14); // Sicht 0..15 km
  frame(g, yTop, yBot, x, `Wolkenbasis tief (${heightUnit()} AGL) · Sicht (km)`);
  yTicks(g, 0, hHi, yL, x, MUTED);
  yTicksRight(g, 0, 15, yR, x, COL.vis);

  const visKm = V.map((v) => (Number.isFinite(v) ? Math.min(15, v / 1000) : null));
  polyline(g, m.time, visKm, (v) => yR(v), x, COL.vis, 1.6);
  // Basislinie segmentweise: durchgezogen bei BKN/OVC (unterste Schicht mit
  // CF ≥ CF_BKN), gestrichelt bei FEW/SCT bzw. beim reinen LCL-Fallback ohne
  // bekannte Kategorie (siehe refineCloudBase in clouds.js).
  // Über große Basissprünge (verschiedene Stockwerke) NICHT verbinden — sonst
  // täuscht eine Scheinlinie einen kontinuierlichen Basisverlauf vor. Punkte an
  // jeder gültigen Basis, damit isolierte Werte sichtbar bleiben.
  const JUMP_M = 400; // m AGL — darüber gilt es als anderes Stockwerk
  const yB = (v) => yL(heightToDisplay(v));
  for (let i = 0; i < m.time.length - 1; i++) {
    const a = base[i], b = base[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > JUMP_M) continue;
    const dash = confident[i] && confident[i + 1] ? null : "4 3";
    g.append(mk("path", {
      d: `M${x(m.time[i]).toFixed(1)} ${yB(a).toFixed(1)} L${x(m.time[i + 1]).toFixed(1)} ${yB(b).toFixed(1)}`,
      fill: "none", stroke: COL.base, "stroke-width": 1.8, "stroke-linecap": "round",
      ...(dash ? { "stroke-dasharray": dash } : {}),
    }));
  }
  for (let i = 0; i < m.time.length; i++) {
    if (Number.isFinite(base[i])) g.append(mk("circle", { cx: x(m.time[i]).toFixed(1), cy: yB(base[i]).toFixed(1), r: 1.6, fill: COL.base }));
  }

  // Legende mit Linienstilen (durchgezogen = BKN/OVC, gestrichelt = FEW/SCT
  // bzw. LCL-Fallback ohne bekannte Kategorie).
  const ly = yBot - 6; let lx = M.l + 4;
  const sample = (dash) => {
    g.append(mk("line", { x1: lx, y1: ly - 3, x2: lx + 14, y2: ly - 3, stroke: COL.base, "stroke-width": 1.8, ...(dash ? { "stroke-dasharray": "4 3" } : {}) }));
    lx += 17;
  };
  sample(false); g.append(txt(lx, ly - 1, "BKN/OVC", MUTED, 10, "start")); lx += 48;
  sample(true); g.append(txt(lx, ly - 1, "FEW/SCT", MUTED, 10, "start")); lx += 48;
  g.append(mk("rect", { x: lx, y: ly - 7, width: 10, height: 4, rx: 1, fill: COL.vis }));
  g.append(txt(lx + 13, ly - 3, "Sicht", MUTED, 10, "start"));
}

// --- Zeitachse -------------------------------------------------------------

function drawTimeAxis(svg, time, x, yTop, yBot) {
  let lastDay = null;
  for (let i = 0; i < time.length; i++) {
    const d = new Date(time[i] * 1000);
    const h = d.getHours();
    if (d.getMinutes() !== 0) continue;
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      svg.append(mk("line", { x1: x(time[i]), y1: yTop, x2: x(time[i]), y2: yBot, stroke: "#c9c8c2", "stroke-width": 1, "stroke-dasharray": "2 3" }));
      const label = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
      svg.append(txt(x(time[i]) + 3, 12, label, INK, 11, "start", 600));
    } else if (h === 6 || h === 12 || h === 18) {
      svg.append(mk("line", { x1: x(time[i]), y1: yTop - 3, x2: x(time[i]), y2: yTop, stroke: MUTED, "stroke-width": 1 }));
      svg.append(txt(x(time[i]), 12, String(h).padStart(2, "0"), MUTED, 10, "middle"));
    }
  }
}

// --- Kleinteile ------------------------------------------------------------

function frame(g, yTop, yBot, x, title) {
  g.append(mk("rect", { x: M.l, y: yTop, width: x.right - M.l, height: yBot - yTop, fill: "#fff", stroke: GRID, "stroke-width": 1 }));
  g.append(txt(M.l + 4, yTop + 12, title, MUTED, 11, "start", 600));
}

function polyline(g, time, arr, yFn, x, color, w, dash) {
  let dPath = "", pen = false;
  for (let i = 0; i < time.length; i++) {
    const v = arr[i];
    if (v == null || !Number.isFinite(v)) { pen = false; continue; }
    const px = x(time[i]), py = yFn(v);
    dPath += (pen ? "L" : "M") + px.toFixed(1) + " " + py.toFixed(1) + " ";
    pen = true;
  }
  if (dPath) g.append(mk("path", { d: dPath, fill: "none", stroke: color, "stroke-width": w, ...(dash ? { "stroke-dasharray": dash } : {}), "stroke-linejoin": "round" }));
}

function areaUnder(g, time, arr, yFn, x, yBase, fill) {
  let dPath = "", started = false, firstX = 0, lastX = 0;
  for (let i = 0; i < time.length; i++) {
    const v = arr[i];
    if (v == null || !Number.isFinite(v)) continue;
    const px = x(time[i]), py = yFn(v);
    if (!started) { dPath += `M${px.toFixed(1)} ${yBase.toFixed(1)} L`; firstX = px; started = true; }
    dPath += `${px.toFixed(1)} ${py.toFixed(1)} `;
    lastX = px;
  }
  if (started) { dPath += `L${lastX.toFixed(1)} ${yBase.toFixed(1)} Z`; void firstX; g.append(mk("path", { d: dPath, fill, stroke: "none" })); }
}

// Senkrechter Pfeil: dir=-1 nach oben (Aufgang), dir=+1 nach unten (Untergang).
function vArrow(g, px, cy, dir) {
  const h = 8, tipY = cy + dir * h, baseY = cy - dir * h;
  g.append(mk("line", { x1: px, y1: baseY, x2: px, y2: tipY, stroke: INK, "stroke-width": 1.3 }));
  g.append(mk("polygon", { points: `${px},${tipY} ${px - 3},${tipY - dir * 4} ${px + 3},${tipY - dir * 4}`, fill: INK }));
}

// Mondscheibe in korrekter Phase. Aufbau durch Übermalen (kein Boolean nötig):
// dunkle Scheibe, helle Hälfte, dann Terminator-Ellipse hell (zunehmend voll)
// oder dunkel (Sichel). NH-Konvention: zunehmend = rechts beleuchtet.
function moonGlyph(g, cx, cy, r, illum, waxing) {
  const DARK = "#4a4e5a", LIGHT = "#f2efdf", EDGE = "#3a3d47";
  g.append(mk("circle", { cx, cy, r, fill: DARK }));
  const sweep = waxing ? 1 : 0; // beleuchtete Hälfte
  g.append(mk("path", { d: `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${sweep} ${cx} ${cy + r} Z`, fill: LIGHT }));
  const t = 2 * illum - 1; // <0 Sichel, >0 gewölbt
  const rx = Math.abs(t) * r;
  if (rx > 0.2) g.append(mk("ellipse", { cx, cy, rx, ry: r, fill: t > 0 ? LIGHT : DARK }));
  g.append(mk("circle", { cx, cy, r, fill: "none", stroke: EDGE, "stroke-width": 0.8 }));
}

function hhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function yTicks(g, lo, hi, y, x, color, fmt = (v) => String(Math.round(v))) {
  for (const v of niceTicks(lo, hi, 4)) {
    const py = y(v);
    g.append(mk("line", { x1: M.l, y1: py, x2: x.right, y2: py, stroke: GRID, "stroke-width": 1 }));
    g.append(txt(M.l - 4, py + 3, fmt(v), color, 10, "end"));
  }
}
function yTicksRight(g, lo, hi, y, x, color, fmt = (v) => String(Math.round(v))) {
  for (const v of niceTicks(lo, hi, 4)) {
    g.append(txt(x.right + 4, y(v) + 3, fmt(v), color, 10, "start"));
  }
}

function legend(g, startX, y, items) {
  let px = startX;
  for (const [label, color] of items) {
    g.append(mk("rect", { x: px, y: y - 7, width: 10, height: 4, rx: 1, fill: color }));
    g.append(txt(px + 13, y - 3, label, MUTED, 10, "start"));
    px += 13 + label.length * 6 + 8;
  }
}

function scale(d0, d1, p0, p1) {
  const k = (p1 - p0) / ((d1 - d0) || 1);
  return (v) => p0 + (v - d0) * k;
}

function niceTicks(lo, hi, n) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function padded(lo, hi, pad) {
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = lo + 1;
  if (hi === lo) hi = lo + 1;
  return [lo - pad, hi + pad];
}

function nightIntervals(nights, t0, t1) {
  const iv = [];
  if (!nights || !nights.length) return iv;
  const clamp = (a, b) => (b > t0 && a < t1 ? { a: Math.max(a, t0), b: Math.min(b, t1) } : null);
  const first = clamp(t0, nights[0].sunrise);
  if (first) iv.push(first);
  for (let i = 0; i < nights.length; i++) {
    const next = nights[i + 1];
    const seg = clamp(nights[i].sunset, next ? next.sunrise : t1);
    if (seg) iv.push(seg);
  }
  return iv;
}

// --- Niederschlagstypen ----------------------------------------------------

const PRECIP_TYPES = [
  { key: "drizzle", label: "Niesel", color: "#a6d96a" },
  { key: "rain", label: "Regen", color: "#1a7a1a" },
  { key: "snow", label: "Schnee", color: "#66d9e8" },
  { key: "fzdrizzle", label: "gefr. Niesel", color: "#e879f9" },
  { key: "fzrain", label: "gefr. Regen", color: "#7c3aed" },
  { key: "thunder", label: "Gewitter", color: "#e34948" },
];
function precipCat(code) {
  const byKey = (k) => PRECIP_TYPES.find((t) => t.key === k);
  if (code === 95 || code === 96 || code === 99) return byKey("thunder");
  if (code === 56 || code === 57) return byKey("fzdrizzle");
  if (code === 66 || code === 67) return byKey("fzrain");
  if (code >= 71 && code <= 77) return byKey("snow");
  if (code === 85 || code === 86) return byKey("snow");
  if (code >= 51 && code <= 55) return byKey("drizzle");
  return byKey("rain"); // 61-65, 80-82 und Rest
}

// --- ww-Auswertung (signifikantes Wetter, auch ohne Niederschlagsmenge) -----

const WW_TYPES = [
  { key: "fog", label: "Nebel", color: "#b0a06a" },
  { key: "drizzle", label: "Niesel", color: "#a6d96a" },
  { key: "rain", label: "Regen", color: "#1a7a1a" },
  { key: "freezing", label: "Vereisung", color: "#7c3aed" },
  { key: "snow", label: "Schnee", color: "#66d9e8" },
  { key: "showers", label: "Schauer", color: "#2a78d6" },
  { key: "thunder", label: "Gewitter", color: "#e34948" },
];
function wwCat(code) {
  const byKey = (k) => WW_TYPES.find((t) => t.key === k);
  if (code == null) return null;
  if (code === 45 || code === 48) return byKey("fog");
  if (code >= 95) return byKey("thunder");
  if (code === 56 || code === 57 || code === 66 || code === 67) return byKey("freezing");
  if ((code >= 80 && code <= 82) || code === 85 || code === 86) return byKey("showers");
  if (code >= 71 && code <= 77) return byKey("snow");
  if (code >= 61 && code <= 65) return byKey("rain");
  if (code >= 51 && code <= 55) return byKey("drizzle");
  return null; // 0-3: klar/bewölkt -> keine Zelle
}

// wwCat() mit sichtbasierter Nebel-Korrektur: liegt `fogArr` (m.fog,
// clouds.js `classifyFog`, deckt Kondensat/Wolkenanteil/Sicht/weather_code-
// Fallback bereits vollständig ab) für diese Stunde vor, entscheidet dessen
// Befund ALLEIN über Nebel — auch wenn `weather_code` 45/48 meldet, aber
// `classifyFog` (Sicht > HAZE_VIS_MAX_M) keinen Nebel sieht (sonst genau der
// Widerspruch zu GRAMET, der hier behoben werden soll, s. Feedback). Andere
// ww-Codes (Regen, Schnee, Gewitter, ...) bleiben unberührt. Fehlt `fogArr`
// ganz (Säule nicht geladen) ODER endet die Säule an dieser Stunde real
// (ICON Global: Modell-Level nur bis +36 h -- `fogArr[i]` dann `undefined`,
// s. app.js openMeteogram), bleibt `wwCat()`s roher weather_code-Trigger der
// einzige verfügbare Nebel-Hinweis.
function fogWwCat(fogArr, i, code) {
  const fog = fogArr ? fogArr[i] : undefined;
  if (!fogArr || fog === undefined) return wwCat(code);
  if (fog?.type === "FG") return WW_TYPES.find((w) => w.key === "fog");
  if (code === 45 || code === 48) return null; // von classifyFog widerlegt
  return wwCat(code);
}

// --- SVG-Helfer ------------------------------------------------------------

function mk(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function txt(x, y, s, fill, size, anchor = "start", weight = 400) {
  const e = mk("text", { x, y, fill, "font-size": size, "text-anchor": anchor, "font-weight": weight });
  e.textContent = s;
  return e;
}
