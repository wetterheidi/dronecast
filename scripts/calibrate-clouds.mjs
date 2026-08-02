#!/usr/bin/env node
/**
 * Kalibrierungs-/Gegencheck-Skript für die Wolkenfraktions-Konstanten in
 * src/clouds.js — holt echte Modell-Level-Daten (T, RH, q, w, QW, QI, CLC)
 * von Michaels ICON-D2/EU-Instanz für eine Reihe europäischer Orte und
 * fittet:
 *
 *   1. Stufe 3 (Sundqvist-Fallback): RH_CRIT_SURF, RH_CRIT_MID,
 *      RH_CRIT_Z_REF (je Modell getrennt), RH_CRIT_ICE — direkt gegen die
 *      echte Sundqvist-Formel per Fehlerquadrat-Minimierung (nicht nur eine
 *      Zwischengröße), damit das Ergebnis nicht von der angenommenen
 *      Kurvenform abhängt.
 *   2. Stufe 2 (Kondensat-Fallback): Verhältnis der Wasser-/Eis-Skalen
 *      (QCOND_SCALE_WATER/ICE) — grobe lineare Regression, s. Warnhinweis
 *      unten zur strukturellen Grenze dieser Stufe.
 *
 * WARUM DAS REGELMÄSSIG LAUFEN MUSS: die aktuell in clouds.js eingebauten
 * Werte stammen aus EINEM Kalendermonat (August 2026, mitteleuropäischer
 * Sommer). Andere Wetterlagen (Winterinversion, Herbstnebel, Frühjahr) können
 * andere optimale Werte ergeben — vor Vertrauen in die Konstanten in anderen
 * Jahreszeiten hier erneut laufen lassen und mit den Werten in clouds.js
 * vergleichen (s. METHODIK.md 4.1 für die volle Herleitung/Historie).
 *
 * Nutzung:  node scripts/calibrate-clouds.mjs
 * (kein Build nötig — importiert direkt aus src/clouds.js)
 *
 * Das Skript schreibt NICHTS automatisch in clouds.js — die Ergebnisse sind
 * bewusst nur eine Empfehlung zum manuellen Abgleich (sicherheitsrelevante
 * Konstanten sollten nicht blind automatisiert überschrieben werden).
 */

import { effectiveRH } from "../src/clouds.js";

const API_BASE = "https://open-meteo.mah.priv.at";

// Geografisch/klimatisch gestreute Punkte über beide Modelldomänen —
// bei Bedarf erweitern (z. B. um saisonale Extremlagen gezielt abzudecken).
const POINTS = [
  { lat: 48.2, lon: 16.37, model: "icon_d2", nLevels: 65 },   // Wien
  { lat: 47.27, lon: 11.4, model: "icon_d2", nLevels: 65 },   // Innsbruck (alpin)
  { lat: 52.52, lon: 13.4, model: "icon_d2", nLevels: 65 },   // Berlin
  { lat: 45.46, lon: 9.19, model: "icon_d2", nLevels: 65 },   // Mailand
  { lat: 50.11, lon: 8.68, model: "icon_d2", nLevels: 65 },   // Frankfurt
  { lat: 55.0, lon: 10.0, model: "icon_eu", nLevels: 74 },    // Dänemark
  { lat: 41.0, lon: 15.0, model: "icon_eu", nLevels: 74 },    // Süditalien
  { lat: 43.3, lon: -1.9, model: "icon_eu", nLevels: 74 },    // Biskaya-Küste
  { lat: 58.0, lon: 8.0, model: "icon_eu", nLevels: 74 },     // Südnorwegen
  { lat: 36.0, lon: -3.0, model: "icon_eu", nLevels: 74 },    // Südspanien
  { lat: 51.5, lon: -1.0, model: "icon_eu", nLevels: 74 },    // Südengland
  { lat: 46.0, lon: 20.0, model: "icon_eu", nLevels: 74 },    // Rumänien/Banat
  { lat: 53.5, lon: 19.5, model: "icon_eu", nLevels: 74 },    // Polen
  { lat: 39.5, lon: 2.6, model: "icon_eu", nLevels: 74 },     // Mallorca
  { lat: 60.0, lon: 25.0, model: "icon_eu", nLevels: 74 },    // Finnland
];
const FORECAST_DAYS = 5;

// --- Datenabruf --------------------------------------------------------------

