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
import { fmtHeight } from "./units.js";
import { ipiStatus, ipiCategory } from "./gramet/hazards/icing.js";
import { tfiStatus, tfiCategory } from "./gramet/hazards/turbulence.js";

const KMH_TO_MS = 1 / 3.6;

/**
 * @param surface      Rückgabe von fetchSurface() (weather.js)
 * @param windBandMax  Array parallel zu surface.time: Maximum der mittleren
 *                     Windgeschwindigkeit (m/s) zwischen 10 m und opHeightM,
 *                     oder null — vorab z. B. per WindField.windAt() über
 *                     mehrere Höhen aufgelöst (app.js)
 * @param profile      Eintrag aus DRONE_PROFILES
 * @param opHeightM    Geplante Flughöhe AGL (i. d. R. settings.maxHeight) —
 *                     Wolkenbasis muss darüber liegen, Bandmaximum bis dorthin
 * @param cloudCeilingArr Optionales Array parallel zu surface.time: Wolken-
 *                     untergrenze (m AGL) aus dem Modell-RH-Profil
 *                     (clouds.js `cloudCeiling`) je Stunde -- `null`, wo die
 *                     Säule vorliegt, aber keine tiefe BKN-Schicht diagnos-
 *                     tiziert wurde (bleibt so), `undefined`, wo die Säule
 *                     an dieser Stunde real endet (z. B. ICON Global: Modell-
 *                     Level nur bis +36 h, Oberflächenreihe länger) -- dort
 *                     fällt die Zeile auf die LCL-Schätzung zurück. Fehlt das
 *                     Array ganz (Säule nicht geladen), gilt dasselbe für
 *                     jede Stunde.
 * @param fogArr       Optionales Array parallel zu surface.time:
 *                     `{type, certain, freezing} | null | undefined` je Stunde
 *                     aus der Säule (clouds.js `classifyFog`) — sichtbasierte
 *                     Nebel/Dunst-Diagnose, dieselbe Priorität wie GRAMETs
 *                     `hazards/fog.js`, ERSETZT (nicht mehr additiv zu) die
 *                     reine `weather_code`-Erkennung, damit die "Sonstige
 *                     Hazards"-Zeile nicht der GRAMET-Diagnose widerspricht.
 *                     `undefined` markiert Stunden jenseits des Säulen-
 *                     horizonts (s. cloudCeilingArr) -- dort bleibt roher
 *                     `weather_code` die einzige Nebelquelle, wie wenn das
 *                     Array ganz fehlt.
 * @param icingBandMaxArr Optionales Array parallel zu surface.time:
 *                     `{ipi, bandBottomM, bandTopM}` (Maximum des
 *                     Icing-Potential-Index, 0..1, `hazards/icing.js` `ipiAt`,
 *                     plus Höhenband der stärksten Vereisung) zwischen 10 m
 *                     und opHeightM, analog `windBandMax` aber synchron aus
 *                     der bereits geladenen Säule bestimmt (`icingBandMaxAt`
 *                     in app.js) — keine eigene Fetch-Pipeline nötig.
 * @param turbulenceBandMaxArr Optionales Array parallel zu surface.time:
 *                     `{tfi, bandBottomM, bandTopM}` (Maximum des
 *                     Turbulence-Flag-Index, 0..1, `hazards/turbulence.js`
 *                     `tfiAt`, plus Höhenband der stärksten Turbulenz)
 *                     zwischen 10 m und opHeightM — analog `icingBandMaxArr`,
 *                     synchron aus derselben Säule bestimmt
 *                     (`turbulenceBandMaxAt` in app.js). Deckt NUR das
 *                     Flugband oberhalb 10 m ab; Bodenböigkeit bleibt die
 *                     separate `gustSurface`-Zeile (keine Doppelung).
 * @returns { time, rows: [{id,label,kind,cells:[{status,value|text,subtext?}]}],
 *            conclusion: [{status, limitingId}] }
 */
