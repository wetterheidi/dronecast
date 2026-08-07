/**
 * Boden-Nebel/Dunst-Diagnose (FG/BR/HZ) — ein SPALTEN-Phänomen (eine
 * Klassifikation + eine Obergrenze pro Stunde), anders als Vereisung/
 * Turbulenz kein Zellwert. Ausgabeform folgt darum `cbColumns()` in
 * `derive.js` (Array `{...} | null`, ein Eintrag je Stunde), NICHT
 * `icing.computeGrid()`.
 *
 * WICHTIGE EINSCHRÄNKUNG: Open-Meteo/ICON liefert über `weather_code` keine
 * Dunst-/Diesigkeits-Codes (WMO 05/10 — die WMO_TO_TAF-Tabelle in
 * `briefing.js` bildet nur 0…3 → NSW ab). Modelle diagnostizieren keinen
 * Aerosol-Dunst. Der WW-Code kann daher NUR für FG (45/48) als Fallback-
 * Signal dienen, nie für BR/HZ — die kommen ausschließlich aus RH, ohne
 * Cross-Check. Entsprechend niedriger die Konfidenz (`certain`) dort.
 *
 * Priorität je Stunde, jeweils NUR wenn das unterste Level (k=0, ~10 m AGL)
 * den Schwellwert erreicht (Bodenkontakt-Pflicht — sonst würde erhöhter
 * Nebel/erhöhte Feuchte fälschlich als Bodenphänomen gezeigt):
 *
 *  1. Kondensat direkt (qw+qi > FOG_QW_MIN, mirrors `groundFog()` aus
 *     `clouds.js`, hier grid-nativ statt Column-Objekt, da `grid.qw`/`qi`
 *     ohnehin schon flache Arrays sind) → FG, sicher — stärkstes
 *     physikalisches Signal.
 *  2. `cloudFrac >= CF_BKN` → FG; sicher nur, wenn CLC (Tier 1 der
 *     `cloudFraction()`-Kaskade) das trägt — kommt der Wert stattdessen aus
 *     dem RH-Sundqvist-Fallback (Tier 3; der bodennahe Dunst-Guard ist unter
 *     der aktuellen Kalibrierung laut `clouds.js` FAKTISCH INAKTIV), gilt das
 *     als unsicher.
 *  3. `weather_code` 45/48 → FG, unsicher, KEINE Obergrenze (mirrors den
 *     bestehenden `groundFog()`+`metarWeather()`-Fallback: der WW-Code
 *     erzwingt keine Höhenaussage).
 *  4. RH ≥ BR_RH_MIN → BR, sicher (RH ist ein echtes Modellfeld, kein
 *     Fallback).
 *  5. RH ≥ HZ_RH_MIN → HZ, IMMER unsicher, IMMER ohne Obergrenze — Dunst ist
 *     aerosolbedingt, dafür lässt sich aus RH keine physikalische
 *     Obergrenze herleiten (eine PBL-Höhe wäre nur eine grobe Näherung und
 *     bräuchte einen neuen Datenfetch — bewusst weggelassen).
 *  6. sonst kein Befund (`null`).
 *
 * BR_RH_MIN/HZ_RH_MIN sind wie an anderer Stelle im Wolkenmodul PLATZHALTER,
 * unvalidiert — rein plausibel gewählt, keine Kalibrierung gegen echte
 * Beobachtungen (s. METHODIK.md-Vorbehalte in clouds.js).
 */

import { CF_BKN, FOG_QW_MIN } from "../../clouds.js";

// Exportiert, damit der Dunst-Schleier in render.js (BR/HZ, s. dort) exakt
// an derselben Schwelle einsetzt wie das Label -- sonst könnten Visual und
// Klassifikation leise auseinanderlaufen.
export const BR_RH_MIN = 90; // % — Boden-RH, ab der Sicht auf Diesigkeitsniveau sinkt
export const HZ_RH_MIN = 60; // % — Boden-RH, ab der überhaupt von Dunst die Rede sein kann

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
  const wcode = grid.surface?.wcode?.[i];
  if (wcode === 45 || wcode === 48) {
    return { type: "FG", top: null, certain: false, freezing };
  }
  const rh0 = grid.rh[ix0];
  if (Number.isFinite(rh0) && rh0 >= BR_RH_MIN) {
    return { type: "BR", top: scanTop(grid, i, BR_RH_MIN, (ix) => grid.rh[ix]), certain: true, freezing: false };
  }
  if (Number.isFinite(rh0) && rh0 >= HZ_RH_MIN) {
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
