import {
  DEFAULT_MAX_HEIGHT, DEFAULT_FORECAST_DAYS,
  MAX_HEIGHT_OPTIONS, FORECAST_DAYS_OPTIONS,
} from "./config.js";
import { setUnits } from "./units.js";
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
  // Numerische Felder als Zahl führen.
  if (key === "maxHeight" || key === "forecastDays") value = Number(value);
  settings[key] = value;
  applyUnits();
  saveSettings();
}

function applyUnits() {
  setUnits({ height: settings.unitHeight, wind: settings.unitWind, temp: settings.unitTemp });
}

/** Options-Listen fürs Befüllen der Selects im Panel. */
export const OPTIONS = {
  maxHeight: MAX_HEIGHT_OPTIONS,
  forecastDays: FORECAST_DAYS_OPTIONS,
  droneProfile: DRONE_PROFILES.map((p) => p.id),
};
