/**
 * Vertikale Säule am Operationspunkt: holt alle Modell-Level (u, v, T, Höhe)
 * in einem Request und interpoliert sie auf ein logarithmisches Höhengitter —
 * die Datengrundlage der Cross-Sections. Wind wird intern in m/s, Temperatur
 * in °C geführt (Anzeige-Einheiten via units.js im Renderer).
 */

import { API_BASE, MODELS } from "./config.js";

const KMH_TO_MS = 1 / 3.6;

/** Rohe Säule (Level von unten nach oben) am Punkt über den Vorhersagehorizont. */
export async function fetchColumn(lat, lon, modelKey, forecastDays, fetchImpl = fetch.bind(globalThis)) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unbekanntes Modell: ${modelKey}`);

  const vars = [];
  for (let l = 1; l <= model.nLevels; l++) {
    vars.push(`wind_u_component_level${l}`, `wind_v_component_level${l}`,
      `temperature_level${l}`, `height_agl_level${l}`, `relative_humidity_level${l}`,
      `pressure_level${l}`);
  }
  const params = new URLSearchParams({
    latitude: round5(lat), longitude: round5(lon),
    hourly: vars.join(","), models: model.apiModel,
    timeformat: "unixtime", forecast_days: String(forecastDays),
    cell_selection: "nearest",
  });
  const resp = await fetchImpl(`${API_BASE}/v1/forecast?${params}`);
  const body = await resp.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`Serverfehler: ${body.slice(0, 150)}`); }
  if (!resp.ok || data.error) {
    throw new Error(data.reason ? `API: ${data.reason.slice(0, 150)}` : `API-Fehler ${resp.status}`);
  }

  const H = data.hourly, time = H.time, T = time.length;
  // Level von unten (l = nLevels, ~10 m) nach oben (l = 1) einsortieren.
  const h = [], u = [], v = [], t = [], rh = [], p = [];
  for (let l = model.nLevels; l >= 1; l--) {
    h.push(toArr(H[`height_agl_level${l}`], T, 1));
    u.push(toArr(H[`wind_u_component_level${l}`], T, KMH_TO_MS));
    v.push(toArr(H[`wind_v_component_level${l}`], T, KMH_TO_MS));
    t.push(toArr(H[`temperature_level${l}`], T, 1));
    rh.push(toArr(H[`relative_humidity_level${l}`], T, 1));
    p.push(toArr(H[`pressure_level${l}`], T, 1));
  }
  return { time, h, u, v, t, rh, p, nLevels: h.length, elevation: data.elevation };
}

/**
 * Auf ein Log-Höhengitter interpolierte Felder für die Cross-Section.
 * @returns { time, targetH (m AGL, aufsteigend), spd[k][i] (m/s), dir[k][i] (° Herkunft),
 *            temp[k][i] (°C), freezing[i] (m AGL | null) }
 */
export function buildField(col, capM = 8000, nTarget = 44) {
  const { time, h, u, v, t, rh } = col;
  const T = time.length;
  const hMin = Math.max(10, firstFinite(h[0]) || 10);
  const targetH = logspace(hMin, capM, nTarget);

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
      uc[k][i] = uu; vc[k][i] = vv;
      spd[k][i] = Math.hypot(uu, vv);
      dir[k][i] = (Math.atan2(-uu, -vv) * 180 / Math.PI + 360) % 360;
      temp[k][i] = tt;
      rhc[k][i] = rr;
      cloud[k][i] = cloudFrac(rr);
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
  return { h: ht, u: val(col.u), v: val(col.v), t: val(col.t), rh: val(col.rh), p };
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

// Wolkenfraktion aus relativer Feuchte (Schwellen: <65 % frei, 65–85 % FEW/SCT
// bis 0.5, 85–100 % BKN/OVC bis 1.0). Reine Visualisierungs-Heuristik.
function cloudFrac(rh) {
  if (!Number.isFinite(rh) || rh < 65) return 0;
  if (rh < 85) return (rh - 65) / 20 * 0.5;
  return Math.min(1, 0.5 + (rh - 85) / 15 * 0.5);
}

function logspace(a, b, n) {
  const la = Math.log(a), lb = Math.log(b), out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.exp(la + (lb - la) * i / (n - 1));
  return out;
}
function toArr(src, T, factor) {
  const out = new Float64Array(T);
  for (let i = 0; i < T; i++) out[i] = src?.[i] == null ? NaN : src[i] * factor;
  return out;
}
function firstFinite(a) { for (const x of a) if (Number.isFinite(x)) return x; return null; }
function round5(x) { return Math.round(x * 1e5) / 1e5; }
