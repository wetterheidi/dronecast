/**
 * Turbulenz-Diagnose — Turbulence-Flag-Index (TFI) = g(Ri) · s(|dV/dz|),
 * pro Zelle. Deckt bewusst NUR das Flugband oberhalb 10 m ab (dynamische +
 * thermische Instabilität aus Scherung/Stabilität, `grid.js` `derive()`
 * liefert `shear2`/`n2`/`ri` bereits pro Modellschicht) -- Bodenböigkeit ist
 * schon durch die Böen-Zeile (gonogo.js) und das Böen-Overlay abgedeckt,
 * beide bewusst nicht auf Flughöhe hochgerechnet (s. METHODIK.md "Böen").
 * Eine reine Böen-Neuverpackung als Turbulenz-Zeile wäre Doppelung; der
 * Mehrwert liegt genau oberhalb 10 m, wo es laut METHODIK.md keine Böen auf
 * Modell-Leveln gibt.
 *
 * g(Ri): 1 für Ri <= 0,25 (Miles-Howard-Schwelle, Kelvin-Helmholtz-Instabil-
 * ität), linear auf 0 bei Ri >= 1,0 (darüber gilt Turbulenz als zunehmend
 * unwahrscheinlich). Ri < 0 (dθ/dz < 0, Tagesthermik/labile Schichtung)
 * fällt automatisch in den "<= 0,25"-Zweig -- ein Index deckt damit
 * mechanische UND thermische Turbulenz ab, ohne zwei getrennte Diagnosen.
 *
 * s(|dV/dz|): Scher-Gate. Ri ist ein Verhältnis und wird numerisch instabil,
 * wenn die Scherung gegen 0 geht (dann ist meist auch dθ/dz klein, Ri
 * "springt") -- `grid.js` `derive()` fängt die reine Division bereits ab
 * (`ri = NaN` bei `shear2 <= 1e-8`), das ersetzt aber NICHT das physikalische
 * Gate hier: eine völlig ruhige, schwach stabile Schicht braucht trotzdem
 * eine explizite Ausblendung, sonst flaggt sie als Turbulenz. 0 unterhalb
 * ~0,02 s⁻¹ (≈ 2 m/s je 100 m), linear auf 1 ab ~0,05 s⁻¹ -- nur dynamisch
 * signifikante Schichten zählen. Das Gate wird VOR `g(Ri)` ausgewertet und
 * bei 0 sofort zurückgegeben: sonst würde `g(NaN) * 0 = NaN` statt 0
 * herauskommen, wenn `ri` wegen der Division-durch-~0-Absicherung NaN ist
 * (genau der Fall, den das Gate eigentlich abfangen soll).
 *
 * Schwellen (Ri-Fenster wie TFI-Kategorien) NICHT kalibriert -- Platzhalter
 * wie an anderer Stelle im Modul, s. METHODIK.md.
 */

const RI_CRIT = 0.25;   // Miles-Howard-Schwelle -- g(Ri) = 1 bis hierhin (inkl. Ri < 0)
const RI_MAX = 1.0;     // ab hier g(Ri) = 0

const SHEAR_GATE_LO = 0.02; // s^-1 -- s() = 0 unterhalb
const SHEAR_GATE_HI = 0.05; // s^-1 -- s() = 1 ab hier

// Gemeinsame Kategorie-Schwellen für alle Verbraucher (GRAMET, Go/No-Go).
// "light" ist ein weicherer Karten-Onset (analog Vereisung), kollabiert in
// `tfiStatus` in "green" -- Go/No-Go kennt keine Ampelfarbe für "Spur von
// Turbulenz".
const TFI_LIGHT = 0.15, TFI_MODERATE = 0.30, TFI_SEVERE = 0.60;

function sShear(shear2) {
  if (!Number.isFinite(shear2)) return 0;
  const shear = Math.sqrt(shear2);
  if (shear <= SHEAR_GATE_LO) return 0;
  if (shear >= SHEAR_GATE_HI) return 1;
  return (shear - SHEAR_GATE_LO) / (SHEAR_GATE_HI - SHEAR_GATE_LO);
}

