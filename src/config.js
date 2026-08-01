// Modell-Level-Daten (u/v/T/RH/… auf nativen ICON-Leveln): Michaels Instanz.
export const API_BASE = "https://open-meteo.mah.priv.at";

// Oberflächen-/Single-Level-Felder (Niederschlag, Böen, CAPE, Bewölkung, …):
// Michaels Instanz führt diese (noch) nicht, daher die öffentliche Instanz
// mit demselben ICON-Modell. Hybrid-Quelle, siehe weather.js.
export const SURFACE_API_BASE = "https://api.open-meteo.com";

// Levelzählung der API: N=1 oberstes, N=nLevels unterstes Modelllevel (~10 m AGL).
export const MODELS = {
  icon_d2: {
    apiModel: "icon_d2",
    dataset: "dwd_icon_d2",
    label: "ICON-D2 (~2,2 km, Mitteleuropa)",
    grid: 0.02,
    gridMeters: 2200,
    nLevels: 65,
    bbox: { latMin: 43.18, latMax: 58.08, lonMin: -3.94, lonMax: 20.34 },
  },
  icon_eu: {
    apiModel: "icon_eu",
    dataset: "dwd_icon_eu",
    label: "ICON-EU (~6,5 km, Europa)",
    grid: 0.0625,
    gridMeters: 6500,
    nLevels: 74,
    bbox: { latMin: 29.5, latMax: 70.5, lonMin: -23.5, lonMax: 62.5 },
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
];

// Vorhersage-Obergrenze (max. Flughöhe AGL) – Auswahl fürs Settings-Panel.
export const MAX_HEIGHT_OPTIONS = [120, 300, 500, 1000, 2000, 6000]; // m AGL
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
export const WIND_OVERLAY_MIN_ZOOM = 9;
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
