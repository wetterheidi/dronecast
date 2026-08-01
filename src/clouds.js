/**
 * Gemeinsames Wolkenmodul — Single Source of Truth für alle abgeleiteten
 * Wolkengrößen (Cross-Section-Heatmap, Meteogramm-Ceiling, Go/No-Go-Tabelle,
 * Briefing-METAR). Kern ist EINE höhenabhängige Wolkenfraktion `cloudFraction()`,
 * dreistufig nach bester verfügbarer Quelle (`cfAt`/`buildField` bündeln die
 * Eingänge je Level):
 *  1. `clc` (ICONs Modell-Bedeckungsgrad, direktes Level-Output von Michael) —
 *     wird 1:1 übernommen, wenn vorhanden.
 *  2. `qw`/`qi` (Wolkenwasser/-eis) — Kondensat-basiertes CF, wenn `clc` fehlt.
 *  3. Sonst der ursprüngliche Sundqvist-Fallback aus der Feuchte (q_v/RH):
 *     a. Feuchte-Referenz aus der spezifischen Feuchte q_v (prognostisch, ohne
 *        Referenz-Annahme): Dampfdruck e aus (q, p), daraus effektive RH über
 *        die Mischphase (Wasser→Eis, unter −35 °C reines Eis). Macht Cirren
 *        sichtbar. Fehlt q, Rückfall auf die Modell-RH (die unter 0 °C bereits
 *        eis-referenziert ist — per q-Validierung bestätigt).
 *     b. RH_crit: höhenabhängig (Grenzschicht niedriger, frei höher), im
 *        Eisast eis-referenziert abgesenkt, plus Vertikalwind-Modifikation
 *        (Aufwind senkt, Absinken hebt die kritische Feuchte).
 *     c. CF = Sundqvist(RH_eff, RH_crit).
 *  4. Vertikales Clustering → Schichten, Ceiling und unterste Basis (stufen-
 *     unabhängig, arbeitet nur auf der fertigen CF-Kurve).
 */

// --- Kalibrierung (Startwerte, später ggf. je Modell / an METAR) ------------
const RH_SAT = 100;          // % — Sättigung (in der jeweiligen Referenz) → CF = 1
const RH_CRIT_SURF = 72;     // % — kritische RH in der Grenzschicht (wasser-ref.)
const RH_CRIT_MID = 85;      // % — kritische RH in der freien Troposphäre (wasser-ref.)
const RH_CRIT_Z_REF = 1500;  // m AGL — Höhe, ab der RH_CRIT_MID gilt
const RH_CRIT_ICE = 72;      // % — kritische RH im Eisast (eis-referenziert)
const ICE_T_FULL = -35;      // °C — darunter reine Eisphase (RH_i)

// Vertikalwind-Dynamik (Punkt 3). PLATZHALTER — die Schwellen kalibriert der
// Nutzer separat: W_SCALE = w-Skala des tanh (m/s), CRIT_W_MAX = maximale
// crit-Absenkung/-Anhebung (%-Punkte).
const W_SCALE = 0.1;         // m/s
const CRIT_W_MAX = 8;        // %-Punkte

// Bedeckungsgrad-Schwellen (CF → Okta). BKN beginnt bei CF = 0.5 — dieselbe
// Schwelle wie die (ICAO-)Ceiling-Definition. FEW = unterste markante Schicht.
export const CF_FEW = 0.10, CF_SCT = 0.25, CF_BKN = 0.50, CF_OVC = 0.90;

// Bodennaher Dunst-/Nebel-Guard. In den untersten Z_SURF_M ist hohe RH meist
// nur optischer Dunst, keine Wolke → RH_crit dort auf RH_CRIT_SURF_GUARD
// anheben (RH < ~90 % ⇒ CF = 0). Gesättigte Schichten mit Basis < FOG_BASE_M
// berühren den Boden = Nebel: aus Wolken-Layern/Ceiling ausgenommen, getragen
// von der Modell-Sicht + weather_code (siehe METHODIK.md 4).
const Z_SURF_M = 150;            // m AGL — Dicke der bodennahen Dunstschicht
const RH_CRIT_SURF_GUARD = 90;   // % — Mindest-RH_crit direkt am Boden
const FOG_BASE_M = 30;           // m AGL — darunter gilt eine Basis als Nebel

