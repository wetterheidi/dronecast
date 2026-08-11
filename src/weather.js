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

  // `time` reicht immer bis zum angefragten forecast_days-Horizont, auch wenn
  // das Modell (z. B. ICON-D2, ~48 h) real kürzer vorhersagt — die API füllt
  // den Rest der Kernvariable mit null statt das Array zu kürzen. Auf den
  // echten Modellhorizont zurückschneiden, sonst zeigen Meteogramm & Co. eine
  // "leere" Verlängerung bis zum gewählten Zeithorizont.
  const cut = vars.temperature_2m ? lastFiniteIndex(vars.temperature_2m) + 1 : time.length;
  const trim = (arr) => (cut < arr.length ? arr.slice(0, cut) : arr);
  const trimmedVars = {};
  for (const key of Object.keys(vars)) trimmedVars[key] = trim(vars[key]);

  return {
    time: trim(time),
    units: data.hourly_units || {},
    vars: trimmedVars,
    elevation: data.elevation,
    nights,
  };
}

/**
 * Initialisierungszeitpunkt des aktuell verfügbaren Modelllaufs (z. B.
 * der "00-UTC-Lauf"), unabhängig von Ort/Höhe. Quelle: Michaels Instanz(en)
 * (`model.apiBase`, siehe config.js — ICON Global liegt auf einem anderen
 * Host als ICON-D2/-EU) — deren statisches Meta-JSON je Datensatz liefert
 * `last_run_initialisation_time` (unixtime s). Nicht die öffentliche
 * OpenMeteo-Instanz (`SURFACE_API_BASE`); "Open-Meteo" bezeichnet hier nur
 * das API-/Datenformat, das auch Michaels Server verwenden.
 * Liefert null bei Fehler (z. B. Netzwerk), damit der Infobutton im Panel
 * nicht das gesamte Laden blockiert.
 */
export async function fetchModelRunInit(modelKey, fetchImpl = fetch.bind(globalThis)) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unbekanntes Modell: ${modelKey}`);
  try {
    const resp = await fetchImpl(`${model.apiBase}/data/${model.dataset}/static/meta.json`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return Number.isFinite(data.last_run_initialisation_time) ? data.last_run_initialisation_time : null;
  } catch {
    return null;
  }
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

/** Index der Zeitreihe, der einem beliebigen Zeitpunkt am nächsten liegt
 *  (symmetrisch, darf in der Vergangenheit landen). Für die Masterzeit: das
 *  Stundenraster des Modells rastet auf die nächste verfügbare Stunde. */
export function nearestIndex(timeSec, tMs) {
  if (!timeSec.length) return -1;
  const t = tMs / 1000;
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < timeSec.length; i++) {
    const diff = Math.abs(timeSec[i] - t);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
    else if (timeSec[i] > t) break; // Zeitreihe ist aufsteigend – ab hier nur größer
  }
  return best;
}

function round5(x) {
  return Math.round(x * 1e5) / 1e5;
}

/** Letzter Index, an dem mindestens eine der übergebenen Kernreihen noch einen
 *  endlichen Wert hat — jenseits davon liefert das Modell nur noch null (der
 *  angefragte forecast_days-Horizont reicht weiter als der reale Modelllauf).
 *  Genutzt, um Zeitreihen auf den tatsächlich verfügbaren Zeitraum zu kürzen. */
export function lastFiniteIndex(...arrays) {
  let last = -1;
  for (const arr of arrays) {
    if (!arr) continue;
    for (let i = arr.length - 1; i > last; i--) {
      if (Number.isFinite(arr[i])) { last = i; break; }
    }
  }
  return last;
}
