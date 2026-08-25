/**
 * App-Konfiguration von droneforecast.
 *
 * Die Datenquellen (Modellkatalog, API-Instanzen, Oberflächenvariablen) leben
 * seit dem meteokit-Umzug in der Bibliothek und werden hier nur
 * durchgereicht -- so bleiben alle bestehenden `import { MODELS } from
 * "./config.js"` im App-Code unverändert gültig, und es gibt weiterhin genau
 * EINE Quelle der Wahrheit dafür (meteokit/src/config.js).
 *
 * Diese App nutzt die Bibliotheks-Defaults unverändert und ruft deshalb kein
 * `configure()` -- die Defaults SIND droneforecasts bisherige Werte.
 * `configure` wird trotzdem re-exportiert, damit es hier zentral greifbar
 * bleibt, falls das mal nötig wird.
 *
 * Alles Übrige unten ist app-eigen (Kartenlayer, Overlays, Panel-Grenzen) und
 * gehört bewusst NICHT in die Bibliothek.
 */

export {
  API_BASE,
  API_BASE_ICON_GLOBAL,
  SURFACE_API_BASE,
  MODELS,
  SURFACE_CORE,
  SURFACE_OPTIONAL,
  getModel,
  configure,
} from "meteokit/config";

// Vorhersage-Obergrenze (max. Flughöhe AGL) – Eingabefeld im Settings-Panel.
export const MIN_MAX_HEIGHT = 120; // m AGL
export const MAX_MAX_HEIGHT = 10000; // m AGL
export const DEFAULT_MAX_HEIGHT = 300;

// Vorhersage-Zeithorizont in Tagen.
export const FORECAST_DAYS_OPTIONS = [1, 2, 3, 4, 5];
export const DEFAULT_FORECAST_DAYS = 2;

// Höhen (AGL), für die im Grundgerüst der Modell-Level-Wind gezeigt wird.
// (Später ersetzt durch frei wählbare Profile.)
export const PREVIEW_HEIGHTS = [50, 100, 150];

// Kartenlayer: Niederschlagsradar (RainViewer, kein Key nötig, CORS offen)
// und Satellit (EUMETSAT/EUMETView-WMS, CORS offen, kein Proxy nötig).
export const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
export const RAINVIEWER_META_TTL_MS = 5 * 60 * 1000;
export const RAINVIEWER_COLOR_SCHEME = 4; // Free-Tier: Farbschema fix, keine Auswahl möglich

// EUMETSATs öffentlicher WMS (view.eumetsat.int) hat — anders als DWDs WMS —
// eine echte Zeitdimension mit 10–15-Minuten-Raster und Verzögerung von nur
// ca. 20–30 Min. zu "jetzt" (statt DWDs bis zu 3 Std.). GetCapabilities wird
// gecacht geladen, um daraus je Produkt Start/Ende/Rasterschritt der
// Zeitdimension zu bestimmen (siehe maplayers.js `getSatExtents`).
export const EUMETSAT_WMS_BASE = "https://view.eumetsat.int/geoserver/wms";
export const EUMETSAT_CAPS_URL = `${EUMETSAT_WMS_BASE}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`;
export const EUMETSAT_CAPS_TTL_MS = 10 * 60 * 1000;
export const SAT_PRODUCTS = [
  { id: "msg_fes:rgb_natural", label: "Natural Color RGB" },
  { id: "msg_fes:rgb_dust", label: "Dust RGB" },
  { id: "mtg_fd:ir105_hrfi", label: "IR 10,5 µm (MTG HRFI)" },
  { id: "msg_fes:vis006", label: "VIS 0,6 µm (nur tagsüber)" },
];

export const MAPLAYERS_TIME_STEP_MIN = 15;

// Lufträume (openflightmaps via Naviator/newaydata-Tiles), wie in trajectories.
// Statischer Tile-Layer, kein Key/Proxy nötig, keine Zeitdimension.
export const AIRSPACE_TILE_URL = "https://nwy-tiles-api.prod.newaydata.com/tiles/{z}/{x}/{y}.png?path=latest/aero/latest";