// Kondensat-Schwelle für die QW/QI-Stufe (Stufe 2, s. u.): Skala für
// „nennenswerte" Wolkenwasser-/eis-Konzentration in kg/kg. PLATZHALTER — bis
// eine CLC-Kalibrierung vorliegt, an typischen Cirrus-/Stratus-Werten (~1e-5…
// 1e-4 kg/kg) orientiert.
const QCOND_SCALE = 1e-5; // kg/kg

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// --- Feuchte-Referenz (aus q_v, Eis-Korrektur) ------------------------------

const EPS = 0.622; // R_d/R_v — Molmassenverhältnis Wasserdampf/trockene Luft

/** Sättigungsdampfdruck über Wasser (hPa), Magnus/WMO. */
function esatWater(tC) { return 6.112 * Math.exp((17.62 * tC) / (243.12 + tC)); }
/** Sättigungsdampfdruck über Eis (hPa), WMO. */
function esatIce(tC) { return 6.112 * Math.exp((22.46 * tC) / (272.62 + tC)); }

/** Wasserdampf-Partialdruck (hPa) aus spezifischer Feuchte q (kg/kg) und
 *  Luftdruck p (hPa): `e = q·p / (ε + q·(1−ε))`. */
export function vaporPressure(qKgKg, pHpa) {
  if (!Number.isFinite(qKgKg) || !Number.isFinite(pHpa) || qKgKg <= 0) return NaN;
  return (qKgKg * pHpa) / (EPS + qKgKg * (1 - EPS));
}

/** Eisanteil der Mischphase: 0 bei ≥ 0 °C (nur Wasser), 1 bei ≤ −35 °C (nur
 *  Eis), linear dazwischen. */
export function iceFraction(tC) {
  if (!Number.isFinite(tC) || tC >= 0) return 0;
  return clamp((0 - tC) / (0 - ICE_T_FULL), 0, 1);
}

/**
 * Effektive relative Feuchte (%) als Wolken-Referenz — vorzugsweise aus der
 * spezifischen Feuchte q_v (prognostisch, ohne Referenz-Annahme): Dampfdruck e
 * aus (q, p), bezogen auf einen über die Mischphase geblendeten Sättigungsdampf-
 * druck (Wasser→Eis, stetig, bei α = 1 reines Eis). Fehlt q, Rückfall auf die
 * modellseitige RH `rhModel` (die unter 0 °C bereits eis-referenziert ist — per
 * q-Validierung an Michaels Instanz bestätigt), OHNE zusätzlichen Boost, damit
 * nicht doppelt korrigiert wird.
 * @param hum { q?: kg/kg, p?: hPa, rh?: % } — Feuchte-Eingänge des Levels
 */
export function effectiveRH(hum, tC) {
  const e = vaporPressure(hum?.q, hum?.p);
  if (!Number.isFinite(e) || !Number.isFinite(tC)) {
    return Number.isFinite(hum?.rh) ? hum.rh : NaN; // Fallback: Modell-RH roh
  }
  const a = iceFraction(tC);
  const eMix = (1 - a) * esatWater(tC) + a * esatIce(tC);
  return eMix > 0 ? 100 * e / eMix : NaN;
}

// --- kritische Feuchte + Wolkenfraktion -------------------------------------

/** Wasser-referenzierte kritische RH (%) nach Höhe: RH_CRIT_SURF am Boden,
 *  linear auf RH_CRIT_MID bei RH_CRIT_Z_REF, darüber konstant. */
function critWarm(zAgl) {
  const z = Number.isFinite(zAgl) ? Math.max(0, zAgl) : 0;
  return RH_CRIT_SURF + (RH_CRIT_MID - RH_CRIT_SURF) * Math.min(1, z / RH_CRIT_Z_REF);
}

