import { SURFACE_API_BASE, MODELS, SURFACE_CORE, SURFACE_OPTIONAL } from "./config.js";

/**
 * Holt die stündlichen Oberflächen-/Standardvariablen (limitierende Faktoren)
 * für einen Punkt über den Vorhersagehorizont. Optionale Variablen, die das
 * Modell nicht anbietet, werden bei einem Fehler automatisch weggelassen.
 *
 * Rückgabe: { time: number[] (unixtime, s), units: {}, vars: { name: (number|null)[] }, elevation }
 */
export async function fetchSurface(lat, lon, modelKey, forecastDays, fetchImpl = fetch.bind(globalThis)) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unbekanntes Modell: ${modelKey}`);

  const build = (vars) => {
    const params = new URLSearchParams({
      latitude: round5(lat),
      longitude: round5(lon),
      hourly: vars.join(","),
      daily: "sunrise,sunset",
      models: model.apiModel,
      timeformat: "unixtime",
      forecast_days: String(forecastDays),
      cell_selection: "nearest",
    });
    return `${SURFACE_API_BASE}/v1/forecast?${params}`;
  };

  // Erst mit allen Variablen versuchen; scheitert der Request an einer nicht
  // verfügbaren Optionalen, ohne die Kernvariablen erneut anfragen.
  let data = await tryFetch(build([...SURFACE_CORE, ...SURFACE_OPTIONAL]), fetchImpl);
  if (!data) data = await tryFetch(build(SURFACE_CORE), fetchImpl);
  if (!data) throw new Error("Oberflächendaten konnten nicht geladen werden");

  const hourly = data.hourly || {};
  const time = hourly.time || [];
  const vars = {};
  for (const key of Object.keys(hourly)) {
    if (key === "time") continue;
    vars[key] = hourly[key];
  }
  // Sonnenauf-/-untergänge (unixtime, s) für die Nachtschattierung.
  const daily = data.daily || {};
  const nights = [];
  const sr = daily.sunrise || [], ss = daily.sunset || [];
  for (let i = 0; i < Math.min(sr.length, ss.length); i++) {
    nights.push({ sunrise: sr[i], sunset: ss[i] });
  }

  return {
    time,
    units: data.hourly_units || {},
    vars,
    elevation: data.elevation,
    nights,
  };
}

async function tryFetch(url, fetchImpl) {
  try {
    const resp = await fetchImpl(url);
    const body = await resp.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return null; // Fehler als Klartext -> Fallback
    }
    if (!resp.ok || data.error) return null;
    return data;
  } catch {
    return null;
  }
}

/** Index der Zeitreihe, der der Wanduhr am nächsten liegt (nie in der
 *  Vergangenheit, solange Zukunft vorhanden ist). */
export function nearestFutureIndex(timeSec, nowMs = Date.now()) {
  const now = nowMs / 1000;
  if (!timeSec.length) return -1;
  for (let i = 0; i < timeSec.length; i++) {
    if (timeSec[i] >= now - 1800) return i; // bis 30 min zurück gilt noch als "jetzt"
  }
  return timeSec.length - 1;
}

function round5(x) {
  return Math.round(x * 1e5) / 1e5;
}
