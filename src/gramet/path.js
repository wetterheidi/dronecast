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
import { resamplePath } from "./resample.js";
import { fetchTerrainProfile } from "./terrain.js";

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

// Open-Meteo liefert immer stündlich, unabhängig vom Modell (`grid.js`s
// `meta.dt` ist faktisch immer 3600s) -- die zeitliche Auflösung ist also
// eine Konstante, keine Modell-Eigenschaft.
const MODEL_TIME_RES_SEC = 3600;

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Datumsbereich (UTC), der alle Wegpunkt-Zeiten abdeckt -- als `horizon`-
 * Objekt für `fetchColumn`/`fetchSurface` (s. `weather.js` `horizonParams()`).
 * Anders als das frühere `forecast_days` funktioniert das auch für Pfade in
 * der Vergangenheit (Rückwärtstrajektorien) und lädt für Zukunftspfade nur
 * die tatsächlich benötigten Tage statt des vollen Vorhersagehorizonts.
 * 1 h Polster an beiden Enden: `sliceColumnAtTime` klemmt an den Serien-
 * rändern (s. `column.js` `bracketTime`) -- ein Wegpunkt um 23:30 UTC darf
 * nicht auf die 23:00-Stunde des Endtags geklemmt werden.
 */
function dateRangeOfWaypoints(waypoints) {
  const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  return {
    startDate: day(waypoints[0].t - 3600),
    endDate: day(waypoints[waypoints.length - 1].t + 3600),
  };
}

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
 * Kombinierte Sampling-Policy ("Fall C", s. Diskussion): ein Wegpunkt wird
 * erst tatsächlich gefetcht, wenn seit dem zuletzt gefetchten ENTWEDER die
 * Modell-Zeitauflösung (`timeResSec`, Default `MODEL_TIME_RES_SEC`) ODER die
 * Modell-Gitterweite (`distResM`, Default `model.gridMeters`) überschritten
 * ist -- was zuerst eintritt. Bildet ab, wann das Modell überhaupt neue
 * Information hergibt, statt pauschal eine feste Spaltenzahl übers Gitter
 * zu verteilen.
 * @returns Indizes in `waypoints`, aufsteigend, ohne Duplikate, immer inkl.
 *   erstem und letztem Index.
 */
function selectWaypointsToFetch(waypoints, model, opts = {}) {
  const maxCols = opts.maxCols ?? 12;
  const timeResSec = opts.timeResSec ?? MODEL_TIME_RES_SEC;
  const distResM = opts.distResM ?? model.gridMeters;

  const candidates = [0];
  let last = waypoints[0];
  for (let i = 1; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const dt = wp.t - last.t;
    const dist = haversineM(last.lat, last.lon, wp.lat, wp.lon);
    if (dt >= timeResSec || dist >= distResM) {
      candidates.push(i);
      last = wp;
    }
  }
  const lastIdx = waypoints.length - 1;
  if (candidates[candidates.length - 1] !== lastIdx) candidates.push(lastIdx);

  // Notbremse: übersteigt die so entstandene Liste trotzdem `maxCols` (z. B.
  // ein sehr langer Loiter-Flug, der die Zeitschwelle laufend reißt, ohne
  // räumlich voranzukommen), gleichmäßig ausdünnen -- gleiche Methode wie die
  // frühere Platzhalter-Policy, jetzt nur noch als Fallback statt Regelfall.
  if (candidates.length <= maxCols) return candidates;
  const thinned = new Set();
  for (let k = 0; k < maxCols; k++) {
    thinned.add(candidates[Math.round((k / (maxCols - 1)) * (candidates.length - 1))]);
  }
  return [...thinned].sort((a, b) => a - b);
}

