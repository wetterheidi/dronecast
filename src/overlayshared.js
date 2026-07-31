/**
 * Gemeinsame, parameter- und level-UNABHÄNGIGE Bausteine der flächigen
 * Kartenlayer (windoverlay.js, gustoverlay.js). Hier liegt nur, was keine
 * layer-spezifische Zustandslogik (Cache-Inhalt, Band, Rendering-Auswahl)
 * kennt: die km-basierte Gittergeometrie, die Farbklassen-/Interpolations-
 * Primitiven und die Timing-Helfer. So teilen sich Wind (Modelllevel) und
 * Böen (Oberfläche) dieselbe Gitter-/Zeichen-Mechanik, ohne sie zu duplizieren.
 *
 * Die Gitterfunktionen sind bewusst rein (bounds/zoom/model als Argumente,
 * kein `map`-Zugriff) und km-basiert je Achse — Hintergrund (Anisotropie von
 * Grad→km zwischen Breite und Länge, budgetbegrenztes Basisgitter, ganzzahliges
 * Dichte-Vielfaches) siehe Kopfkommentar in windoverlay.js.
 */

import { WIND_OVERLAY_BASE_TARGET_PX, WIND_OVERLAY_MAX_POINTS } from "./config.js";

export const KM_PER_DEG = 111.32; // Erdradius-Näherung für Breite; Länge: KM_PER_DEG·cos(Breite)

