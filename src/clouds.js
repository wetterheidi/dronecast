/**
 * Gemeinsames Wolkenmodul — Single Source of Truth für alle abgeleiteten
 * Wolkengrößen (Cross-Section-Heatmap, Meteogramm-Ceiling, Go/No-Go-Tabelle,
 * Briefing-METAR). Kern ist EINE höhenabhängige Wolkenfraktions-Kurve
 * (Sundqvist-Typ) statt bisher dreier driftender fester RH-Schwellen.
 *
 * Physik: Wolke bildet sich nicht erst bei 100 % RH, sondern ab einer
 * KRITISCHEN Feuchte RH_crit(z) — in der Grenzschicht niedriger (Subskalen-
 * Variabilität), in der freien Troposphäre höher. Die Wolkenfraktion steigt
 * von RH_crit bis Sättigung von 0 auf 1.
 */

// --- Kalibrierung (Startwerte, später ggf. je Modell) -----------------------
const RH_SAT = 100;          // % — Sättigung → CF = 1
const RH_CRIT_SURF = 70;     // % — kritische RH am Boden
const RH_CRIT_TOP = 90;      // % — kritische RH in der Höhe
const RH_CRIT_Z_REF = 3000;  // m AGL — ab hier gilt RH_CRIT_TOP

// Bedeckungsgrad-Schwellen (CF → Okta-Kategorie). BKN beginnt bei CF = 0.5 —
// dieselbe Schwelle, die die Ceiling-/Wolkenuntergrenzen-Definition nutzt
// (Luftfahrt-Konvention: „Ceiling" = unterste BKN/OVC-Schicht).
export const CF_FEW = 0.10, CF_SCT = 0.25, CF_BKN = 0.50, CF_OVC = 0.90;

/** Höhenabhängige kritische relative Feuchte (%), linear von RH_CRIT_SURF am
 *  Boden auf RH_CRIT_TOP bei RH_CRIT_Z_REF, darüber konstant. */
export function criticalRH(zAgl) {
  const z = Number.isFinite(zAgl) ? Math.max(0, zAgl) : 0;
  const f = Math.min(1, z / RH_CRIT_Z_REF);
  return RH_CRIT_SURF + (RH_CRIT_TOP - RH_CRIT_SURF) * f;
}

/** Wolkenfraktion 0…1 aus relativer Feuchte (%) auf Höhe z (m AGL), Sundqvist:
 *  `CF = 1 − √(max(0, (RH_sat − RH)/(RH_sat − RH_crit(z))))`. 0 unterhalb der
 *  kritischen Feuchte, 1 bei/über Sättigung. */
export function cloudFraction(rh, zAgl) {
  if (!Number.isFinite(rh)) return 0;
  const rhc = criticalRH(zAgl);
  if (rh <= rhc) return 0;
  const cf = 1 - Math.sqrt(Math.max(0, (RH_SAT - rh) / (RH_SAT - rhc)));
  return Math.max(0, Math.min(1, cf));
}

/** Okta-nahe Bedeckungskategorie aus einer Wolkenfraktion, oder null (< FEW,
 *  praktisch wolkenfrei). METAR-Referenz: FEW 1–2/8 · SCT 3–4/8 · BKN 5–7/8 ·
 *  OVC 8/8. */
export function oktaCategory(cf) {
  if (!Number.isFinite(cf) || cf < CF_FEW) return null;
  if (cf < CF_SCT) return "FEW";
  if (cf < CF_BKN) return "SCT";
  if (cf < CF_OVC) return "BKN";
  return "OVC";
}

/**
 * Wolkenschichten zur Stunde `i` aus dem Modell-RH-Profil (native Level), als
 * METAR-nahe Liste `{ baseM, cover, cf }` von unten nach oben. Eine Schicht ist
 * ein zusammenhängender Levelblock mit `CF ≥ CF_FEW`; ihre Basis ist die
 * (zwischen Leveln interpolierte) Höhe, an der CF diese Schwelle von unten
 * erreicht, ihre Bedeckung das CF-Maximum im Block. Bis `capM` (Standard 12 km,
 * damit auch hohe Bewölkung/Cirrus erscheint), höchstens `maxLayers` (die
 * untersten) — anders als früher OHNE „nur zunehmende Bedeckung"-Filter, damit
 * eine weniger bedeckte mittelhohe/hohe Schicht über einer tieferen nicht
 * verschluckt wird.
 */
