/**
 * Boden-Nebel/Dunst-Diagnose (FG/BR/HZ) — ein SPALTEN-Phänomen (eine
 * Klassifikation + eine Obergrenze pro Stunde), anders als Vereisung/
 * Turbulenz kein Zellwert. Ausgabeform folgt darum `cbColumns()` in
 * `derive.js` (Array `{...} | null`, ein Eintrag je Stunde), NICHT
 * `icing.computeGrid()`.
 *
 * SICHTWEITE ALS PRIMÄRES KRITERIUM (Handbuch Flugwetterdienste, Band Obs):
 *   FG: Sicht < 1000 m (immer, unabhängig von RH — Ausnahme BCFG, die WW
 *       nicht unterscheidet, s. u.)
 *   BR: 1000–5000 m UND RH ≥ 80 %
 *   HZ: 1000–5000 m UND RH < 80 %
 * `grid.surface.visibility` (Open-Meteo/ICON-Modelldiagnose, dieselbe Größe,
 * die auch im Briefing angezeigt wird) ist damit der Wahrheitsanker — nicht
 * mehr eine reine RH-Schwelle ohne Sichtbezug. Das behebt zwei Probleme der
 * ersten Fassung:
 *  - RH ≥ 60 % allein sagt fast nichts über Sicht aus (an einem feuchten
 *    Sommertag mit bester Sicht schnell erreicht) — führte zu BR/HZ an
 *    Stunden, an denen das Modell selbst (Briefing-Sichtspalte) >10 km Sicht
 *    zeigte.
 *  - Widerspricht `weather_code` (45/48 = Nebel) der modelleigenen Sicht
 *    (>5000 m), gewinnt jetzt die Sicht — WW wird nur noch konsultiert, wenn
 *    gar keine Sichtweite vorliegt.
 *
 * Priorität je Stunde, jeweils NUR wenn das unterste Level (k=0, ~10 m AGL)
 * den Schwellwert erreicht (Bodenkontakt-Pflicht — sonst würde erhöhter
 * Nebel/erhöhte Feuchte fälschlich als Bodenphänomen gezeigt):
 *
 *  1. Kondensat direkt (qw+qi > FOG_QW_MIN, mirrors `groundFog()` aus
 *     `clouds.js`, hier grid-nativ statt Column-Objekt, da `grid.qw`/`qi`
 *     ohnehin schon flache Arrays sind) → FG, sicher, mit echter Obergrenze
 *     (Höhen-Scan) — stärkstes physikalisches Signal, geht der Sichtweiten-
 *     Diagnose bewusst vor (direkter Nachweis von Flüssigwasser/Eis am
 *     Boden schlägt eine abgeleitete/parametrisierte Sichtdiagnose).
 *  2. `cloudFrac >= CF_BKN` → FG, mit echter Obergrenze; sicher nur, wenn CLC
 *     (Tier 1 der `cloudFraction()`-Kaskade) das trägt — kommt der Wert
 *     stattdessen aus dem RH-Sundqvist-Fallback (Tier 3; der bodennahe
 *     Dunst-Guard ist unter der aktuellen Kalibrierung laut `clouds.js`
 *     FAKTISCH INAKTIV), gilt das als unsicher.
 *  3. Sonst, wenn `visibility[i]` vorhanden ist:
 *     a. < FG_VIS_MAX_M → FG, sicher, KEINE Obergrenze (Sicht ist ein
 *        Flächenwert, kein Höhenprofil — anders als 1./2. lässt sich daraus
 *        keine physikalische Nebeldecke herleiten).
 *     b. ≤ HAZE_VIS_MAX_M → BR (RH ≥ BR_HZ_RH_SPLIT) oder HZ (sonst), beide
 *        sicher (Sicht UND RH sind reale Modellfelder, kein Fallback).
 *     c. sonst kein Befund — AUCH wenn RH hoch ist oder `weather_code`
 *        Nebel meldet (s. Priorität 4): die Sicht ist hier die Wahrheit.
 *  4. Sonst (keine Sichtweite verfügbar — seltener Rand-/Instanzfall):
 *     a. `weather_code` 45/48 → FG, unsicher, keine Obergrenze (alter
 *        `groundFog()`+`metarWeather()`-Fallback).
 *     b. RH ≥ BR_RH_FALLBACK_MIN → BR, unsicher.
 *     c. RH ≥ HZ_RH_FALLBACK_MIN → HZ, unsicher.
 *  5. sonst kein Befund (`null`).
 *
 * Alle RH-/Sicht-Schwellen sind wie an anderer Stelle im Wolkenmodul
 * PLATZHALTER bzw. direkt aus dem Handbuch übernommen, nicht gegen echte
 * Beobachtungen an dieser App kalibriert (s. METHODIK.md-Vorbehalte in
 * clouds.js).
 */

import { CF_BKN, FOG_QW_MIN } from "../../clouds.js";

