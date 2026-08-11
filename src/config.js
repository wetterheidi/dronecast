// Modell-Level-Daten (u/v/T/RH/… auf nativen ICON-Leveln): Michaels Instanz.
export const API_BASE = "https://open-meteo.mah.priv.at";
// ICON Global (Modelllevel) läuft seit 2026-08 auf einem eigenen Server
// (Absprache mit Michael): die dwd_icon-Ingestion auf API_BASE ist kaputt
// (meta.json liefert 500, Modelllevel-Felder kommen durchgehend null zurück).
// ICON-D2/ICON-EU bleiben unverändert auf API_BASE. Siehe MODELS.icon_global
// unten sowie dasselbe Vorgehen im TLogPViewer (fetch_sounding_openmeteo.py).
export const API_BASE_ICON_GLOBAL = "https://open-meteo-temp.mah.priv.at";

// Oberflächen-/Single-Level-Felder (Niederschlag, Böen, CAPE, Bewölkung, …):
// `weather.js` (fetchSurface, Basis des "Jetzt"-Blocks/Meteogramms) holt
// aktuell PAUSCHAL ALLES von hier, der öffentlichen, gemeterten Instanz —
// trotz gleichem ICON-Modell nicht Michaels Instanz, um Vermischung von
// Quellen im selben Datensatz zu vermeiden (siehe SURFACE_CORE/-OPTIONAL).
// Michaels Instanz (Downloadgruppe "heidiVars", API_BASE) liefert per
// Stichprobe (2026-08) tatsächlich mit echten Werten: temperature_2m,
// relative_humidity_2m, dew_point_2m, precipitation, weather_code,
// wind_gusts_10m, visibility, cape, snowfall. Als NULL (nicht Teil der
// Downloadgruppe): cloud_cover*, wind_speed_10m, wind_direction_10m,
// precipitation_probability, freezing_level_height — für diese bleibt die
// öffentliche Instanz ohnehin nötig. gustoverlay.js nutzt diesen Split
// bereits gezielt für wind_gusts_10m (primär API_BASE, Fallback hierher).
export const SURFACE_API_BASE = "https://api.open-meteo.com";

// Levelzählung der API: N=1 oberstes, N=nLevels unterstes Modelllevel (~10 m AGL).
// `apiBase` je Modell (statt eines globalen API_BASE), weil ICON Global auf
// einem anderen Server liegt als ICON-D2/ICON-EU (s. API_BASE_ICON_GLOBAL).
export const MODELS = {
  icon_d2: {
    apiModel: "icon_d2",
    dataset: "dwd_icon_d2",
    label: "ICON-D2 (~2,2 km, Mitteleuropa)",
    apiBase: API_BASE,
    grid: 0.02,
    gridMeters: 2200,
    nLevels: 65,
    bbox: { latMin: 43.18, latMax: 58.08, lonMin: -3.94, lonMax: 20.34 },
  },
  icon_eu: {
    apiModel: "icon_eu",
    dataset: "dwd_icon_eu",
    label: "ICON-EU (~6,5 km, Europa)",
    apiBase: API_BASE,
    grid: 0.0625,
    gridMeters: 6500,
    nLevels: 74,
    bbox: { latMin: 29.5, latMax: 70.5, lonMin: -23.5, lonMax: 62.5 },
  },
  // Grid per Stichprobe ermittelt (nearest-neighbor-Sprünge alle 0,125° in
  // lat/lon, ausgerichtet auf Vielfache von 0,125 ab 0) — Open-Meteo regridded
  // das native icosahedrische ICON-Global-Gitter (~13 km) auf dieses reguläre
  // 0,125°-Raster. bbox global, da kein Ausschnitt wie bei D2/EU.
  icon_global: {
    apiModel: "icon_global",
    dataset: "dwd_icon",
    label: "ICON (~13 km, global)",
    apiBase: API_BASE_ICON_GLOBAL,
    grid: 0.125,
    gridMeters: 13915,
    nLevels: 120,
    bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
  },
};

// Oberflächen-/Standardvariablen (stündlich) für die limitierenden Faktoren.
// Kern = überall vorhanden; optional = je nach Modell ggf. nicht verfügbar,
// wird bei Fehler automatisch weggelassen (siehe weather.js).
export const SURFACE_CORE = [
  "temperature_2m",
  "relative_humidity_2m",
  "dew_point_2m",
  "precipitation",
  "weather_code",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
];
export const SURFACE_OPTIONAL = [
  "precipitation_probability",
  "visibility",
  "cape",
  "freezing_level_height",
  "snowfall", // Niederschlagsphase im GRAMET-Meteogramm (src/gramet)
];

// Vorhersage-Obergrenze (max. Flughöhe AGL) – Auswahl fürs Settings-Panel.
export const MAX_HEIGHT_OPTIONS = [120, 300, 500, 1000, 2000, 6000, 8000, 10000]; // m AGL
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
