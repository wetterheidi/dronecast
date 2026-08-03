/**
 * Turbulenz-Diagnose — Stub. Liefert aktuell überall "none"; Scherung/
 * Stabilität (shear2, N2, Ri) stehen aus `derive(grid)` bereit, sobald der
 * Algorithmus ausgearbeitet ist.
 */
export function computeGrid(grid) {
  const n = grid.times.length * grid.nk;
  return new Array(n).fill("none");
}
