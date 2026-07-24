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
export const MAX_HEIGHT_OPTIONS = [120, 300, 500, 1000, 2000]; // m AGL
export const DEFAULT_MAX_HEIGHT = 300;

// Vorhersage-Zeithorizont in Tagen.
export const FORECAST_DAYS_OPTIONS = [1, 2, 3, 4, 5];
export const DEFAULT_FORECAST_DAYS = 2;

// Höhen (AGL), für die im Grundgerüst der Modell-Level-Wind gezeigt wird.
// (Später ersetzt durch frei wählbare Profile.)
export const PREVIEW_HEIGHTS = [50, 100, 150];

// Kartenlayer: Niederschlagsradar (RainViewer, kein Key nötig, CORS offen)
// und Satellit (DWD-WMS, CORS offen, kein Proxy nötig).
export const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
export const RAINVIEWER_META_TTL_MS = 5 * 60 * 1000;
export const RAINVIEWER_COLOR_SCHEME = 4; // Free-Tier: Farbschema fix, keine Auswahl möglich

export const DWD_WMS_BASE = "https://maps.dwd.de/geoserver/dwd/wms";
export const DWD_SAT_PRODUCTS = [
  { id: "Satellite_meteosat_1km_euat_rgb_day_hrv_and_night_ir108_3h", label: "Europa – HRV/IR (Tag/Nacht)" },
  { id: "Satellite_worldmosaic_3km_world_ir108_3h", label: "Welt – IR 10,8 µm" },
];
// DWD liefert diese Produkte nur zu festen Terminen (00/03/…/21 UTC, laut
// WMS-Capabilities-Abstract) — keine WMS-Zeitdimension, daher kein Abruf des
// tatsächlichen Aufnahmezeitpunkts möglich. Für die Anzeige wird der zuletzt
// planmäßig fällige Termin genähert (siehe maplayers.js).
export const DWD_SAT_UPDATE_INTERVAL_H = 3;

export const MAPLAYERS_TIME_STEP_MIN = 15;