// Handbuch-Schwellen (Sicht in m, RH-Split in %) -- primäres Kriterium, s. o.
export const FG_VIS_MAX_M = 1000;
export const HAZE_VIS_MAX_M = 5000;
export const BR_HZ_RH_SPLIT = 80;

// Nur für den seltenen Fall ohne Sichtweitendaten (Priorität 4) -- reiner
// RH-Fallback wie in der ersten Fassung, entsprechend als `certain: false`
// markiert. Exportiert, damit render.js denselben Wert für die (seltene)
// Fallback-Rampe nutzt.
export const BR_RH_FALLBACK_MIN = 90;
export const HZ_RH_FALLBACK_MIN = 60;

const KELVIN = 273.15;

/** Kondensat (qw+qi, kg/kg) an einer Gitterzelle; NaN-Eingänge zählen als 0. */
function condensateAt(grid, ix) {
  return (grid.qw[ix] || 0) + (grid.qi[ix] || 0);
}

/**
 * Obergrenze (m AGL) der Schicht ab k=0, solange `getValue(ix) >= threshold`
 * hält — linear zur Schwelle interpoliert am ersten Unterschreiten (gleiches
 * Muster wie `crossHeight()` in `clouds.js`). Aufrufer garantiert, dass die
 * Schwelle bei k=0 bereits erreicht ist.
 */
function scanTop(grid, i, threshold, getValue) {
  const { nk } = grid;
  let top = null;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k;
    const v = getValue(ix);
    if (!Number.isFinite(v)) break;
    if (v >= threshold) { top = grid.z[ix]; continue; }
    if (top != null && k > 0) {
      const ix0 = ix - 1;
      const v0 = getValue(ix0), z0 = grid.z[ix0], z1 = grid.z[ix];
      top = v0 !== v ? z0 + (threshold - v0) / (v - v0) * (z1 - z0) : z0;
    }
    break;
  }
  return top;
}

/**
 * Klassifikation einer einzelnen Stunde. `cloudFrac` kommt von `derive.js`
 * (`d.cloudFrac`, dieselbe Größe wie Wolkenbasis/Cb/Vereisung) statt hier neu
 * berechnet zu werden.
 * @returns {{type: "FG"|"BR"|"HZ", top: number|null, certain: boolean, freezing: boolean} | null}
 */
export function classifyColumn(grid, cloudFrac, i) {
  const { nk } = grid;
  const ix0 = i * nk;
  const freezing = grid.T[ix0] - KELVIN <= 0;

  if (condensateAt(grid, ix0) > FOG_QW_MIN) {
    return { type: "FG", top: scanTop(grid, i, FOG_QW_MIN, (ix) => condensateAt(grid, ix)), certain: true, freezing };
  }
  if (cloudFrac[ix0] >= CF_BKN) {
    const certain = Number.isFinite(grid.clc[ix0]);
    return { type: "FG", top: scanTop(grid, i, CF_BKN, (ix) => cloudFrac[ix]), certain, freezing };
  }

  const vis = grid.surface?.visibility?.[i];
  const rh0 = grid.rh[ix0];
  if (Number.isFinite(vis)) {
    if (vis < FG_VIS_MAX_M) return { type: "FG", top: null, certain: true, freezing };
    if (vis <= HAZE_VIS_MAX_M) {
      const type = Number.isFinite(rh0) && rh0 >= BR_HZ_RH_SPLIT ? "BR" : "HZ";
      return { type, top: null, certain: true, freezing: false };
    }
    return null; // Sicht > HAZE_VIS_MAX_M -- gilt auch gegen einen widersprüchlichen wcode/RH (s. o.)
  }

  const wcode = grid.surface?.wcode?.[i];
  if (wcode === 45 || wcode === 48) {
    return { type: "FG", top: null, certain: false, freezing };
  }
  if (Number.isFinite(rh0) && rh0 >= BR_RH_FALLBACK_MIN) {
    return { type: "BR", top: null, certain: false, freezing: false };
  }
  if (Number.isFinite(rh0) && rh0 >= HZ_RH_FALLBACK_MIN) {
    return { type: "HZ", top: null, certain: false, freezing: false };
  }
  return null;
}

/** Klassifikation über den gesamten Zeitraum, ein Eintrag je Stunde. */
export function computeColumns(grid, cloudFrac) {
  const { times } = grid;
  const out = [];
  for (let i = 0; i < times.length; i++) out.push(classifyColumn(grid, cloudFrac, i));
  return out;
}

/**
 * Klassifikations-Eintrag → `metarWeather()`-Phänomen-Objekt
 * (`{fog, freezing, mist, haze}`, s. `briefing.js`).
 */
export function toPhenomenon(entry) {
  if (!entry) return null;
  return {
    fog: entry.type === "FG",
    mist: entry.type === "BR",
    haze: entry.type === "HZ",
    freezing: entry.freezing,
  };
}
