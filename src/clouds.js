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