/**
 * Kritische relative Feuchte (%) für die Wolkenbildung auf Höhe z, in DERSELBEN
 * Referenz wie `effectiveRH` (im Eisast eis-referenziert). Die Eisabsenkung
 * folgt der Temperatur (α = `iceFraction`), nicht einer festen Höhe — greift
 * daher im Winter korrekt schon tiefer. Vertikalwind `w` (m/s, positiv aufwärts)
 * senkt (Aufwind) bzw. hebt (Absinken) die Schwelle.
 */
export function criticalRH(zAgl, tC, w) {
  const a = iceFraction(tC);
  let crit = (1 - a) * critWarm(zAgl) + a * RH_CRIT_ICE;
  // Bodennaher Dunst-Guard: RH_crit von RH_CRIT_SURF_GUARD am Boden linear auf
  // das normale Profil bei Z_SURF_M — bodennah erst nahe Sättigung „Wolke",
  // sonst nur optischer Dunst (verhindert Phantom-„Cloud 0 m").
  const z = Number.isFinite(zAgl) ? Math.max(0, zAgl) : 0;
  if (z < Z_SURF_M) {
    const guard = RH_CRIT_SURF_GUARD + (critWarm(Z_SURF_M) - RH_CRIT_SURF_GUARD) * (z / Z_SURF_M);
    crit = Math.max(crit, guard);
  }
  if (Number.isFinite(w)) crit -= CRIT_W_MAX * Math.tanh(w / W_SCALE);
  return crit;
}

/**
 * Wolkenfraktion 0…1 eines Levels, dreistufig — beste verfügbare Quelle:
 *  1. `clc` (Modell-Bedeckungsgrad, % — Michaels direktes Level-Output):
 *     `CF = clc / 100`. ICONs eigene Diagnose inkl. Subskalen-Bewölkung,
 *     schlägt jede Feuchte-Heuristik — wird 1:1 übernommen.
 *  2. `qw`/`qi` (Wolkenwasser/-eis, kg/kg, ohne `clc`): `CF` aus dem
 *     Kondensatgehalt (`1 − exp(−(qw+qi)/QCOND_SCALE)`) — gröber als CLC
 *     (Grid-Mittel, keine Subskalen-Wolken), aber physikalisch direkter als
 *     die RH-Schätzung.
 *  3. Sonst Sundqvist-Fallback (Startkalibrierung, unverändert): `hum`
 *     bündelt die Feuchte-Eingänge ({ q, p, t, rh }); q_v ist die bevorzugte
 *     Basis (siehe `effectiveRH`), t die Temperatur (°C). Feuchte-Referenz/
 *     Eis-Korrektur (1), phasen-/windabhängiges RH_crit (2), Sundqvist (3).
 * z in m AGL, w optional (m/s, nur für Stufe 3 relevant).
 */
export function cloudFraction(hum, zAgl, w) {
  if (Number.isFinite(hum?.clc)) return clamp(hum.clc / 100, 0, 1);
  const qCond = (hum?.qw || 0) + (hum?.qi || 0);
  if (Number.isFinite(hum?.qw) || Number.isFinite(hum?.qi)) {
    return clamp(1 - Math.exp(-qCond / QCOND_SCALE), 0, 1);
  }
  const tC = hum?.t;
  const rhEff = effectiveRH(hum, tC);
  if (!Number.isFinite(rhEff)) return 0;
  const rhc = criticalRH(zAgl, tC, w);
  if (rhEff <= rhc || rhc >= RH_SAT) return 0;
  const cf = 1 - Math.sqrt(Math.max(0, (RH_SAT - rhEff) / (RH_SAT - rhc)));
  return clamp(cf, 0, 1);
}

/** Okta-nahe Bedeckungskategorie aus einer Wolkenfraktion, oder null (< FEW). */
export function oktaCategory(cf) {
  if (!Number.isFinite(cf) || cf < CF_FEW) return null;
  if (cf < CF_SCT) return "FEW";
  if (cf < CF_BKN) return "SCT";
  if (cf < CF_OVC) return "BKN";
  return "OVC";
}