// Wind-Overlay (flächige Darstellung, unterstes Modelllevel ~10 m AGL):
// Mindest-Zoom, ab dem der Layer Daten holt (Drohnenflüge sind kleinräumig —
// bei icon_d2 (0,02° ≈ 2,2 km Gitterweite) zeigt Zoom 9 einen ca. 300 km
// breiten Ausschnitt, ab Zoom ≈12 ist das native Gitter unausgedünnt
// darstellbar), sowie Punktebudget je Kartenausschnitt/Refresh. Schon die
// "grobe" Dichtestufe braucht bei einem typischen Fenster ~450–500 Punkte in
// diesem Zoombereich — das Budget muss deutlich darüber liegen, sonst zeigen
// alle Dichtestufen dasselbe (kappungsbegrenzte) Gitter.
// Auf 7 abgesenkt, seit Böen primär über Michaels ratenlimitfreie Instanz
// laufen (API_BASE, Downloadgruppe "heidiVars" — siehe gustoverlay.js);
// buildGrid() deckelt die Punktzahl je Refresh ohnehin über das Budget, ein
// breiterer Ausschnitt liefert also nur ein gröberes, kein größeres Gitter.
export const WIND_OVERLAY_MIN_ZOOM = 7;
export const WIND_OVERLAY_MAX_POINTS = 1500;
export const WIND_OVERLAY_POINTS_PER_REQUEST = 75;
// Gleichzeitige Requests je Refresh. Bewusst begrenzt: seit dem Höhenschieber
// lädt jeder Request das ganze Level-Band (~7–23 Level × 2 Comps × Horizont),
// also ein Vielfaches der früheren Datenmenge. Zu viele parallele Großrequests
// führten zu Timeouts/Rate-Limits (einzelne Chunks schlugen fehl → Lücken).
export const WIND_OVERLAY_MAX_CONCURRENCY = 6;
// Wiederholversuche je Chunk bei (nicht abgebrochenem) Fehler, mit Backoff.
export const WIND_OVERLAY_CHUNK_RETRIES = 2;

// Gitterdichte der Fiedern/Farbfläche als ganzzahliges Vielfaches des
// dichtesten (budgetbegrenzten) Basisgitters — "Gitterpunktsabstand 1×/2×/3×".
// Bewusst NICHT über einen Pixel-Zielabstand: der würde auf Zweierpotenz-
// Strides gerundet, und weil die Wunsch-Abstände enger beieinander liegen als
// diese Faktor-2-Quantisierung, kollabierten benachbarte Stufen (und bei
// großen Fenstern alle drei) aufs selbe Gitter. Ein echtes Vielfaches des
// Basisstride ist dagegen immer unterscheidbar. Nutzerwählbar im Panel.
export const WIND_OVERLAY_DENSITY_OPTIONS = [
  { id: "fine", label: "Dicht (1×)", mult: 1 },
  { id: "medium", label: "Mittel (2×)", mult: 2 },
  { id: "coarse", label: "Weit (3×)", mult: 3 },
];
export const WIND_OVERLAY_DEFAULT_DENSITY = "fine";

// Ziel-Pixelabstand des dichtesten (Basis-)Gitters. ~ Fiederngröße (44 px),
// leicht darunter für eine dichte, aber noch lesbare Darstellung bei "1×".
export const WIND_OVERLAY_BASE_TARGET_PX = 40;

// Böen-Layer (gustoverlay.js): eigene, deutlich sparsamere Last-Parameter, weil
// er — anders als der Wind-Layer — die ÖFFENTLICHE Open-Meteo-Instanz trifft
// (Michaels Instanz liefert wind_gusts_10m nur als NULL). Diese Instanz ist
// gemetert (Rate-Limit nach Locations × Variablen × Tagen, HTTP 429); daher
// kleineres Punktebudget und geringe Parallelität. POINTS_PER_REQUEST bündelt
// viele Locations in einen Request (weniger HTTP-Requests). Bei 429 pausiert
// der Layer und wartet Retry-After ab (siehe gustoverlay.js).
export const GUST_OVERLAY_MAX_POINTS = 500;
export const GUST_OVERLAY_POINTS_PER_REQUEST = 100;
export const GUST_OVERLAY_MAX_CONCURRENCY = 2;
export const GUST_OVERLAY_CHUNK_RETRIES = 2;
// Fallback-Wartezeit nach einem 429 ohne (brauchbaren) Retry-After-Header.
export const GUST_OVERLAY_RATE_LIMIT_COOLDOWN_MS = 30 * 1000;

// WW-Layer (wwoverlay.js): signifikantes Wetter (weather_code) als Symbol je
// Gitterpunkt — wie Böen eine einzelne Oberflächenvariable (kein Level-Band),
// bereits Teil von SURFACE_CORE auf BEIDEN Hosts (siehe meteokit/config.js),
// daher dieselben unkritischen Lastparameter wie beim Böen-Layer.
export const WW_OVERLAY_MAX_POINTS = 500;
export const WW_OVERLAY_POINTS_PER_REQUEST = 100;
export const WW_OVERLAY_MAX_CONCURRENCY = 2;
export const WW_OVERLAY_CHUNK_RETRIES = 2;
export const WW_OVERLAY_RATE_LIMIT_COOLDOWN_MS = 30 * 1000;

