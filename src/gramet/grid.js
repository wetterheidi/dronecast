/**
 * Zeit-Höhen-Gitter für das GRAMET-Meteogramm — baut auf der bereits
 * bestehenden Säule (`column.js` `fetchColumn`) und den Oberflächenwerten
 * (`weather.js` `fetchSurface`) auf, statt eigene Requests zu stellen: beide
 * werden im Rest der App ohnehin schon geladen und in `state.data` gecacht.
 *
 * Abweichung vom ursprünglichen Plan: `pressure_level{l}` liefert Michaels
 * Server bereits direkt (siehe `column.js`), die hydrostatische Integration
 * aus `pressure_msl` ist damit unnötig — Levelddruck kommt 1:1 aus der Säule.
 * `pressure_msl` selbst wird trotzdem gebraucht (SLP-Zeile im Row-Stack) —
 * kommt ebenfalls direkt aus `column.js`, gleiche Instanz/Zeitreihe.
 *
 * Level-Ordnung: k=0 unterstes Level (~10 m AGL), aufsteigend — `column.js`
 * liefert die Level bereits in dieser Reihenfolge, keine Umkehr nötig.
 * Einheiten intern SI (K, m/s, kg/kg, m, Pa); °C/hPa nur an der Grenze zu
 * `clouds.js` (das RH-Kriterium arbeitet in °C/hPa), s. `cloudFracAt()`.
 */

import { cloudFraction } from "../clouds.js";
import { fetchColumn } from "../column.js";
import { nearestIndex } from "../weather.js";

const KELVIN = 273.15;
const P0_PA = 100000, KAPPA = 0.2857; // R_d/c_p
const G = 9.80665;

/** Säule + Oberflächenwerte laden und ins GRAMET-Gitter überführen. */
export async function fetchGrid(lat, lon, modelKey, forecastDays, surface, fetchImpl) {
  const col = await fetchColumn(lat, lon, modelKey, forecastDays, fetchImpl);
  const grid = gridFromColumn(col, surface, lat, lon);
  validate(grid);
  return grid;
}

/** Aus einer bereits geladenen Säule + Oberflächenwerten (kein Request). */
export function gridFromColumn(col, surface, lat, lon) {
  const nk = col.nLevels, times = col.time, nt = times.length;
  const z = new Float32Array(nt * nk), T = new Float32Array(nt * nk),
    u = new Float32Array(nt * nk), v = new Float32Array(nt * nk),
    w = new Float32Array(nt * nk), qv = new Float32Array(nt * nk),
    qw = new Float32Array(nt * nk), qi = new Float32Array(nt * nk),
    clc = new Float32Array(nt * nk), rh = new Float32Array(nt * nk),
    p = new Float32Array(nt * nk);

  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      z[ix] = col.h[k][i];
      T[ix] = col.t[k][i] + KELVIN;
      u[ix] = col.u[k][i];
      v[ix] = col.v[k][i];
      w[ix] = col.w ? col.w[k][i] : NaN;
      qv[ix] = col.q ? col.q[k][i] : NaN;
      qw[ix] = col.qw ? col.qw[k][i] : NaN;
      qi[ix] = col.qi ? col.qi[k][i] : NaN;
      clc[ix] = col.clc ? col.clc[k][i] : NaN;
      rh[ix] = col.rh ? col.rh[k][i] : NaN;
      p[ix] = col.p ? col.p[k][i] * 100 : NaN; // hPa -> Pa
    }
  }

  return {
    meta: { lat, lon, elevation: col.elevation, model: col.model, dt: nt > 1 ? times[1] - times[0] : 3600 },
    times, nk,
    z, T, u, v, w, qv, qw, qi, clc, rh, p,
    surface: buildSurface(surface, times, col),
    derived: null,
  };
}

function buildSurface(surface, times, col) {
  const nt = times.length;
  const t2m = new Float32Array(nt).fill(NaN), td2m = new Float32Array(nt).fill(NaN),
    ws10 = new Float32Array(nt).fill(NaN), wd10 = new Float32Array(nt).fill(NaN),
    gust = new Float32Array(nt).fill(NaN), precip = new Float32Array(nt).fill(NaN),
    snow = new Float32Array(nt).fill(NaN);
  // pressure_msl kommt direkt aus der Säule (dieselbe Instanz/Zeitreihe wie die
  // Level-Daten, s. column.js) -- 1:1 indexiert, kein nearestIndex-Abgleich nötig.
  const pmsl = col?.pmsl ? Float32Array.from(col.pmsl) : new Float32Array(nt).fill(NaN);
  if (!surface?.time?.length) return { t2m, td2m, ws10, wd10, gust, precip, snow, pmsl };

  const V = surface.vars || {};
  const pick = (name, out, factor = 1) => {
    const src = V[name];
    if (!src) return;
    for (let i = 0; i < nt; i++) {
      // Fehlende Stunden am Horizontende (kürzere Oberflächenreihe) bleiben NaN.
      const j = nearestIndex(surface.time, times[i] * 1000);
      const val = j >= 0 && Math.abs(surface.time[j] - times[i]) <= 1800 ? src[j] : null;
      out[i] = val == null ? NaN : val * factor;
    }
  };
  pick("temperature_2m", t2m);
  pick("dew_point_2m", td2m);
  pick("wind_speed_10m", ws10, 1 / 3.6); // km/h -> m/s
  pick("wind_direction_10m", wd10);
  pick("wind_gusts_10m", gust, 1 / 3.6);
  pick("precipitation", precip);
  pick("snowfall", snow);
  return { t2m, td2m, ws10, wd10, gust, precip, snow, pmsl };
}

