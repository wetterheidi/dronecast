/**
 * Vereisungs-Diagnose — Stub. Liefert aktuell überall "none"; die Eingangs-
 * größen (Wolkenfraktion, Temperatur, RH) liegen aus `grid.js`/`derive()`
 * bereits bereit, sobald der Algorithmus ausgearbeitet ist.
 */
export function computeGrid(grid) {
  const n = grid.times.length * grid.nk;
  return new Array(n).fill("none");
}