function gRi(ri) {
  if (!Number.isFinite(ri)) return 0;
  if (ri <= RI_CRIT) return 1;
  if (ri >= RI_MAX) return 0;
  return (RI_MAX - ri) / (RI_MAX - RI_CRIT);
}

/**
 * Turbulence-Flag-Index (0..1) einer Schicht -- reine Funktion von Ri und
 * Scherquadrat (beide aus `grid.js` `derive()`), unabhängig von Grid/
 * Zeitachse/Rendering. Scher-Gate zuerst (s. Modulkopf) -- vermeidet
 * `NaN * 0` bei der Ri-Divisionsschutz-NaN.
 */
export function tfiAt(ri, shear2) {
  const s = sShear(shear2);
  if (s === 0) return 0;
  return gRi(ri) * s;
}

/** TFI (0..1) -> Kategorie, gemeinsame Schwellen für alle Verbraucher. */
export function tfiCategory(tfi) {
  if (!Number.isFinite(tfi) || tfi < TFI_LIGHT) return "none";
  if (tfi < TFI_MODERATE) return "light";
  if (tfi < TFI_SEVERE) return "moderate";
  return "severe";
}

/**
 * Untere TFI-Schwelle der Kategorie von `tfi` -- 0 bei "none" (kein
 * Turbulenzband). Für Go/No-Go: die Höhengrenzen des Bands der stärksten
 * Turbulenz sind dort definiert, wo der TFI diese Schwelle kreuzt (analog
 * `ipiCategoryFloor` in icing.js), s. `turbulenceBandMaxAt` in app.js.
 */
export function tfiCategoryFloor(tfi) {
  const cat = tfiCategory(tfi);
  if (cat === "severe") return TFI_SEVERE;
  if (cat === "moderate") return TFI_MODERATE;
  if (cat === "light") return TFI_LIGHT;
  return 0;
}

/**
 * TFI (0..1) -> Go/No-Go-Ampel (green/yellow/red), s. gonogo.js. Dieselben
 * Schwellen wie `tfiCategory` (TFI_MODERATE/TFI_SEVERE) -- nur auf drei statt
 * vier Stufen zusammengefasst (none/light -> green), analog `ipiStatus` in
 * icing.js.
 */
export function tfiStatus(tfi) {
  if (!Number.isFinite(tfi) || tfi < TFI_MODERATE) return "green";
  if (tfi < TFI_SEVERE) return "yellow";
  return "red";
}

/**
 * Pro Gitterzelle (nt*nk) die Hazard-Kategorie für die GRAMET-Kontur. Anders
 * als bei Vereisung (`icing.js` `computeGrid`, Punktgrößen T/cloudFrac an
 * jedem Level direkt bekannt) liegen Ri/Scherung nur AUF DEN SCHICHTEN
 * zwischen zwei Modell-Leveln vor (`nm = nk-1` Zwischenwerte, s. `grid.js`
 * `derive()`). Ein Level erbt daher das Maximum der beiden angrenzenden
 * Schichten (unten/oben) -- Rand-Level (k=0 bzw. k=nk-1) haben nur eine
 * angrenzende Schicht. `ri`/`shear2` kommen als bereits abgeleitete Arrays
 * herein (wie `cloudFrac` bei icing.js) statt hier erneut berechnet zu werden.
 */
export function computeGrid(grid, ri, shear2, nm) {
  const { nk, times } = grid, nt = times.length;
  const out = new Array(nt * nk);
  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < nk; k++) {
      let tfi = -1; // Sentinel: keine angrenzende Schicht -> "none"
      if (k > 0) tfi = Math.max(tfi, tfiAt(ri[i * nm + k - 1], shear2[i * nm + k - 1]));
      if (k < nm) tfi = Math.max(tfi, tfiAt(ri[i * nm + k], shear2[i * nm + k]));
      out[i * nk + k] = tfiCategory(tfi < 0 ? NaN : tfi);
    }
  }
  return out;
}