// CF eines Levels aus der Säule (bündelt den Zugriff auf q/p/T/RH sowie die
// optionalen Stufe-1/2-Felder qw/qi/clc und w).
function cfAt(col, k, i) {
  const hum = {
    q: col.q?.[k]?.[i], p: col.p?.[k]?.[i], t: col.t?.[k]?.[i], rh: col.rh?.[k]?.[i],
    qw: col.qw?.[k]?.[i], qi: col.qi?.[k]?.[i], clc: col.clc?.[k]?.[i],
  };
  return cloudFraction(hum, col.h[k][i], col.w?.[k]?.[i]);
}
// Höhe, in der CF (linear zwischen zwei Leveln) den Schwellwert kreuzt.
function crossHeight(h0, cf0, h1, cf1, thr) {
  if (cf1 === cf0) return h0;
  return h0 + (thr - cf0) / (cf1 - cf0) * (h1 - h0);
}

// --- Ceiling / Basis / Schichten --------------------------------------------

/**
 * Unterste Höhe (m AGL) ≥ `minBaseM`, an der die Wolkenfraktion `thr` von unten
 * erreicht — über das GESAMTE Profil interpoliert, oder null. Kein harter
 * Höhen-Cutoff (ICAO-konform); `minBaseM` überspringt eine bodenberührende
 * (Nebel-)Schicht und sucht die nächste Schicht darüber.
 */
function lowestCrossing(col, i, thr, minBaseM = 0) {
  let prevH = null, prevCf = null;
  for (let k = 0; k < col.nLevels; k++) {
    const h = col.h[k][i];
    if (!Number.isFinite(h)) continue;
    const cf = cfAt(col, k, i);
    if (cf >= thr && prevCf != null && prevCf < thr && prevH != null) {
      const base = crossHeight(prevH, prevCf, h, cf, thr);
      if (base >= minBaseM) return base;        // sonst: Nebel überspringen, weiter suchen
    } else if (cf >= thr && prevCf == null && h >= minBaseM) {
      return h; // unterstes Level bereits gesättigt und über der Nebel-Grenze
    }
    prevH = h; prevCf = cf;
  }
  return null;
}

/**
 * Operationelles Ceiling (ICAO) zur Stunde `i`: unterste Höhe im gesamten
 * Profil mit `CF ≥ CF_BKN` (BKN/OVC), ohne Höhen-Cutoff. `cloud_cover_low`
 * (`ccLowPct`) gatet NICHT, sondern liefert nur die Konfidenz. null, wenn
 * nirgends BKN erreicht wird.
 * @returns {{ baseM: number, confident: boolean } | null}
 */
export function cloudCeiling(col, i, { coverThresh = CF_BKN, ccLowPct = null } = {}) {
  const baseM = lowestCrossing(col, i, coverThresh, FOG_BASE_M);
  if (baseM == null) return null;
  return { baseM, confident: Number.isFinite(ccLowPct) && ccLowPct > 50 };
}

/**
 * Untergrenze der untersten markanten Wolkenschicht (m AGL): unterstes
 * `CF ≥ CF_FEW` im Profil (auch FEW/SCT), über der Nebel-Grenze — für
 * Situationsbild/Briefing. null, wenn das Profil praktisch wolkenfrei ist.
 */
export function lowestCloudBase(col, i) {
  return lowestCrossing(col, i, CF_FEW, FOG_BASE_M);
}

/**
 * Wolkenschichten zur Stunde `i` als METAR-nahe Liste `{ baseM, cover, cf }`
 * von unten nach oben. Eine Schicht ist ein zusammenhängender Levelblock mit
 * `CF ≥ CF_FEW`; Basis = interpolierte Höhe des Schwellenübertritts, Bedeckung =
 * CF-Maximum im Block. Bis `capM` (12 km, damit auch Cirrus erscheint),
 * höchstens `maxLayers` (die untersten) — OHNE „nur zunehmende Bedeckung"-
 * Filter, damit eine dünnere hohe Schicht über einer tieferen nicht verschluckt
 * wird.
 */