// -- Zahlen-Helfer ------------------------------------------------------------
export function clampNum(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
export function firstFinite(arr) {
  if (!Array.isArray(arr)) return null;
  for (const v of arr) if (v != null && Number.isFinite(v)) return v;
  return null;
}
export function round5(x) {
  return Math.round(x * 1e5) / 1e5;
}

// -- Farbklassen --------------------------------------------------------------
// Farbklasse für einen Skalarwert anhand der (parameterspezifischen) Stops.
// `stops` in nativer Einheit des Parameters (Wind/Böen: m/s).
export function classFor(value, stops) {
  for (const s of stops) if (value <= s.max) return s;
  return stops[stops.length - 1];
}
export function hex(rgb) {
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

// -- Interpolation / Canvas-Raster --------------------------------------------
export function bilin(v00, v10, v01, v11, fy, fx) {
  return v00 * (1 - fy) * (1 - fx) + v10 * fy * (1 - fx) + v01 * (1 - fy) * fx + v11 * fy * fx;
}

export function fillBlock(data, width, height, px, py, step, rgb) {
  const maxY = Math.min(py + step, height);
  const maxX = Math.min(px + step, width);
  for (let y = py; y < maxY; y++) {
    let idx = (y * width + px) * 4;
    for (let x = px; x < maxX; x++, idx += 4) {
      data[idx] = rgb[0]; data[idx + 1] = rgb[1]; data[idx + 2] = rgb[2]; data[idx + 3] = 255;
    }
  }
}

// -- Grid-Geometrie -----------------------------------------------------------
// Kleinste Zweierpotenz, mit der `gridDeg` mal Stride mal km/Grad die
// Zielweite (km) erreicht oder überschreitet.
function strideForAxis(gridDeg, kmPerDeg, targetKm) {
  let s = 1;
  while (gridDeg * s * kmPerDeg < targetKm && s < 128) s *= 2;
  return s;
}

function bboxDeg(bounds, model) {
  const latPad = (bounds.getNorth() - bounds.getSouth()) * 0.15;
  const lonPad = (bounds.getEast() - bounds.getWest()) * 0.15;
  return {
    latMin: Math.max(model.bbox.latMin, bounds.getSouth() - latPad),
    latMax: Math.min(model.bbox.latMax, bounds.getNorth() + latPad),
    lonMin: Math.max(model.bbox.lonMin, bounds.getWest() - lonPad),
    lonMax: Math.min(model.bbox.lonMax, bounds.getEast() + lonPad),
  };
}

function nodeCount(box, g, latStride, lonStride) {
  const iLatLo = Math.ceil(box.latMin / g / latStride) * latStride;
  const iLatHi = Math.floor(box.latMax / g / latStride) * latStride;
  const iLonLo = Math.ceil(box.lonMin / g / lonStride) * lonStride;
  const iLonHi = Math.floor(box.lonMax / g / lonStride) * lonStride;
  const nLat = Math.max(0, Math.floor((iLatHi - iLatLo) / latStride) + 1);
  const nLon = Math.max(0, Math.floor((iLonHi - iLonLo) / lonStride) + 1);
  return nLat * nLon;
}

// Dichtestes Gitter, das noch ins Punktebudget passt (Basis für die
// 1×/2×/3×-Dichtewahl). Zoom-adaptiv und km-basiert je Achse (Anisotropie).
// `maxPoints`/`targetPx` sind je Layer verschieden: der Wind-Layer trifft eine
// limitfreie Instanz und darf großzügig sein, der Böen-Layer eine gemeterte
// öffentliche Instanz und bekommt ein kleineres Budget (weniger Locations).
function buildBaseGrid(bounds, zoom, model, maxPoints, targetPx) {
  const g = model.grid;
  const centerLat = (bounds.getNorth() + bounds.getSouth()) / 2;
  const kmPerDegLat = KM_PER_DEG;
  const kmPerDegLon = KM_PER_DEG * Math.cos((centerLat * Math.PI) / 180);
  const pxPerDegLon = (256 * Math.pow(2, zoom)) / 360;
  const pxPerKm = pxPerDegLon / kmPerDegLon;
  const targetKm = targetPx / pxPerKm;

  let latStride = strideForAxis(g, kmPerDegLat, targetKm);
  let lonStride = strideForAxis(g, kmPerDegLon, targetKm);
  const box = bboxDeg(bounds, model);

  for (let guard = 0; guard < 20; guard++) {
    if (nodeCount(box, g, latStride, lonStride) <= maxPoints ||
        (latStride >= 128 && lonStride >= 128)) {
      break;
    }
    // Nur die (in km!) jeweils feinere Achse verdoppeln — km/Grad
    // unterscheidet sich zwischen Breite und Länge, gleicher Stride ist also
    // nicht gleiche physische Zellgröße.
    if (latStride * kmPerDegLat <= lonStride * kmPerDegLon) {
      latStride = Math.min(latStride * 2, 128);
    } else {
      lonStride = Math.min(lonStride * 2, 128);
    }
  }
  return { latStride, lonStride, box };
}

// Gitter für die gewählte Dichte: das budgetbegrenzte Basisgitter mit dem
// Dichte-Vielfachen (1×/2×/3×) je Achse ausgedünnt. `maxPoints`/`targetPx`
// steuern das Budget (Default: Wind-Layer-Werte).
export function buildGrid(bounds, zoom, model, mult,
  maxPoints = WIND_OVERLAY_MAX_POINTS, targetPx = WIND_OVERLAY_BASE_TARGET_PX) {
  const g = model.grid;
  const { latStride: baseLat, lonStride: baseLon, box } = buildBaseGrid(bounds, zoom, model, maxPoints, targetPx);
  const latStride = baseLat * mult;
  const lonStride = baseLon * mult;
  const iLatLo = Math.ceil(box.latMin / g / latStride) * latStride;
  const iLatHi = Math.floor(box.latMax / g / latStride) * latStride;
  const iLonLo = Math.ceil(box.lonMin / g / lonStride) * lonStride;
  const iLonHi = Math.floor(box.lonMax / g / lonStride) * lonStride;
  const nodes = [];
  for (let a = iLatLo; a <= iLatHi; a += latStride) {
    for (let b = iLonLo; b <= iLonHi; b += lonStride) nodes.push([a, b]);
  }
  return { nodes, latStride, lonStride };
}

// -- Timing-Helfer ------------------------------------------------------------
// `.now(...)` feuert sofort UND storniert einen ggf. noch ausstehenden
// verzögerten Aufruf — nötig, weil gezielte Nutzeraktionen und das debounced
// Pannen/Zoomen denselben Fetch auslösen: ohne gemeinsamen Timer könnte ein
// alter, noch ausstehender Pan-Request nach einem sofortigen Aufruf verspätet
// feuern und dessen (aktuelleres) Ergebnis mit veralteten Daten überschreiben.
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.now = (...args) => {
    clearTimeout(t);
    t = null;
    fn(...args);
  };
  return wrapped;
}

// Ruft fn höchstens alle ms auf (führend + nachlaufend), damit progressives
// Rendern beim chunkweisen Nachladen nicht bei jedem Chunk das (relativ teure)
// Vollbild-Canvas + alle Marker neu aufbaut.
export function throttle(fn, ms) {
  let last = 0;
  let t = null;
  const run = () => { last = Date.now(); t = null; fn(); };
  return () => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) run();
    else if (!t) t = setTimeout(run, wait);
  };
}

// Abbrechbares setTimeout als Promise — für den Backoff zwischen Chunk-Retries.
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}