export function evaluate(
  surface, windBandMax, profile, opHeightM, cloudCeilingArr = null, fogArr = null, icingBandMaxArr = null,
  turbulenceBandMaxArr = null,
) {
  const time = surface.time;
  const v = surface.vars;
  const T = v.temperature_2m, Td = v.dew_point_2m, ccLow = v.cloud_cover_low;
  const wc = v.weather_code, gustsKmh = v.wind_gusts_10m, windKmh = v.wind_speed_10m;
  const visArr = v.visibility, precipArr = v.precipitation;
  const L = profile.limits;

  const rows = [
    numericRow("windSurface", "Wind 10 m", "wind", L.windSurface, profile.marginPct,
      time.map((_, i) => (windKmh?.[i] != null ? windKmh[i] * KMH_TO_MS : null))),
    numericRow("gustSurface", "Böen 10 m", "wind", L.gustSurface, profile.marginPct,
      time.map((_, i) => (gustsKmh?.[i] != null ? gustsKmh[i] * KMH_TO_MS : null))),
    numericRow("windBandMax", `Wind Maximum (10 m–${fmtHeight(opHeightM)})`, "wind", L.windBandMax, profile.marginPct,
      time.map((_, i) => windBandMax?.[i] ?? null)),
    numericRow("cloudBase", "Wolkenbasis", "height", scaledMinLimit(L.cloudBase, opHeightM), profile.marginPct,
      time.map((_, i) => {
        const cc = cloudCeilingArr ? cloudCeilingArr[i] : undefined;
        return cc !== undefined ? cc : cloudBaseAgl(T?.[i], Td?.[i], ccLow?.[i]);
      }),
      { nullIsGreen: true }),
    numericRow("visibility", "Sicht", "vis", L.visibility, profile.marginPct,
      time.map((_, i) => (visArr ? visArr[i] ?? null : null))),
    numericRow("precipitation", "Niederschlag", "precip", L.precipitation, profile.marginPct,
      time.map((_, i) => (precipArr ? precipArr[i] ?? null : null))),
    rangeRow("temperature", "Temperatur", "temp", L.tempMin, L.tempMax, profile.marginPct,
      time.map((_, i) => (T ? T[i] ?? null : null))),
    icingRow(time, icingBandMaxArr, opHeightM),
    turbulenceRow(time, turbulenceBandMaxArr, opHeightM),
    hazardRow(time, wc, visArr, fogArr),
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

// Vereisungs-Intensität statt Prozentzahl: Piloten kennen die Vereisung
// üblicherweise als Stufen (Trace/Light/Moderate/Severe), keinen Indexwert --
// `ipiCategory()` liefert exakt diese vier Stufen (none/light/moderate/
// severe), hier auf die deutschen Tabellenbegriffe gemappt. Ampelfarbe kommt
// separat aus `ipiStatus()` (gröber, drei Stufen, s. hazards/icing.js) --
// beide Funktionen teilen dieselben Schwellen, nur die Bucketing-Auflösung
// unterscheidet sich. Keine Profil-Grenze (noch keine drohnenspezifische
// Vereisungstoleranz), daher kein `evalThreshold`.
const ICING_LABEL = { none: "keine", light: "leicht", moderate: "mäßig", severe: "stark" };

// `icingBandMaxArr[i]` ist `{ipi, bandBottomM, bandTopM}` (s. `icingBandMaxAt`
// in app.js) -- die Höhengrenzen kommen als zweite, kleinere Zeile dazu
// (`subtext`, s. gonogotable.js), damit man nicht nur die Intensität sieht,
// sondern auch WO in der Säule sie zu erwarten ist. Kein Band bei "keine"
// (bandBottomM/TopM null) -> nur die Intensitätszeile.
function icingRow(time, icingBandMaxArr, opHeightM) {
  const cells = time.map((_, i) => {
    const b = icingBandMaxArr ? icingBandMaxArr[i] : null;
    if (!b || !Number.isFinite(b.ipi)) return { status: "na", text: "–" };
    const cell = { status: ipiStatus(b.ipi), text: ICING_LABEL[ipiCategory(b.ipi)] };
    if (Number.isFinite(b.bandBottomM) && Number.isFinite(b.bandTopM)) {
      cell.subtext = `${fmtHeight(b.bandBottomM)}–${fmtHeight(b.bandTopM)}`;
    }
    return cell;
  });
  return { id: "icing", label: `Vereisung (10 m–${fmtHeight(opHeightM)})`, kind: "text", cells };
}

// Wie ICING_LABEL: vier Stufen aus `tfiCategory()`, deutsche Turbulenz-
// Begriffe (auch im deutschsprachigen Luftfahrtjargon "leicht/mäßig/stark").
const TURB_LABEL = { none: "keine", light: "leicht", moderate: "mäßig", severe: "stark" };

// `turbulenceBandMaxArr[i]` ist `{tfi, bandBottomM, bandTopM}` (s.
// `turbulenceBandMaxAt` in app.js) -- Aufbau exakt wie `icingRow`: Kategorie-
// Label + Ampel aus denselben Schwellen, Höhenband als subtext. Deckt NUR
// das Flugband oberhalb 10 m ab (dynamische/thermische Instabilität aus Ri/
// Scherung) -- Bodenböigkeit bleibt die vorhandene Böen-Zeile (`gustSurface`
// oben) bzw. das Böen-Overlay, keine Doppelung in beiden Medien.
function turbulenceRow(time, turbulenceBandMaxArr, opHeightM) {
  const cells = time.map((_, i) => {
    const b = turbulenceBandMaxArr ? turbulenceBandMaxArr[i] : null;
    if (!b || !Number.isFinite(b.tfi)) return { status: "na", text: "–" };
    const cell = { status: tfiStatus(b.tfi), text: TURB_LABEL[tfiCategory(b.tfi)] };
    if (Number.isFinite(b.bandBottomM) && Number.isFinite(b.bandTopM)) {
      cell.subtext = `${fmtHeight(b.bandBottomM)}–${fmtHeight(b.bandTopM)}`;
    }
    return cell;
  });
  return { id: "turbulence", label: `Turbulenz (10 m–${fmtHeight(opHeightM)})`, kind: "text", cells };
}

// Ein Wert, zwei Grenzen (min UND max, z. B. Betriebstemperatur nach unten
// und oben) — als EINE Zeile mit dem jeweils strengeren Status, statt zwei
// Zeilen für denselben stündlichen Messwert.
function rangeRow(id, label, kind, minLimit, maxLimit, defaultMarginPct, valuesRaw) {
  const cells = valuesRaw.map((val) => {
    if (val == null || !Number.isFinite(val)) return { status: "na", value: null };
    const sMin = minLimit ? evalThreshold(val, minLimit, defaultMarginPct) : "green";
    const sMax = maxLimit ? evalThreshold(val, maxLimit, defaultMarginPct) : "green";
    return { status: worseStatus(sMin, sMax), value: val };
  });
  return { id, label, kind, cells };
}

// Gewitter/gefrierender Niederschlag aus weather_code -> rot. Nebel: liegt
// `fogArr` vor (clouds.js `classifyFog`, sichtbasiert), entscheidet dessen
// Befund ALLEIN -- ERSETZT den rohen weather_code-Trigger, dessen 45/48 einer
// per Sicht widerlegten Nebelmeldung widersprechen konnte (s. Feedback).
// Fehlt `fogArr` ganz (Säule nicht geladen), bleibt weather_code 45/48 der
// einzige verfügbare Nebel-Hinweis. Als eigene Warnung nur, wenn die
// Sicht-Zeile die Lage nicht ohnehin numerisch abdeckt (Modell liefert
// `visibility` an diesem Zeitpunkt nicht).
function hazardRow(time, wc, visArr, fogArr) {
  const cells = time.map((_, i) => {
    const code = wc?.[i];
    if (code === 95 || code === 96 || code === 99) return { status: "red", text: "Gewitter" };
    if (code === 56 || code === 57 || code === 66 || code === 67) return { status: "red", text: "gefr. Niederschlag" };
    const fog = fogArr ? fogArr[i] : undefined;
    // `undefined` = Säule endet hier (s. Doc oben) -> wie fehlendes Array
    // auf den rohen weather_code zurückfallen, statt fälschlich "kein Nebel".
    const fogKnown = fogArr && fog !== undefined;
    const isFog = fogKnown ? fog?.type === "FG" : (code === 45 || code === 48);
    if (isFog) {
      const visKnown = visArr ? visArr[i] != null : false;
      const freezing = fogKnown ? fog?.freezing : code === 48;
      return { status: visKnown ? "green" : "yellow", text: freezing ? "Gefr. Nebel" : "Nebel" };
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

const STATUS_RANK = { green: 0, yellow: 1, na: 1, red: 2 };
function worseStatus(a, b) {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

// Wolkenbasis muss über der geplanten Flughöhe UND über dem profilspezifischen
// VLOS-Minimum liegen -> der strengere (größere) der beiden Werte gilt.
function scaledMinLimit(limit, floorValue) {
  return { ...limit, value: Math.max(limit.value, floorValue) };
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
