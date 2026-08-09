/**
 * Fetch-Orchestrierung für den GRAMET-Path-Modus: holt pro (sub-gesampeltem)
 * Wegpunkt eine volle Säule (`column.js` `fetchColumn`), prüft VOR jedem Fetch
 * die Modell-Bbox (s. Kommentar unten) und setzt das Gitter zusammen
 * (`grid.js` `gridFromWaypoints`). Getrennt von `grid.js`, das nur noch reine
 * Form-Assemblierung macht -- diese Datei trägt die Netzwerk-/Policy-Seite.
 */

import { MODELS } from "../config.js";
import { fetchColumn } from "../column.js";
import { fetchSurface } from "../weather.js";
import { gridFromWaypoints } from "./grid.js";
import { deriveView } from "./derive.js";

// Bbox-Verlassen VOR dem Fetch prüfen, nicht danach: `fetchColumn` nutzt
// `cell_selection: "nearest"` (s. column.js) -- ein Punkt außerhalb der Bbox
// bekäme sonst KEINEN Fehler, sondern still die nächstgelegene Zelle unter
// falschem Label zurück. Dieselbe Prüfung/Meldung wie `windfield.js`
// (`inBBox`, "Rand des Modellgebiets erreicht", dort für die Wind-Overlay-
// Interpolation) -- hier eine eigene, lokale Kopie statt eines Imports, weil
// `windfield.js`s Klasse deutlich mehr mitbringt (Gitter-Cache, Interpolation),
// als hier gebraucht wird.
function inBBox(lat, lon, model) {
  const b = model.bbox;
  return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
}

const BBOX_STOP_REASON = "Rand des Modellgebiets erreicht";
// `MODELS[key].bbox` ist nur eine rechteckige Näherung -- das tatsächliche
// Modellgebiet (z. B. ICON-D2) ist kleiner/unregelmäßig geschnitten. Ein
// Punkt kann also innerhalb der Bbox liegen und trotzdem keine Daten liefern
// (`fetchColumn` trimmt die Zeitreihe dann auf Länge 0, s. dort). Realer Fall,
// mit echten Koordinaten reproduziert -- kein hypothetischer Randfall.
const NO_DATA_STOP_REASON = "Keine Modelldaten an diesem Punkt";

/**
 * Verstrichene Sekunden seit `waypoints[0].t` -- der X-Achsen-Positionswert
 * im Path-Modus (Entscheidung: verstrichene Zeit statt Distanz, s. Diskussion
 * vor dem Umbau). Separat exportiert, damit ein späteres Terrain-Profil
 * (Mapterhorn, noch nicht umgesetzt) dieselbe Positionsberechnung wieder-
 * verwenden kann, statt unabhängig davon zu driften.
 */
export function posOfPath(waypoints) {
  const t0 = waypoints[0].t;
  return waypoints.map((wp) => wp.t - t0);
}

/**
 * Vorläufige Sampling-Policy (Platzhalter, s. Plan): feste Obergrenze,
 * gleichmäßig über die dichte Wegpunktliste verteilt. Die eigentliche Policy
 * (Modellauflösung als Kriterium, s. frühere Diskussion) wird bewusst erst
 * später verfeinert -- diese Funktion ist der einzige Ort, der sich dafür
 * ändern muss.
 * @returns Indizes in `waypoints`, aufsteigend, ohne Duplikate.
 */
function selectWaypointsToFetch(waypoints, opts = {}) {
  const maxCols = opts.maxCols ?? 12;
  if (waypoints.length <= maxCols) return waypoints.map((_, i) => i);
  const indices = new Set();
  for (let k = 0; k < maxCols; k++) {
    indices.add(Math.round((k / (maxCols - 1)) * (waypoints.length - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

/**
 * Holt Säulen für eine (sub-gesampelte) Wegpunktliste, bricht beim ersten
 * Verlassen der Modell-Bbox ab (kein weiterer Fetch danach, kein
 * Modell-Handoff -- ein Path-Grid nimmt EIN Modell für den gesamten Pfad an,
 * s. Plan), und setzt das Gitter zusammen.
 * @param waypoints Array<{ lat, lon, t }> -- dicht, vom Aufrufer geliefert
 *   (z. B. aus einer Trajektorienberechnung), `t` in Unixsekunden.
 * @returns { grid, view, pathStop: { lat, lon, index, reason } | null }
 */
export async function fetchGridForPath(waypoints, modelKey, forecastDays, fetchImpl) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unbekanntes Modell: ${modelKey}`);
  if (waypoints.length < 2) throw new Error("Path-Modus braucht mindestens zwei Wegpunkte");

  const pos = posOfPath(waypoints);
  const indices = selectWaypointsToFetch(waypoints);

  const waypointColumns = [];
  let pathStop = null;
  for (const i of indices) {
    const wp = waypoints[i];
    if (!inBBox(wp.lat, wp.lon, model)) {
      pathStop = { lat: wp.lat, lon: wp.lon, index: i, reason: BBOX_STOP_REASON };
      break;
    }
    // Säule (Modell-Level, `column.js`, private Instanz) und Oberflächenwerte
    // (`weather.js`, öffentliche Instanz, s. `SURFACE_API_BASE` in config.js)
    // sind zwei getrennte Requests an zwei getrennte Instanzen -- parallel,
    // weil keins vom Ergebnis des anderen abhängt. Ein Ausfall der
    // Oberflächenwerte bricht den Pfad NICHT ab (nur die ergänzenden
    // Zahlen-/Wetter-Zeilen bleiben dann für diesen Wegpunkt leer, s.
    // `grid.js` `buildSurfaceFromWaypoints`) -- anders als die Säule, ohne
    // die es für diese Spalte gar kein Höhenprofil gäbe.
    const [col, surface] = await Promise.all([
      fetchColumn(wp.lat, wp.lon, modelKey, forecastDays, fetchImpl),
      fetchSurface(wp.lat, wp.lon, modelKey, forecastDays, fetchImpl).catch(() => null),
    ]);
    if (!col.time.length) {
      pathStop = { lat: wp.lat, lon: wp.lon, index: i, reason: NO_DATA_STOP_REASON };
      break;
    }
    waypointColumns.push({ lat: wp.lat, lon: wp.lon, t: wp.t, pos: pos[i], col, surface });
  }

  if (waypointColumns.length < 2) {
    throw new Error(pathStop ? pathStop.reason : "Keine Wegpunkte im Modellgebiet");
  }

  const grid = gridFromWaypoints(waypointColumns);
  const view = deriveView(grid);
  return { grid, view, pathStop };
}