export function idx(grid, t, k) { return t * grid.nk + k; }

/** Punkt (Zeitindex i, Höhe m AGL) linear zwischen Levels interpoliert. */
export function sampleAt(grid, i, hAgl) {
  const { nk } = grid;
  const base = i * nk;
  let k = 1;
  while (k < nk && grid.z[base + k] < hAgl) k++;
  if (k >= nk) k = nk - 1;
  const k0 = base + k - 1, k1 = base + k;
  const z0 = grid.z[k0], z1 = grid.z[k1];
  const f = z1 > z0 ? clamp01((hAgl - z0) / (z1 - z0)) : 0;
  const lerp = (a) => a[k0] + f * (a[k1] - a[k0]);
  return {
    z: hAgl, T: lerp(grid.T), u: lerp(grid.u), v: lerp(grid.v), w: lerp(grid.w),
    rh: lerp(grid.rh), p: lerp(grid.p), cloudFrac: lerp(derive(grid).cloudFrac),
  };
}

/** Wolkenfraktion für eine Gitterzelle über die bestehende `clouds.js`-Heuristik
 *  (Stufe 1/2/3-Fallback, s. dort) — Umrechnung K->°C/Pa->hPa nur hier am Rand. */
function cloudFracAt(grid, ix) {
  return cloudFraction({
    q: grid.qv[ix], p: grid.p[ix] / 100, t: grid.T[ix] - KELVIN,
    rh: grid.rh[ix], qw: grid.qw[ix], qi: grid.qi[ix], clc: grid.clc[ix], model: grid.meta.model,
  }, grid.z[ix], grid.w[ix]);
}

/** Abgeleitete Felder, lazy + idempotent (einmal berechnet, am Gitter gecacht). */
export function derive(grid) {
  if (grid.derived) return grid.derived;
  const { nk, times } = grid, nt = times.length, n = nt * nk;
  const theta = new Float32Array(n), wspd = new Float32Array(n), cloudFrac = new Float32Array(n);
  for (let ix = 0; ix < n; ix++) {
    theta[ix] = grid.T[ix] * Math.pow(P0_PA / grid.p[ix], KAPPA);
    wspd[ix] = Math.hypot(grid.u[ix], grid.v[ix]);
    cloudFrac[ix] = cloudFracAt(grid, ix);
  }

  // Staggered Zwischenniveaus (nt x (nk-1)) für Scherung/Stabilität — Grundlage
  // des späteren Turbulenz-Moduls (hazards/turbulence.js).
  const nm = Math.max(0, nk - 1);
  const shear2 = new Float32Array(nt * nm), n2 = new Float32Array(nt * nm), ri = new Float32Array(nt * nm);
  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < nm; k++) {
      const ix0 = i * nk + k, ix1 = i * nk + k + 1, im = i * nm + k;
      const dz = grid.z[ix1] - grid.z[ix0];
      if (!(dz > 0)) { shear2[im] = NaN; n2[im] = NaN; ri[im] = NaN; continue; }
      const du = grid.u[ix1] - grid.u[ix0], dv = grid.v[ix1] - grid.v[ix0];
      const s2 = (du / dz) ** 2 + (dv / dz) ** 2;
      const thetaAvg = (theta[ix0] + theta[ix1]) / 2;
      const dTheta = theta[ix1] - theta[ix0];
      const nn2 = (G / thetaAvg) * (dTheta / dz);
      shear2[im] = s2;
      n2[im] = nn2;
      ri[im] = s2 > 1e-8 ? nn2 / s2 : NaN; // Schutz bei ~Nullscherung
    }
  }

  grid.derived = { theta, wspd, cloudFrac, shear2, n2, ri, nm };
  return grid.derived;
}

// --- Validierung -------------------------------------------------------------

function validate(grid) {
  const { nk, times } = grid, nt = times.length;
  for (let i = 0; i < nt; i++) {
    let prevZ = -Infinity;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      const z = grid.z[ix], T = grid.T[ix], q = grid.qv[ix];
      if (Number.isFinite(z) && z <= prevZ) {
        console.warn(`gramet/grid: z nicht streng monoton (t=${i}, k=${k})`);
      }
      if (Number.isFinite(z)) prevZ = z;
      if (Number.isFinite(T) && (T < 150 || T > 350)) {
        console.warn(`gramet/grid: T außerhalb [150,350] K (t=${i}, k=${k}): ${T}`);
      }
      if (Number.isFinite(q) && q < 0) {
        console.warn(`gramet/grid: q_v < 0 (t=${i}, k=${k}): ${q}`);
      }
    }
  }
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
