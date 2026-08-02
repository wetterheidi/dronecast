/**
 * Vertikale Säule am Operationspunkt: holt alle Modell-Level (u, v, T, Höhe)
 * in einem Request und interpoliert sie auf ein logarithmisches Höhengitter —
 * die Datengrundlage der Cross-Sections. Wind wird intern in m/s, Temperatur
 * in °C geführt (Anzeige-Einheiten via units.js im Renderer).
 */

import { API_BASE, MODELS } from "./config.js";
import { cloudFraction } from "./clouds.js";

const KMH_TO_MS = 1 / 3.6;

// Kern-Level-Variablen (immer verfügbar) vs. optionale Wolken-Diagnose-Felder
// (cloud_water/ice/cover_level{l} — Michaels direktes Modell-Output, erst seit
// 2026 auf beiden Instanzen live). Scheitert der Request mit den optionalen
// Feldern, wird einmalig ohne sie wiederholt (Muster wie SURFACE_OPTIONAL in
// weather.js) — der Sundqvist-Fallback in clouds.js greift dann automatisch.
function levelVars(nLevels, includeCloudDiag) {
  const vars = [];
  for (let l = 1; l <= nLevels; l++) {
    vars.push(`wind_u_component_level${l}`, `wind_v_component_level${l}`,
      `temperature_level${l}`, `height_agl_level${l}`, `relative_humidity_level${l}`,
      `pressure_level${l}`, `wind_w_level${l}`, `specific_humidity_level${l}`);
    if (includeCloudDiag) {
      vars.push(`cloud_water_level${l}`, `cloud_ice_level${l}`, `cloud_cover_level${l}`);
    }
  }
  return vars;
}

async function tryFetchColumn(lat, lon, model, forecastDays, vars, fetchImpl) {
  const params = new URLSearchParams({
    latitude: round5(lat), longitude: round5(lon),
    hourly: vars.join(","), models: model.apiModel,
    timeformat: "unixtime", forecast_days: String(forecastDays),
    cell_selection: "nearest",
  });
  const resp = await fetchImpl(`${API_BASE}/v1/forecast?${params}`);
  const body = await resp.text();
  let data;
  try { data = JSON.parse(body); } catch { return { error: `Serverfehler: ${body.slice(0, 150)}` }; }
  if (!resp.ok || data.error) {
    return { error: data.reason ? `API: ${data.reason.slice(0, 150)}` : `API-Fehler ${resp.status}` };
  }
  return { data };
}