// Höhenschieber: Die nativen ICON-Level haben keine feste Meterhöhe — ihre
// Höhe AGL steht pro Punkt/Zeit in `height_agl_level{l}`. Beim Aktivieren des
// Layers wird daher einmal je Modell an einem Sondierpunkt (Kartenmitte) die
// Höhe der untersten Level abgefragt (wie windfield.js) und daraus das
// „Level-Band" vom Boden (~10 m) bis knapp über die eingestellte maxHeight
// gebildet. PROBE_LEVELS ist die Anzahl der dabei sondierten untersten Level —
// großzügig, damit auch die höchste maxHeight (2000 m) sicher abgedeckt ist
// (30 Level reichen bei ICON-D2 bis ~3150 m, bei ICON-EU bis ~5500 m).
export const WIND_OVERLAY_PROBE_LEVELS = 30;

// Wolken-Layer (cloudoverlay.js): Bedeckungsgrad tief/mittel/hoch + Ceiling,
// aus derselben clouds.js-Methodik wie Meteogramm/Briefing (siehe dort). Im
// Unterschied zum Wind-Layer kein Höhenschieber und keine Kopplung an
// `maxHeight` — Wolken über der Flughöhe sind fürs Bedeckungsbild trotzdem
// relevant (z. B. Cirrus über einem 300-m-Limit). Das geladene Level-Band
// reicht daher IMMER bis CLOUD_OVERLAY_CAP_M (wie `cloudLayers()`s
// `capM`-Default), unabhängig von settings.maxHeight.
export const CLOUD_OVERLAY_CAP_M = 12000;
// Pro Punkt werden (anders als beim Wind-Layer mit 2 Comps) 6 Comps
// (Höhe/Temperatur/Druck/Feuchte×2/Vertikalwind) über ein ggf. sehr tiefes
// Level-Band geladen — das `hourly`-Variablenarray je Request ist dadurch
// deutlich länger als bei Wind/Böen. Punktebudget bewusst kleiner als beim
// Wind-Layer, um Request-/Antwortgröße im Rahmen zu halten (Startwerte,
// noch nicht gegen die echte API kalibriert).
export const CLOUD_OVERLAY_MAX_POINTS = 400;
export const CLOUD_OVERLAY_POINTS_PER_REQUEST = 40;
export const CLOUD_OVERLAY_MAX_CONCURRENCY = 3;
export const CLOUD_OVERLAY_CHUNK_RETRIES = 2;

// Ab dieser Differenz zwischen echter (DEM-)Geländehöhe und modelleigener
// Orographie gilt das lokale Gelände als vom Gitter nicht aufgelöst — grobe
// Faustregel, keine Literaturkonstante (siehe METHODIK.md, Abschnitt 5b).
// Zentral hier statt in app.js, weil sowohl die Punktvorhersage (renderNow)
// als auch demoverlay.js (Kartenlayer, Farbklassen) denselben Schwellenwert
// brauchen — EINE Quelle statt zwei driftender Kopien.
export const TERRAIN_MISMATCH_WARN_M = 100;

// DEM-Layer (demoverlay.js, Testfeature): flächige Differenz Modell-
// Orographie minus DEM90-Geländehöhe. Anders als Böen/Wolken ist das ein
// STATISCHER Layer (weder Gelände noch Modellgitter ändern sich mit der
// Vorhersagestunde) — kein Zeitbezug, kein TTL-Refresh nötig, nur echte
// Fehler lösen einen Retry aus. Zwei getrennte Quellen je Punkt:
//   - DEM90: `/v1/elevation` — primär Michaels Instanz (API_BASE, seit
//     Michael dort die weltweiten DEM90-Höhen hostet), Fallback öffentliche
//     Instanz (SURFACE_API_BASE, dort schon immer DEM90-basiert). Modell-
//     unabhängig, daher IMMER dieselben zwei Hosts, unabhängig vom
//     gewählten ICON-Modell.
//   - Modell-Orographie: `/v1/forecast?hourly=model_elevation&elevation=nan`
//     gegen `model.apiBase` (je Modell verschieden, wie bei windfield.js/
//     gustoverlay.js) — `elevation=nan` pinnt auf die modelleigene
//     Gitterhöhe, unabhängig von serverseitigem DEM-Downscaling.
// UNGETESTET (keine Browser-Session verfügbar): ob `model_elevation` auf
// API_BASE_ICON_GLOBAL (separater Server, siehe icon-global-Memory) echte
// Werte statt NULL liefert, ist offen — bei Fehlschlag zeigt der Layer für
// icon_global Datenlücken/Fehler statt eines harten Absturzes.
export const DEM_OVERLAY_MAX_POINTS = 500;
export const DEM_OVERLAY_POINTS_PER_REQUEST = 100;
export const DEM_OVERLAY_MAX_CONCURRENCY = 2;
export const DEM_OVERLAY_CHUNK_RETRIES = 2;
export const DEM_OVERLAY_RATE_LIMIT_COOLDOWN_MS = 30 * 1000;
