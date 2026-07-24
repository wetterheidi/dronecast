/**
 * Go/No-Go-Auswertung: bewertet die Vorhersage stundenweise gegen die
 * Grenzwerte eines Drohnenprofils (siehe droneProfiles.js). Reine
 * Datentransformation, kein DOM-Zugriff — das Rendering übernimmt
 * gonogotable.js.
 *
 * Status je Zelle: "green" | "yellow" | "red" | "na" (Daten fehlen/Modell
 * liefert die Variable nicht — wird NIE stillschweigend als "green"
 * gewertet).
 */

import { cloudBaseAgl } from "./clouds.js";

const KMH_TO_MS = 1 / 3.6;

/**
 * @param surface     Rückgabe von fetchSurface() (weather.js)
 * @param windAtHeight Array parallel zu surface.time: {u,v} (m/s) oder null,
 *                     vorab z. B. per WindField.windAt() aufgelöst (app.js)
 * @param profile     Eintrag aus DRONE_PROFILES
 * @param opHeightM   Geplante Flughöhe AGL (i. d. R. settings.maxHeight) —
 *                     Wolkenbasis muss darüber liegen
 * @returns { time, rows: [{id,label,kind,cells:[{status,value|text}]}],
 *            conclusion: [{status, limitingId}] }
 */
export function evaluate(surface, windAtHeight, profile, opHeightM) {
  const time = surface.time;
  const v = surface.vars;
  const T = v.temperature_2m, Td = v.dew_point_2m, ccLow = v.cloud_cover_low;
  const wc = v.weather_code, gustsKmh = v.wind_gusts_10m;
  const visArr = v.visibility, precipArr = v.precipitation;
  const L = profile.limits;

  const rows = [
    numericRow("windAtHeight", "Wind auf Flughöhe", "wind", L.windAtHeight, profile.marginPct,
      time.map((_, i) => windSpeedAt(windAtHeight, i))),
    numericRow("gustSurface", "Böen 10 m", "wind", L.gustSurface, profile.marginPct,
      time.map((_, i) => (gustsKmh?.[i] != null ? gustsKmh[i] * KMH_TO_MS : null))),
    numericRow("cloudBase", "Wolkenbasis", "height", scaledMinLimit(L.cloudBase, opHeightM), profile.marginPct,
      time.map((_, i) => cloudBaseAgl(T?.[i], Td?.[i], ccLow?.[i])),
      { nullIsGreen: true }),
    numericRow("visibility", "Sicht", "vis", L.visibility, profile.marginPct,
      time.map((_, i) => (visArr ? visArr[i] ?? null : null))),
    numericRow("precipitation", "Niederschlag", "precip", L.precipitation, profile.marginPct,
      time.map((_, i) => (precipArr ? precipArr[i] ?? null : null))),
    numericRow("tempMin", "Temperatur (min)", "temp", L.tempMin, profile.marginPct,
      time.map((_, i) => (T ? T[i] ?? null : null))),
    numericRow("tempMax", "Temperatur (max)", "temp", L.tempMax, profile.marginPct,
      time.map((_, i) => (T ? T[i] ?? null : null))),
    hazardRow(time, wc, visArr),
  ];

  const conclusion = time.map((_, i) => conclusionAt(rows, i));
  return { time, rows, conclusion };
}

// --- Zeilen-Aufbau ----------------------------------------------------------

function numericRow(id, label, kind, limit, defaultMarginPct, valuesRaw, opts = {}) {
  const cells = valuesRaw.map((val) => {
    if (val == null || !Number.isFinite(val)) {
      return opts.nullIsGreen ? { status: "green", value: null } : { status: "na", value: null };
    }
    return { status: evalThreshold(val, limit, defaultMarginPct), value: val };
  });
  return { id, label, kind, limit, cells };
}

// Gewitter/gefrierender Niederschlag aus weather_code -> rot. Nebel nur dann
// als eigene Warnung, wenn die Sicht-Zeile die Lage nicht ohnehin numerisch
// abdeckt (Modell liefert `visibility` an diesem Zeitpunkt nicht).
function hazardRow(time, wc, visArr) {
  const cells = time.map((_, i) => {
    const code = wc?.[i];
    if (code === 95 || code === 96 || code === 99) return { status: "red", text: "Gewitter" };
    if (code === 56 || code === 57 || code === 66 || code === 67) return { status: "red", text: "gefr. Niederschlag" };
    if (code === 45 || code === 48) {
      const visKnown = visArr ? visArr[i] != null : false;
      return { status: visKnown ? "green" : "yellow", text: "Nebel" };
    }
    return { status: "green", text: "–" };
  });
  return { id: "hazard", label: "Sonstige Hazards", kind: "text", cells };
}

// --- Bewertung ---------------------------------------------------------------

function evalThreshold(value, limit, defaultMarginPct) {
  const margin = limit.marginPct ?? defaultMarginPct;
  if (limit.direction === "max") {
    if (value >= limit.value) return "red";
    if (value >= limit.value * (1 - margin)) return "yellow";
    return "green";
  }
  if (value <= limit.value) return "red";
  if (value <= limit.value * (1 + margin)) return "yellow";
  return "green";
}

// Wolkenbasis muss über der geplanten Flughöhe UND über dem profilspezifischen
// VLOS-Minimum liegen -> der strengere (größere) der beiden Werte gilt.
function scaledMinLimit(limit, floorValue) {
  return { ...limit, value: Math.max(limit.value, floorValue) };
}

function windSpeedAt(windAtHeight, i) {
  const w = windAtHeight?.[i];
  return w && Number.isFinite(w.u) && Number.isFinite(w.v) ? Math.hypot(w.u, w.v) : null;
}

// Gesamtstatus je Stunde: rot > "keine Daten" > gelb > grün — fehlende Daten
// dürfen nie stillschweigend als grün durchgehen (Sicherheitsprinzip).
function conclusionAt(rows, i) {
  const firstWithStatus = (status) => rows.find((r) => r.cells[i].status === status);
  const red = firstWithStatus("red");
  if (red) return { status: "red", limitingId: red.id };
  const na = firstWithStatus("na");
  if (na) return { status: "na", limitingId: na.id };
  const yellow = firstWithStatus("yellow");
  if (yellow) return { status: "yellow", limitingId: yellow.id };
  return { status: "green", limitingId: null };
}
