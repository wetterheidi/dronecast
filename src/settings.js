import {
  DEFAULT_MAX_HEIGHT, DEFAULT_FORECAST_DAYS,
  FORECAST_DAYS_OPTIONS,
  SAT_PRODUCTS, WIND_OVERLAY_DEFAULT_DENSITY,
} from "./config.js";
import { setUnits } from "meteokit/units";
import { DRONE_PROFILES } from "./droneProfiles.js";

const STORAGE_KEY = "droneforecast.settings.v1";

const DEFAULTS = {
  model: "icon_d2",
  unitHeight: "m",
  unitWind: "kmh",
  unitTemp: "c",
  maxHeight: DEFAULT_MAX_HEIGHT, // m AGL
  forecastDays: DEFAULT_FORECAST_DAYS,
  droneProfile: DRONE_PROFILES[0].id,
  xsZoom: false, // Cross-Section: false = Gesamthöhe (log), true = bis Flughöhe (fein, linear)
  // GRAMET-Ebenen: einzeln ausblendbar, das Meteogramm wird sonst schnell überladen.
  gmIsothermsOn: true,
  gmIsotachsOn: true,
  gmHazardsOn: true, // Vereisung + Turbulenz (Kontur-Flächen + Symbole)
  gmWindbarbsOn: false, // Fiedern in der Hauptfläche, Default aus (Testfeature, s. Feedback)
  lastPoint: null, // { lat, lon } – zuletzt gewählter Operationspunkt
  baseLayer: "OpenStreetMap", // Name der aktiven Leaflet-Basiskarte
  satLayerOn: false,
  satLayerProduct: SAT_PRODUCTS[0].id,
  satLayerOpacity: 0.7,
  radarLayerOn: false,
  radarLayerOpacity: 0.7,
  airspaceLayerOn: false,
  airspaceLayerOpacity: 0.8,
  windLayerOn: false,
  windLayerBarbs: true,
  windLayerOpacity: 0.5,
  windLayerDensity: WIND_OVERLAY_DEFAULT_DENSITY,
  windLayerHeightIdx: 0, // Index ins Level-Band (0 = unterstes Level, ~10 m AGL)
  // Böen-Layer (Oberfläche, 10 m; wind_gusts_10m von der öffentlichen Instanz).
  // Anders als Wind ohne Höhenband/Level; „mode" schaltet zwischen Farbfläche
  // und Zahlenwerten am Gitterpunkt um.
  gustLayerOn: false,
  gustLayerMode: "fill", // "fill" = Farbfläche | "numbers" = Zahlenwerte
  gustLayerOpacity: 0.5,
  gustLayerDensity: WIND_OVERLAY_DEFAULT_DENSITY,
  // Wolken-Layer (cloudoverlay.js): EIN Fetch (volles Level-Band bis
  // CLOUD_OVERLAY_CAP_M) speist zwei unabhängig ein-/ausschaltbare
  // Darstellungen — Bedeckungsgrad (Graufläche, ein Stockwerk zur Zeit) und
  // Ceiling (Fläche ODER Zahlen, wie beim Böen-Layer).
  cloudLayerOn: false,
  cloudLayerDensity: "medium",
  cloudCoverOn: true,
  cloudCoverBand: "low", // "low" | "mid" | "high"
  cloudCoverOpacity: 0.5,
  cloudCeilingOn: true,
  cloudCeilingMode: "fill", // "fill" = Farbfläche | "numbers" = Zahlenwerte
  cloudCeilingOpacity: 0.5,
  // WW-Layer (wwoverlay.js): signifikantes Wetter als Symbol je Gitterpunkt,
  // nur EIN Darstellungsmodus (kategorial, kein Fläche/Zahlen-Umschalter wie
  // bei Böen/Wolken/DEM).
  wwLayerOn: false,
  wwLayerOpacity: 0.85,
  wwLayerDensity: WIND_OVERLAY_DEFAULT_DENSITY,
  // DEM-Layer (demoverlay.js, Testfeature): „quantity" wählt die Größe
  // (Höhendifferenz Δh, statisch | Druckdifferenz ΔQFE, stündlich), „mode"
  // schaltet wie beim Böen-Layer zwischen Farbfläche und Zahlenwerten um.
  demLayerOn: false,
  demLayerQuantity: "height", // "height" = Δh (m) | "pressure" = ΔQFE (hPa)
  demLayerMode: "fill", // "fill" = Farbfläche | "numbers" = Zahlenwerte
  demLayerOpacity: 0.5,
  demLayerDensity: WIND_OVERLAY_DEFAULT_DENSITY,
};

export const settings = { ...DEFAULTS };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of Object.keys(DEFAULTS)) {
        if (saved[k] != null) settings[k] = saved[k];
      }
    }
  } catch { /* ignoriert: erste Nutzung oder defekter Speicher */ }
  applyUnits();
  return settings;
}

export function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* Speicher voll/gesperrt – nicht kritisch */ }
}

export function updateSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  // Numerische Felder als Zahl führen (z. B. aus <select>/<input type="range">-Strings).
  if (typeof DEFAULTS[key] === "number") value = Number(value);
  settings[key] = value;
  applyUnits();
  saveSettings();
}

function applyUnits() {
  setUnits({ height: settings.unitHeight, wind: settings.unitWind, temp: settings.unitTemp });
}

/** Options-Listen fürs Befüllen der Selects im Panel. */
export const OPTIONS = {
  forecastDays: FORECAST_DAYS_OPTIONS,
  droneProfile: DRONE_PROFILES.map((p) => p.id),
};
