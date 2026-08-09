/**
 * Debug-Harness für den GRAMET-Path-Modus (s. Plan "GRAMET: Vorbereitung für
 * Path-Modus", Stufe 6). Baut eine synthetische Wegpunktliste, ruft
 * `fetchGridForPath` (path.js) und `renderGramet` (render.js) direkt auf --
 * ganz ohne app.js/state, damit sich der Path-Modus manuell im Browser
 * prüfen lässt (kein automatisiertes Browser-Testing in dieser Umgebung).
 */

import { fetchGridForPath } from "../src/gramet/path.js";
import { renderGramet } from "../src/gramet/render.js";

const DEG = Math.PI / 180;
const EARTH_R_M = 6371000;

/**
 * Wegpunkte einer geraden Linie (Großkreis-Näherung): Startpunkt, Kurs
 * (° von Nord), Geschwindigkeit (m/s), Gesamtdauer (h), Schrittweite (min).
 * Für einen Testpfad über wenige hundert km reicht die Kugel-Näherung.
 */
function buildStraightPath({ lat0, lon0, bearingDeg, speedMs, durationH, stepMin, startSec }) {
  const brg = bearingDeg * DEG;
  const lat0r = lat0 * DEG, lon0r = lon0 * DEG;
  const steps = Math.round((durationH * 60) / stepMin);
  const waypoints = [];
  for (let k = 0; k <= steps; k++) {
    const tSec = k * stepMin * 60;
    const angDist = (speedMs * tSec) / EARTH_R_M;
    const lat1 = Math.asin(
      Math.sin(lat0r) * Math.cos(angDist) + Math.cos(lat0r) * Math.sin(angDist) * Math.cos(brg),
    );
    const lon1 = lon0r + Math.atan2(
      Math.sin(brg) * Math.sin(angDist) * Math.cos(lat0r),
      Math.cos(angDist) - Math.sin(lat0r) * Math.sin(lat1),
    );
    waypoints.push({ lat: lat1 / DEG, lon: lon1 / DEG, t: startSec + tSec });
  }
  return waypoints;
}

const statusEl = document.getElementById("status");
const hostEl = document.getElementById("gm-body");

async function run(waypoints, label) {
  statusEl.textContent = `${label} — lade ${waypoints.length} Wegpunkte (Netzwerk) …`;
  hostEl.innerHTML = "";
  try {
    const { grid, view, pathStop } = await fetchGridForPath(waypoints, "icon_d2", 3);
    statusEl.textContent = pathStop
      ? `${label} — gestoppt bei Wegpunkt ${pathStop.index}: ${pathStop.reason}`
      : `${label} — ${grid.times.length} Spalten geladen`;
    renderGramet(hostEl, grid, view, { pathStop });
  } catch (err) {
    statusEl.textContent = `${label} — Fehler: ${err.message}`;
  }
}

const startSec = Math.floor(Date.now() / 1000);

document.getElementById("run-inside").addEventListener("click", () => {
  // München Richtung Nordosten, ~430 km bei 40 m/s über 3 h -- bleibt
  // innerhalb der ICON-D2-Bbox (config.js).
  const waypoints = buildStraightPath({
    lat0: 48.14, lon0: 11.58, bearingDeg: 45, speedMs: 40,
    durationH: 3, stepMin: 10, startSec,
  });
  run(waypoints, "Innerhalb der Bbox");
});

document.getElementById("run-exit").addEventListener("click", () => {
  // Nahe am Südrand der ICON-D2-Bbox (latMin 43.18) strikt nach Süden --
  // verlässt das Modellgebiet nach wenigen Wegpunkten.
  const waypoints = buildStraightPath({
    lat0: 44.5, lon0: 10.0, bearingDeg: 180, speedMs: 40,
    durationH: 3, stepMin: 10, startSec,
  });
  run(waypoints, "Verlässt die Bbox");
});