export function cloudLayers(col, i, { capM = 12000, maxLayers = 4 } = {}) {
  const layers = [];
  // Bodenberührende Schichten (Basis < FOG_BASE_M) sind Nebel, keine gemeldete
  // Wolkenschicht — sie tragen die Sicht/weather_code, nicht die Wolken-Spalte.
  const push = (baseM, cf) => { if (baseM >= FOG_BASE_M) layers.push({ baseM, cover: oktaCategory(cf), cf }); };
  let inLayer = false, baseM = null, maxCf = 0, prevH = null, prevCf = null;
  for (let k = 0; k < col.nLevels; k++) {
    const h = col.h[k][i];
    if (!Number.isFinite(h)) continue;
    if (h > capM) break;
    const cf = cfAt(col, k, i);
    if (cf >= CF_FEW) {
      if (!inLayer) {
        baseM = (prevCf != null && prevCf < CF_FEW && prevH != null)
          ? crossHeight(prevH, prevCf, h, cf, CF_FEW) : h;
        inLayer = true; maxCf = cf;
      } else if (cf > maxCf) { maxCf = cf; }
    } else if (inLayer) {
      push(baseM, maxCf);
      inLayer = false;
      if (layers.length >= maxLayers) return layers;
    }
    prevH = h; prevCf = cf;
  }
  if (inLayer) push(baseM, maxCf);
  return layers.slice(0, maxLayers);
}

// --- LCL-Fallback (Bodenpaket) ---------------------------------------------

/** Wolkenbasis nach Espy (m AGL) aus 2-m-Feldern, oder null bei fehlender
 *  tiefer Bewölkung (`cloud_cover_low < 25 %`). Reine Bodenpaket-Näherung —
 *  Fallback, wenn keine Modell-Säule vorliegt. */
export function cloudBaseAgl(tC, tdC, ccLowPct) {
  const cc = ccLowPct ?? 0;
  if (cc < 25 || !Number.isFinite(tC) || !Number.isFinite(tdC)) return null;
  return Math.max(0, 125 * (tC - tdC));
}

// --- Bedeckungsgrad nach Stockwerk (Kartenlayer) ----------------------------

// Grenzen tief/mittel/hoch (m AGL) — Startwerte nach gängiger synoptischer
// Konvention (tief < 2 km, hoch > 6,5 km), noch nicht an METAR validiert.
export const CLOUD_BAND_LOW_MAX_M = 2000;
export const CLOUD_BAND_HIGH_MIN_M = 6500;

/**
 * Bedeckungsgrad je Stockwerk (tief/mittel/hoch, CF 0…1) zur Stunde `i` —
 * für die flächige Kartendarstellung (Graustufen je Stockwerk). Baut auf
 * `cloudLayers()` auf (SINGLE SOURCE OF TRUTH, s. o.): je Stockwerk das
 * CF-Maximum ALLER dort liegenden Schichten. `maxLayers` bewusst groß, damit
 * eine hohe Schicht nicht von mehreren tieferen aus der Liste verdrängt wird
 * (anders als das METAR-nahe `cloudLayers()`-Default `maxLayers=4`).
 */
export function bandCoverage(col, i, { capM = 12000 } = {}) {
  const layers = cloudLayers(col, i, { capM, maxLayers: 20 });
  let low = 0, mid = 0, high = 0;
  for (const l of layers) {
    if (l.baseM < CLOUD_BAND_LOW_MAX_M) low = Math.max(low, l.cf);
    else if (l.baseM < CLOUD_BAND_HIGH_MIN_M) mid = Math.max(mid, l.cf);
    else high = Math.max(high, l.cf);
  }
  return { low, mid, high };
}

/**
 * Kombiniert Modell-Ceiling und LCL-Fallback für die Meteogramm-Wolkenbasis.
 * Liegt ein Modell-Ceiling (`rhCeilingM`, aus `cloudCeiling`) vor, bestimmt DAS
 * die Höhe — `cloud_cover_low` gatet das NICHT, sondern liefert nur die
 * Konfidenz (> 50 % → durchgezogene statt gestrichelter Linie). Fehlt es, greift
 * die LCL-Schätzung. null, wenn beides fehlt.
 */
export function refineCloudBase(tC, tdC, ccLowPct, rhCeilingM) {
  if (Number.isFinite(rhCeilingM)) {
    return { baseM: rhCeilingM, confident: (ccLowPct ?? 0) > 50 };
  }
  const lcl = cloudBaseAgl(tC, tdC, ccLowPct);
  if (lcl == null) return null;
  return { baseM: lcl, confident: false };
}
