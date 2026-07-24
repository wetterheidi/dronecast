/**
 * Wolkenbasis-Heuristik, gemeinsam genutzt von Meteogramm und Go/No-Go-
 * Tabelle. LCL nach Espy: 125·(T−Td) m AGL. Nur TIEFE Bewölkung
 * (cloud_cover_low) triggert eine Basis — mittel/hohe Bewölkung hat hier
 * keine verlässliche Höheninformation aus den Bodenfeldern.
 */

/** Wolkenbasis (m AGL) oder null, wenn keine relevante tiefe Bewölkung
 *  vorliegt (< 25 % Bedeckung) bzw. Eingangsdaten fehlen. */
export function cloudBaseAgl(tC, tdC, ccLowPct) {
  const cc = ccLowPct ?? 0;
  if (cc < 25 || !Number.isFinite(tC) || !Number.isFinite(tdC)) return null;
  return Math.max(0, 125 * (tC - tdC));
}

/**
 * Verfeinert die LCL-Schätzung mit dem Modell-Feuchteprofil (siehe
 * column.js, lowestSaturatedHeight): cloud_cover_low bleibt der Trigger
 * (fängt Subskalen-Effekte ab, die reine RH verpasst) — existiert eine
 * gesättigte tiefe Schicht, ersetzt deren Höhe die LCL-Schätzung.
 * `confident: true`, wenn beide Signale übereinstimmen (Bedeckung > 50 %
 * UND eine gesättigte Schicht gefunden) — sonst nur ein Signal vorhanden.
 * Rückgabe null, wenn der Trigger (cloud_cover_low ≥ 25 %) nicht erfüllt ist.
 */
export function refineCloudBase(tC, tdC, ccLowPct, rhCeilingM) {
  const lcl = cloudBaseAgl(tC, tdC, ccLowPct);
  if (lcl == null) return null;
  const baseM = rhCeilingM ?? lcl;
  const confident = (ccLowPct ?? 0) > 50 && rhCeilingM != null;
  return { baseM, confident };
}