export function cloudLayers(col, i, { capM = 12000, maxLayers = 4 } = {}) {
  const layers = [];
  let inLayer = false, baseM = null, maxCf = 0, prevH = null, prevCf = null;
  for (let k = 0; k < col.nLevels; k++) {
    const h = col.h[k][i];
    if (!Number.isFinite(h)) continue;
    if (h > capM) break;
    const cf = cloudFraction(col.rh[k][i], h);
    if (cf >= CF_FEW) {
      if (!inLayer) {
        baseM = (prevCf != null && prevCf < CF_FEW && prevH != null)
          ? crossHeight(prevH, prevCf, h, cf, CF_FEW) : h;
        inLayer = true; maxCf = cf;
      } else if (cf > maxCf) { maxCf = cf; }
    } else if (inLayer) {
      layers.push({ baseM, cover: oktaCategory(maxCf), cf: maxCf });
      inLayer = false;
      if (layers.length >= maxLayers) return layers;
    }
    prevH = h; prevCf = cf;
  }
  if (inLayer) layers.push({ baseM, cover: oktaCategory(maxCf), cf: maxCf });
  return layers.slice(0, maxLayers);
}

/**
 * Wolkenuntergrenze/Ceiling (m AGL) zur Stunde `i`: unterste Höhe, an der die
 * Wolkenfraktion die BKN-Schwelle (Standard `coverThresh = CF_BKN = 0.5`)
 * erreicht — begrenzt auf das Low-Band (`capM`), um nicht eine Mittel-/
 * Hochwolke als tiefe Basis zu melden. Abgeleitet aus derselben CF-Kurve wie
 * Cross-Section und Briefing. `cloud_cover_low` (`ccLowPct`) gatet die Existenz
 * NICHT, sondern erhöht nur die Konfidenz (`confident`). Rückgabe `null`, wenn
 * im Band keine BKN-Schicht liegt.
 * @returns {{ baseM: number, cover: string, confident: boolean } | null}
 */
export function cloudCeiling(col, i, { coverThresh = CF_BKN, capM = 3000, ccLowPct = null } = {}) {
  let prevH = null, prevCf = null;
  for (let k = 0; k < col.nLevels; k++) {
    const h = col.h[k][i];
    if (!Number.isFinite(h)) continue;
    if (h > capM) break;
    const cf = cloudFraction(col.rh[k][i], h);
    if (cf >= coverThresh) {
      const baseM = (prevCf != null && prevCf < coverThresh && prevH != null)
        ? crossHeight(prevH, prevCf, h, cf, coverThresh) : h;
      return { baseM, cover: oktaCategory(cf), confident: Number.isFinite(ccLowPct) && ccLowPct > 50 };
    }
    prevH = h; prevCf = cf;
  }
  return null;
}

// Höhe, in der CF (linear zwischen zwei Leveln) den Schwellwert kreuzt.
function crossHeight(h0, cf0, h1, cf1, thr) {
  if (cf1 === cf0) return h0;
  return h0 + (thr - cf0) / (cf1 - cf0) * (h1 - h0);
}

// --- LCL-Fallback (Bodenpaket) ---------------------------------------------

/** Wolkenbasis nach Espy (m AGL) aus 2-m-Feldern, oder null bei fehlender
 *  tiefer Bewölkung (`cloud_cover_low < 25 %`) bzw. fehlenden Daten. Reine
 *  Bodenpaket-Näherung — Fallback, wenn keine Modell-Säule vorliegt. */
export function cloudBaseAgl(tC, tdC, ccLowPct) {
  const cc = ccLowPct ?? 0;
  if (cc < 25 || !Number.isFinite(tC) || !Number.isFinite(tdC)) return null;
  return Math.max(0, 125 * (tC - tdC));
}

/**
 * Kombiniert Modell-Ceiling und LCL-Fallback für die Meteogramm-Wolkenbasis.
 * Liegt ein Modell-Ceiling (`rhCeilingM`, aus `cloudCeiling`) vor, bestimmt DER
 * die Höhe — `cloud_cover_low` gatet das NICHT mehr, sondern liefert nur die
 * Konfidenz (`confident`, > 50 % → durchgezogene statt gestrichelter Linie).
 * Fehlt ein Modell-Ceiling, fällt es auf die reine LCL-Schätzung zurück (die
 * ihrerseits tiefe Bewölkung als Trigger braucht). null, wenn beides fehlt.
 */
export function refineCloudBase(tC, tdC, ccLowPct, rhCeilingM) {
  if (Number.isFinite(rhCeilingM)) {
    return { baseM: rhCeilingM, confident: (ccLowPct ?? 0) > 50 };
  }
  const lcl = cloudBaseAgl(tC, tdC, ccLowPct);
  if (lcl == null) return null;
  return { baseM: lcl, confident: false };
}