/**
 * Holt Säulen für eine (sub-gesampelte) Wegpunktliste, bricht beim ersten
 * Verlassen der Modell-Bbox ab (kein weiterer Fetch danach, kein
 * Modell-Handoff -- ein Path-Grid nimmt EIN Modell für den gesamten Pfad an,
 * s. Plan), und setzt das Gitter zusammen.
 * @param waypoints Array<{ lat, lon, t }> -- dicht, vom Aufrufer geliefert
 *   (z. B. aus einer Trajektorienberechnung), `t` in Unixsekunden,
 *   aufsteigend (Rückwärtstrajektorien vor der Übergabe umkehren).
 * @param forecastDays ungenutzt (historisch) -- der Zeithorizont wird seit
 *   der `start_date`/`end_date`-Umstellung aus den Wegpunkt-Zeiten selbst
 *   abgeleitet (s. `dateRangeOfWaypoints`), womit auch Pfade in der
 *   Vergangenheit funktionieren. Parameter bleibt für Aufrufer-Kompatibilität
 *   in der Signatur.
 * @param opts { maxCols, timeResSec, distResM (s. `selectWaypointsToFetch`),
 *   resampleIntervalSec (optional -- wenn gesetzt, wird das gefetchte,
 *   sparsame Gitter per `resample.js` `resamplePath()` auf diese Kadenz in
 *   Sekunden interpoliert, z. B. 600 für alle 10 min; ohne diese Option
 *   bleibt es bei einer Spalte pro tatsächlich gefetchtem Wegpunkt),
 *   terrain (optional -- wenn true, wird zusätzlich ein Geländeprofil per
 *   `terrain.js` `fetchTerrainProfile()` geholt, unabhängig von der
 *   Wetter-Fetch-Policy und parallel zur Wetterschleife),
 *   terrainIntervalSec (optional, an `fetchTerrainProfile` durchgereicht --
 *   Geländesampling-Kadenz, Default dort "etwa minütlich") }
 * @returns { grid, view, pathStop: { lat, lon, index, reason } | null,
 *   terrain: { pos, elevation, gaps } | null }
 */
export async function fetchGridForPath(waypoints, modelKey, forecastDays, fetchImpl, opts = {}) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unbekanntes Modell: ${modelKey}`);
  if (waypoints.length < 2) throw new Error("Path-Modus braucht mindestens zwei Wegpunkte");

  const pos = posOfPath(waypoints);
  const horizon = dateRangeOfWaypoints(waypoints);
  const indices = selectWaypointsToFetch(waypoints, model, opts);
  // Läuft unabhängig von der Wetterschleife unten durch -- Gelände hat nichts
  // mit der Modell-Bbox/-Auflösung zu tun, deshalb über die volle dichte
  // `waypoints`-Liste statt über die (sparsame) Fetch-Policy-Auswahl.
  const terrainPromise = opts.terrain
    ? fetchTerrainProfile(waypoints, { fetchImpl, terrainIntervalSec: opts.terrainIntervalSec })
    : null;

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
      fetchColumn(wp.lat, wp.lon, modelKey, horizon, fetchImpl),
      fetchSurface(wp.lat, wp.lon, modelKey, horizon, fetchImpl).catch(() => null),
    ]);
    if (!col.time.length) {
      pathStop = { lat: wp.lat, lon: wp.lon, index: i, reason: NO_DATA_STOP_REASON };
      break;
    }
    waypointColumns.push({
      lat: wp.lat, lon: wp.lon, t: wp.t, pos: pos[i],
      elevation: col.elevation, model: modelKey, col, surface,
    });
  }

  if (waypointColumns.length < 2) {
    throw new Error(pathStop ? pathStop.reason : "Keine Wegpunkte im Modellgebiet");
  }

  const dense = opts.resampleIntervalSec ? resamplePath(waypointColumns, opts.resampleIntervalSec) : waypointColumns;
  const grid = gridFromWaypoints(dense);
  const view = deriveView(grid);

  let terrain = terrainPromise ? await terrainPromise : null;
  if (terrain) terrain = trimTerrainToChart(terrain, grid.pos[grid.pos.length - 1]);

  return { grid, view, pathStop, terrain };
}

// Gelände jenseits des tatsächlich genutzten Wetter-Bereichs (Bbox-/No-Data-
// Stop, s. `pathStop` oben) hat im Chart keinen Platz mehr -- `x.right`
// endet dort (s. `render.js`), ein weiter reichendes Geländeprofil würde
// nirgends gezeichnet.
function trimTerrainToChart(terrain, maxPos) {
  let n = terrain.pos.length;
  while (n > 0 && terrain.pos[n - 1] > maxPos) n--;
  const gaps = terrain.gaps
    .filter((g) => g.fromPos <= maxPos)
    .map((g) => ({ fromPos: g.fromPos, toPos: Math.min(g.toPos, maxPos) }));
  return { pos: terrain.pos.subarray(0, n), elevation: terrain.elevation.subarray(0, n), gaps };
}