async function fetchProfile(lat, lon, model, nLevels) {
  const vars = [];
  for (let l = 1; l <= nLevels; l++) {
    vars.push(`temperature_level${l}`, `height_agl_level${l}`, `relative_humidity_level${l}`,
      `pressure_level${l}`, `wind_w_level${l}`, `specific_humidity_level${l}`,
      `cloud_water_level${l}`, `cloud_ice_level${l}`, `cloud_cover_level${l}`);
  }
  const params = new URLSearchParams({
    latitude: lat, longitude: lon, hourly: vars.join(","),
    models: model, timeformat: "unixtime", forecast_days: String(FORECAST_DAYS),
    cell_selection: "nearest",
  });
  const resp = await fetch(`${API_BASE}/v1/forecast?${params}`);
  const data = await resp.json();
  return { H: data.hourly, nLevels };
}

async function collectSamples() {
  const raw = [];
  for (const pt of POINTS) {
    const { H, nLevels } = await fetchProfile(pt.lat, pt.lon, pt.model, pt.nLevels);
    const T = H.time.length;
    for (let l = 1; l <= nLevels; l++) {
      const tArr = H[`temperature_level${l}`], hArr = H[`height_agl_level${l}`];
      const rhArr = H[`relative_humidity_level${l}`], pArr = H[`pressure_level${l}`];
      const wArr = H[`wind_w_level${l}`], qArr = H[`specific_humidity_level${l}`];
      const qwArr = H[`cloud_water_level${l}`], qiArr = H[`cloud_ice_level${l}`];
      const clcArr = H[`cloud_cover_level${l}`];
      for (let i = 0; i < T; i++) {
        const t = tArr?.[i], h = hArr?.[i], rh = rhArr?.[i], p = pArr?.[i];
        const w = wArr?.[i], clc = clcArr?.[i];
        const q = qArr?.[i] != null ? qArr[i] * 1e-3 : NaN;
        const qw = qwArr?.[i] != null ? qwArr[i] * 1e-3 : NaN;
        const qi = qiArr?.[i] != null ? qiArr[i] * 1e-3 : NaN;
        if (![t, h, rh, p, w, clc].every(Number.isFinite)) continue;
        const rhEff = effectiveRH({ q, p, rh }, t);
        if (!Number.isFinite(rhEff)) continue;
        raw.push({ t, h, w, rhEff, qw, qi, cf: clc / 100, model: pt.model });
      }
    }
  }
  return raw;
}

// --- Stufe 3: Sundqvist-Konstanten -------------------------------------------

function sundqvist(rhEff, rhc) {
  if (rhEff <= rhc || rhc >= 100) return 0;
  return Math.max(0, Math.min(1, 1 - Math.sqrt(Math.max(0, (100 - rhEff) / (100 - rhc)))));
}
function critWarm(z, surf, mid, zref) { return surf + (mid - surf) * Math.min(1, z / zref); }
function linspace(a, b, n) { const out = []; for (let i = 0; i < n; i++) out.push(a + (b - a) * i / Math.max(1, n - 1)); return out; }

function mseWarm(surf, mid, zref, sample) {
  let s = 0;
  for (const p of sample) s += (sundqvist(p.rhEff, critWarm(p.h, surf, mid, zref)) - p.cf) ** 2;
  return s / sample.length;
}

function fitWarm(sample, passes) {
  let best = { surf: 72, mid: 85, zref: 1500, err: mseWarm(72, 85, 1500, sample) };
  for (const r of passes) {
    const surfs = linspace(Math.max(1, best.surf - r.rSurf), Math.min(99, best.surf + r.rSurf), r.n);
    const mids = linspace(Math.max(1, best.mid - r.rMid), Math.min(99, best.mid + r.rMid), r.n);
    const zrefs = linspace(Math.max(100, best.zref - r.rZref), best.zref + r.rZref, r.n);
    for (const surf of surfs) for (const mid of mids) for (const zref of zrefs) {
      const e = mseWarm(surf, mid, zref, sample);
      if (e < best.err) best = { surf, mid, zref, err: e };
    }
  }
  return best;
}

function mseIce(rhc, sample) {
  let s = 0;
  for (const p of sample) s += (sundqvist(p.rhEff, rhc) - p.cf) ** 2;
  return s / sample.length;
}
function fitIce(sample) {
  let best = { rhc: 72, err: mseIce(72, sample) };
  for (let rhc = 50; rhc < 99.5; rhc += 0.25) {
    const e = mseIce(rhc, sample);
    if (e < best.err) best = { rhc, err: e };
  }
  return best;
}

function baselineMse(sample) {
  const mean = sample.reduce((s, p) => s + p.cf, 0) / sample.length;
  return sample.reduce((s, p) => s + (mean - p.cf) ** 2, 0) / sample.length;
}

// --- Stufe 2: Kondensat-Skalen (grob, s. Warnhinweis in clouds.js/METHODIK) --

