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
import { drawClouds } from "./texture.js";
import { drawWindRow, WIND_ROW_HEIGHT } from "./rows/wind.js";
import { drawNumberRow, NUMBER_ROW_HEIGHT } from "./rows/numberRow.js";
import { niceLogHeights, niceTicks, fmtH } from "../crosssection.js";
import { CHART_PX_PER_HOUR } from "../windbarb.js";
import { fmtHeight, fmtWind, fmtTemp, fmtDir } from "../units.js";

const INK = "#0b0b0b", MUTED = "#52514e", GRID = "#d9d8d3";
const TOPAX = 22, GAP = 16, BOT = 22, M = { l: 50, r: 16 };

// Dunkleres Blau als im ersten Entwurf (das helle Himmelblau ließ die weiße
// Wolkenschraffur verschwinden) -- näher am Original-GRAMET-Kontrast.
const NIGHT_COLOR = "#050b1e", DAY_COLOR = "#2b5c93";

const ICING_COLORS = { light: "rgba(46,204,113,0.28)", moderate: "rgba(39,174,96,0.48)", severe: "rgba(27,94,32,0.68)" };
const TURB_COLORS = { light: "rgba(255,193,7,0.28)", moderate: "rgba(255,152,0,0.48)", severe: "rgba(211,47,47,0.6)" };

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
};

const DEFAULT_ROWS = ["wind", "tempdew", "gust", "pressure"];

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
  drawHazardCells(ctx, grid, view.hazards.icing, ICING_COLORS, x, y);
  if (toggles.clouds !== false) drawClouds(ctx, grid, view.cloudFrac, x, y);
  if (toggles.precip !== false) drawPrecip(ctx, view.precip, x, y);
  drawHazardCells(ctx, grid, view.hazards.turbulence, TURB_COLORS, x, y);
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

  host.append(canvas);
  setupHover(host, canvas, grid, { x, y, mainTop, mainBot });
  return canvas;
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

function drawHazardCells(ctx, grid, hazardArr, colorMap, x, y) {
  const { nk, times } = grid, nt = times.length;
  const dt = nt > 1 ? times[1] - times[0] : 3600;
  for (let i = 0; i < nt; i++) {
    const x0 = x(times[i] - dt / 2), x1 = x(times[i] + dt / 2);
    if (x1 < x.left || x0 > x.right) continue;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      const col = colorMap[hazardArr[ix]];
      if (!col) continue;
      const zLo = k > 0 ? (grid.z[ix] + grid.z[ix - 1]) / 2 : grid.z[ix];
      const zHi = k < nk - 1 ? (grid.z[ix] + grid.z[ix + 1]) / 2 : grid.z[ix];
      const yTop = y(zHi), yBot = y(zLo);
      if (yBot <= y.top || yTop >= y.bot) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
    }
  }
}

// --- Niederschlag --------------------------------------------------------------

function drawPrecip(ctx, entries, x, y) {
  ctx.save();
  for (const e of entries) {
    const cx = x(e.t);
    const topZ = Math.max(0, e.zTop);
    const n = 6;
    for (let s = 0; s < n; s++) {
      const z = (topZ * (s + 0.5)) / n;
      const py = y(z);
      if (py < y.top || py > y.bot) continue;
      const snowHere = e.type === "sn" || (Number.isFinite(e.freezingZ) && z > e.freezingZ);
      ctx.strokeStyle = "#1f6fb2";
      if (snowHere) drawAsterisk(ctx, cx, py, 3.2); else drawDash(ctx, cx, py, 4.5);
    }
  }
  ctx.restore();
}
function drawAsterisk(ctx, cx, cy, r) {
  ctx.lineWidth = 1.2;
  for (const deg of [0, 60, 120]) {
    const rad = deg * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx - r * Math.cos(rad), cy - r * Math.sin(rad));
    ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    ctx.stroke();
  }
}
function drawDash(ctx, cx, cy, len) {
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(cx - len * 0.3, cy - len * 0.5);
  ctx.lineTo(cx + len * 0.3, cy + len * 0.5);
  ctx.stroke();
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
function labelBox(ctx, px, py, text, color) {
  ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "start"; ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 8;
  const bx = Math.min(px + 2, ctx.canvas.width - w - 2);
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
    labelBox(ctx, x(p.t), y(p.z), `${tempC}°C`, color);
  }
}
function drawIsotachs(ctx, isotachs, x, y) {
  for (const { kt, polylines } of isotachs) {
    if (!polylines.length) continue;
    for (const pl of polylines) drawPolyline(ctx, pl, x, y, "#6b6b1f", [3, 3]);
    const last = rightmost(polylines);
    const p = last[last.length - 1];
    labelBox(ctx, x(p.t), y(p.z), `${kt} kt`, "#6b6b1f");
  }
}
function drawTropopause(ctx, line, x, y) {
  if (line.length < 2) return;
  drawPolyline(ctx, line, x, y, "#cc0000", []);
  const p = line[line.length - 1];
  labelBox(ctx, x(p.t), y(p.z), "Trop", "#cc0000");
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

function setupHover(host, canvas, grid, info) {
  const { x, y, mainTop, mainBot } = info;
  host.style.position = host.style.position || "relative";
  const tip = document.createElement("div");
  tip.className = "gm-tip";
  tip.style.display = "none";
  host.append(tip);

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

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function mixHex(a, b, f) {
  const ca = hex(a), cb = hex(b), ff = clamp(f, 0, 1);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * ff);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * ff);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * ff);
  return `rgb(${r},${g},${bl})`;
}
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