/** Rohe Säule (Level von unten nach oben) am Punkt über den Vorhersagehorizont. */
export async function fetchColumn(lat, lon, modelKey, forecastDays, fetchImpl = fetch.bind(globalThis)) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unbekanntes Modell: ${modelKey}`);

  let result = await tryFetchColumn(lat, lon, model, forecastDays, levelVars(model.nLevels, true), fetchImpl);
  if (result.error) {
    result = await tryFetchColumn(lat, lon, model, forecastDays, levelVars(model.nLevels, false), fetchImpl);
  }
  if (result.error) throw new Error(result.error);
  const data = result.data;

  const H = data.hourly, time = H.time, T = time.length;
  // Level von unten (l = nLevels, ~10 m) nach oben (l = 1) einsortieren.
  // wind_w (Vertikalgeschwindigkeit) kommt nativ in m/s (Faktor 1), anders als
  // u/v in km/h. specific_humidity q_v sowie cloud_water/ice (QW/QI) kommen in
  // g/kg → kg/kg (Faktor 0.001) für die Dampfdruck-/Kondensatrechnung
  // (clouds.js). cloud_cover (CLC) bleibt in % wie relative_humidity. Alle für
  // die Wolken-Diagnose — QW/QI/CLC fehlen (NaN), wenn die Instanz sie (noch)
  // nicht führt; clouds.js fällt dann automatisch auf die RH-Heuristik zurück.
  const h = [], u = [], v = [], t = [], rh = [], p = [], w = [], q = [], qw = [], qi = [], clc = [];
  for (let l = model.nLevels; l >= 1; l--) {
    h.push(toArr(H[`height_agl_level${l}`], T, 1));
    u.push(toArr(H[`wind_u_component_level${l}`], T, KMH_TO_MS));
    v.push(toArr(H[`wind_v_component_level${l}`], T, KMH_TO_MS));
    t.push(toArr(H[`temperature_level${l}`], T, 1));
    rh.push(toArr(H[`relative_humidity_level${l}`], T, 1));
    p.push(toArr(H[`pressure_level${l}`], T, 1));
    w.push(toArr(H[`wind_w_level${l}`], T, 1));
    q.push(toArr(H[`specific_humidity_level${l}`], T, 1e-3));
    qw.push(toArr(H[`cloud_water_level${l}`], T, 1e-3));
    qi.push(toArr(H[`cloud_ice_level${l}`], T, 1e-3));
    clc.push(toArr(H[`cloud_cover_level${l}`], T, 1));
  }
  // `model` mitgeführt für modellspezifische Konstanten in clouds.js
  // (RH_CRIT_Z_REF unterscheidet sich zwischen ICON-D2/EU, s. dort).
  return { time, h, u, v, t, rh, p, w, q, qw, qi, clc, nLevels: h.length, elevation: data.elevation, model: modelKey };
}

/**
 * Auf ein Höhengitter interpolierte Felder für die Cross-Section.
 * grid "log" (Standard, dicht am Boden) für die Gesamthöhe, "lin" (gleichmäßig)
 * für den Zoom bis zur Flughöhe mit feiner vertikaler Auflösung.
 * @returns { time, targetH (m AGL, aufsteigend), spd[k][i] (m/s), dir[k][i] (° Herkunft),
 *            temp[k][i] (°C), freezing[i] (m AGL | null) }
 */
export function buildField(col, capM = 8000, nTarget = 44, grid = "log") {
  const { time, h, u, v, t, rh, w, p, q, qw, qi, clc, model } = col;
  const T = time.length;
  const hMin = Math.max(10, firstFinite(h[0]) || 10);
  const targetH = grid === "lin" ? linspace(hMin, capM, nTarget) : logspace(hMin, capM, nTarget);

  const spd = [], dir = [], temp = [], uc = [], vc = [], rhc = [], cloud = [];
  for (let k = 0; k < nTarget; k++) {
    spd.push(new Float64Array(T)); dir.push(new Float64Array(T)); temp.push(new Float64Array(T));
    uc.push(new Float64Array(T)); vc.push(new Float64Array(T));
    rhc.push(new Float64Array(T)); cloud.push(new Float64Array(T));
  }
  const freezing = new Float64Array(T).fill(NaN);

  for (let i = 0; i < T; i++) {
    // Höhen dieser Stunde von unten nach oben.
    const hi = h.map((a) => a[i]);
    for (let k = 0; k < nTarget; k++) {
      const br = bracket(hi, targetH[k]);
      const uu = lerp(u, br, i), vv = lerp(v, br, i), tt = lerp(t, br, i), rr = lerp(rh, br, i);
      const ww = w ? lerp(w, br, i) : NaN;
      const pp = p ? lerp(p, br, i) : NaN, qq = q ? lerp(q, br, i) : NaN;
      const qwq = qw ? lerp(qw, br, i) : NaN, qiq = qi ? lerp(qi, br, i) : NaN;
      const clcq = clc ? lerp(clc, br, i) : NaN;
      uc[k][i] = uu; vc[k][i] = vv;
      spd[k][i] = Math.hypot(uu, vv);
      dir[k][i] = (Math.atan2(-uu, -vv) * 180 / Math.PI + 360) % 360;
      temp[k][i] = tt;
      rhc[k][i] = rr;
      cloud[k][i] = cloudFraction({ q: qq, p: pp, t: tt, rh: rr, qw: qwq, qi: qiq, clc: clcq, model }, targetH[k], ww);
    }
    // Nullgradgrenze: unterster Übergang T ≥ 0 → < 0 nach oben.
    freezing[i] = zeroCrossing(hi, t, i);
  }
  // u/v mitführen: korrekte Windinterpolation beim Hover (Winkel nie direkt).
  return { time, targetH, spd, dir, temp, u: uc, v: vc, rh: rhc, cloud, freezing };
}

/**
 * Rohe Säule zur Stunde `i` linear auf die AGL-Zielhöhe `ht` (m) interpolieren.
 * u/v/T/RH linear, Druck logarithmisch in der Höhe. Unter dem untersten Level
 * wird geklammert (wie in windfield.js). Wind kommt in m/s, T/RH/p in SI/hPa.
 */
export function sampleColumnAtHeight(col, i, ht) {
  const hi = col.h.map((a) => a[i]);
  const br = bracket(hi, ht);
  const val = (byLevel) => (byLevel ? lerp(byLevel, br, i) : null);
  let p = null;
  if (col.p) {
    const a = col.p[br.k0][i], b = col.p[br.k1][i];
    p = a > 0 && b > 0
      ? Math.exp(Math.log(a) + br.f * (Math.log(b) - Math.log(a)))
      : lerp(col.p, br, i);
  }
  return {
    h: ht, u: val(col.u), v: val(col.v), t: val(col.t), rh: val(col.rh), p, w: val(col.w), q: val(col.q),
    qw: val(col.qw), qi: val(col.qi), clc: val(col.clc), model: col.model,
  };
}

// --- Helfer ----------------------------------------------------------------

function bracket(hi, ht) {
  const L = hi.length;
  if (ht <= hi[0]) return { k0: 0, k1: 0, f: 0 };
  let k = 1;
  while (k < L && hi[k] < ht) k++;
  if (k >= L) return { k0: L - 1, k1: L - 1, f: 0 };
  const f = (ht - hi[k - 1]) / (hi[k] - hi[k - 1]);
  return { k0: k - 1, k1: k, f };
}
function lerp(arrByLevel, br, i) {
  const a = arrByLevel[br.k0][i], b = arrByLevel[br.k1][i];
  return a + br.f * (b - a);
}
function zeroCrossing(hi, tByLevel, i) {
  for (let k = 0; k < hi.length - 1; k++) {
    const t0 = tByLevel[k][i], t1 = tByLevel[k + 1][i];
    if (t0 >= 0 && t1 < 0) {
      const f = t0 / (t0 - t1);
      return hi[k] + f * (hi[k + 1] - hi[k]);
    }
  }
  return NaN; // durchweg über oder unter 0 im Fenster
}

function logspace(a, b, n) {
  const la = Math.log(a), lb = Math.log(b), out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.exp(la + (lb - la) * i / (n - 1));
  return out;
}
function linspace(a, b, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a + (b - a) * i / (n - 1);
  return out;
}
function toArr(src, T, factor) {
  const out = new Float64Array(T);
  for (let i = 0; i < T; i++) out[i] = src?.[i] == null ? NaN : src[i] * factor;
  return out;
}
function firstFinite(a) { for (const x of a) if (Number.isFinite(x)) return x; return null; }
function round5(x) { return Math.round(x * 1e5) / 1e5; }