function fitScaleThroughOrigin(pts) { // y = x/scale (Least-Squares durch Ursprung)
  let sxy = 0, sxx = 0;
  for (const { x, y } of pts) { sxy += x * y; sxx += x * x; }
  return sxx > 0 ? 1 / (sxy / sxx) : NaN;
}

// --- Hauptlauf ----------------------------------------------------------------

const raw = await collectSamples();
console.log(`Gesamt verwertbare Level-Stunden-Tripel: ${raw.length}\n`);

console.log("=== Stufe 3: RH_CRIT_SURF / RH_CRIT_MID / RH_CRIT_Z_REF (warm, ruhig: T>2°C, |w|<0.15) ===");
const warmCalm = raw.filter((p) => p.t > 2 && Math.abs(p.w) < 0.15);
const passes = [
  { rSurf: 25, rMid: 15, rZref: 2000, n: 11 },
  { rSurf: 8, rMid: 5, rZref: 800, n: 9 },
  { rSurf: 3, rMid: 2, rZref: 300, n: 7 },
];
const fittedWarm = fitWarm(warmCalm, passes);
console.log(`n=${warmCalm.length}`);
console.log(`Aktuelle Konstanten (clouds.js):  MSE=${mseWarm(96, 83, 950, warmCalm).toFixed(4)}`);
console.log(`Gefittet (kombiniert):            RH_CRIT_SURF=${fittedWarm.surf.toFixed(1)} RH_CRIT_MID=${fittedWarm.mid.toFixed(1)} RH_CRIT_Z_REF=${fittedWarm.zref.toFixed(0)}  MSE=${fittedWarm.err.toFixed(4)}`);
console.log(`Referenz "immer Mittelwert":      MSE=${baselineMse(warmCalm).toFixed(4)}`);

for (const model of ["icon_d2", "icon_eu"]) {
  const sample = warmCalm.filter((p) => p.model === model);
  if (sample.length < 50) { console.log(`${model}: zu wenig Daten (n=${sample.length})`); continue; }
  const f = fitWarm(sample, passes);
  console.log(`${model} (n=${sample.length}):`.padEnd(24) + `RH_CRIT_SURF=${f.surf.toFixed(1)} RH_CRIT_MID=${f.mid.toFixed(1)} RH_CRIT_Z_REF=${f.zref.toFixed(0)}  MSE=${f.err.toFixed(4)}`);
}

console.log("\n=== Stufe 3: RH_CRIT_ICE (kalt, ruhig: T<-35°C, |w|<0.15) ===");
const iceCalm = raw.filter((p) => p.t < -35 && Math.abs(p.w) < 0.15);
const fittedIce = fitIce(iceCalm);
console.log(`n=${iceCalm.length}`);
console.log(`Aktuelle Konstante (clouds.js):   MSE=${mseIce(96.5, iceCalm).toFixed(4)}`);
console.log(`Gefittet:                         RH_CRIT_ICE=${fittedIce.rhc.toFixed(1)}  MSE=${fittedIce.err.toFixed(4)}`);
console.log(`Referenz "immer Mittelwert":      MSE=${baselineMse(iceCalm).toFixed(4)}`);

console.log("\n=== Stufe 2: Wasser-/Eis-Kondensatskalen (grob, s. Warnhinweis) ===");
console.log("(strukturelle Grenze: unser qw/qi ist grid-scale, CLC ist mit der");
console.log(" diagnostischen Subgrid-Variante konsistent — s. METHODIK.md 4.1)");
for (const purity of [0.05]) {
  const waterPts = raw.filter((p) => p.t > 0 && p.qi < purity * p.qw + 1e-6 && p.qw > 0 && p.cf > 0 && p.cf < 0.995)
    .map((p) => ({ x: p.qw, y: -Math.log(1 - p.cf) }));
  const icePts = raw.filter((p) => p.t < -35 && p.qw < purity * p.qi + 1e-6 && p.qi > 0 && p.cf > 0 && p.cf < 0.995)
    .map((p) => ({ x: p.qi, y: -Math.log(1 - p.cf) }));
  const sWater = fitScaleThroughOrigin(waterPts), sIce = fitScaleThroughOrigin(icePts);
  console.log(`n_wasser=${waterPts.length} n_eis=${icePts.length}`);
  console.log(`Gefittet: QCOND_SCALE_WATER=${sWater.toExponential(2)} QCOND_SCALE_ICE=${sIce.toExponential(2)}  Verhältnis=${(sWater / sIce).toFixed(1)}`);
}

console.log("\nHinweis: Ergebnisse manuell mit den Konstanten in src/clouds.js");
console.log("vergleichen und nur nach Plausibilitätsprüfung übernehmen — s.");
console.log("METHODIK.md 4.1 für Einschränkungen (u. a. nur ein Kalendermonat Daten).");
