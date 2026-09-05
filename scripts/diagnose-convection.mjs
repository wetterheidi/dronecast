#!/usr/bin/env node
/**
 * Diagnose-Skript für das Entrainment-Schema in
 * meteokit/src/gramet/hazards/convection.js (Gregory 2001, kalibriert nach
 * Chikira & Sugiyama 2010 / NCAR-CCPP `cs_conv.F90` -- s. dortiger
 * Modulkopf "ENTRAINMENT" für Herleitung/Quellen) -- holt echte ICON-D2-
 * Profile für eine Reihe kontinentaler Sommerorte (das Zielregime dieses
 * Schemas, s. Modulkopf) und gibt pro Stunde CCL/TA/undiluted-EL/verdünntes
 * EL/ECAPE als Tabelle aus. Damit lässt sich der Tagesgang direkt
 * beurteilen: wächst der verdünnte Oberrand über den Nachmittag hinweg
 * glatt (Cu humilis -> Cu mediocris -> TCU), statt zu springen oder
 * unvermittelt auf null zu fallen?
 *
 * Anders als calibrate-clouds.mjs FITTET dieses Skript nichts -- die
 * Entrainment-Konstanten stammen aus Literatur/echtem Schema-Code, nicht
 * aus einer Kurvenanpassung an diese Daten. Reiner Anzeige-/
 * Plausibilitätscheck, kein automatisierter Vorschlag für neue Werte.
 *
 * Zwei zusätzliche Spalten dienen der offenen Diskussion um EL-Bestimmung
 * ("erster Nulldurchgang" vs. finaler, KE-geprüfter Oberrand, s. Modulkopf
 * "ENTRAINMENT" in convection.js):
 *   - `1.ND(m)` = `elZDilutedFirstCross`: Höhe des ERSTEN Auftriebs-
 *     Nulldurchgangs. Weicht sie von `EL_dil(m)` ab, hat der Updraft laut
 *     Gregory-KE-Bilanz eine dünne Kappe durchstoßen -- Häufigkeit/Größe
 *     dieser Abweichung in echten Profilen ist genau die noch offene
 *     empirische Frage.
 *   - `wx` = `weather_code`-Klartext (SH/TS/...), um zu sehen, wie oft das
 *     Modell selbst Konvektion meldet, während unsere CCL-Rechnung gar nicht
 *     oder nur sehr flach auslöst (s. `derive.js` Fallback-Kette für `top`,
 *     wenn `elZDiluted` fehlt oder verdächtig niedrig bleibt).
 *
 * `computeColumns` ist bewusst NICHT Teil der öffentlichen
 * `meteokit/gramet`-Oberfläche (s. dortiger `gramet/index.js`-Kopf:
 * "Alles, was hier nicht re-exportiert wird, ist bibliotheksintern und darf
 * sich ohne Rücksicht auf einbettende Apps ändern"). Hier trotzdem per
 * relativem Pfad direkt importiert, weil genau das der Zweck dieses Skripts
 * ist (Physik-Diagnose, nicht Endnutzung wie in der App) -- das nimmt in
 * Kauf, dass dieser Import bei internen Umbauten in convection.js eher
 * bricht als einer über den Paketnamen.
 *
 * Nutzung:  node scripts/diagnose-convection.mjs
 * (kein Build nötig -- importiert direkt aus src/)
 */

import { fetchColumn } from "meteokit/column";
import { fetchSurface } from "meteokit/weather";
import { gridFromColumn } from "meteokit/gramet";
import { metarWeather } from "meteokit/briefing";
import { computeColumns } from "../../meteokit/src/gramet/hazards/convection.js";

// Michaels Modell-Level-Server lässt per Caddy-CORS-Allowlist nur bekannte
// Produktions-Origins durch (s. vite.config.js) -- im Dev-Betrieb übernimmt
// das Vites Node-Proxy serverseitig, ein eigenständiges Skript wie dieses
// läuft aber nie durch diesen Proxy und hätte sonst gar keine Origin-Zeile.
// Anders als im Browser ist das Setzen von `Origin` aus Node heraus erlaubt
// (kein "forbidden header name"), daher hier direkt nachgebildet statt über
// den Vite-Proxy zu gehen.
const fetchWithOrigin = (url, opts) => fetch(url, {
  ...opts,
  headers: { ...(opts?.headers || {}), Origin: "https://dronecast.wetterheidi.de" },
});

const FORECAST_DAYS = 3;
// Kontinentale, sommerliche Cu-Tage sind das Zielregime dieses Schemas (s.
// Modulkopf convection.js) -- bewusst mitteleuropäisch/alpin statt wie bei
// calibrate-clouds.mjs breit über ganz Europa gestreut. Bei Bedarf um
// weitere Wetterlagen (Herbst, Mittelmeer-Hitzetage, ...) erweitern.
const POINTS = [
  { lat: 48.2, lon: 16.37, model: "icon_d2", label: "Wien" },
  { lat: 47.27, lon: 11.4, model: "icon_d2", label: "Innsbruck (alpin)" },
  { lat: 47.32, lon: 12.8, model: "icon_d2", label: "Zell am See (alpin)" },
  { lat: 48.14, lon: 11.58, model: "icon_d2", label: "München" },
  { lat: 50.11, lon: 8.68, model: "icon_d2", label: "Frankfurt" },
  { lat: 52.52, lon: 13.4, model: "icon_d2", label: "Berlin" },
];
// Auslöse-Zuschlag TRIGGER_EXCESS_K aus derive.js -- nur zur Einordnung
// hier gespiegelt (die Auslöse-Entscheidung selbst trifft dieses Skript
// nicht, das bleibt derive.js/cbColumns vorbehalten).
const TRIGGER_EXCESS_K = 1;

function fmt(v, digits = 0) {
  return Number.isFinite(v) ? v.toFixed(digits) : "--";
}

// Grobe lokale Stunde nur zur Tagesgang-Einordnung in der Anzeige (echte
// Zeitzone unbekannt -- Längengrad-Näherung reicht dafür aus).
function localHour(tSec, lon) {
  const utcH = new Date(tSec * 1000).getUTCHours();
  return ((utcH + Math.round(lon / 15)) % 24 + 24) % 24;
}

for (const pt of POINTS) {
  console.log(`\n=== ${pt.label} (${pt.lat}, ${pt.lon}) ${pt.model} ===`);
  const [col, surface] = await Promise.all([
    fetchColumn(pt.lat, pt.lon, pt.model, FORECAST_DAYS, fetchWithOrigin),
    fetchSurface(pt.lat, pt.lon, pt.model, FORECAST_DAYS, fetchWithOrigin),
  ]);
  const grid = gridFromColumn(col, surface, pt.lat, pt.lon);
  const conv = computeColumns(grid);

  console.log(
    "Std lokZ  CCL(m)  TA(°C) T2m(°C)  |  EL_undil(m)  CAPE  |  EL_dil(m)  1.ND(m)  ECAPE  Tiefe_dil(m)  wx"
  );
  let shown = 0;
  for (let i = 0; i < conv.length; i++) {
    const c = conv[i];
    if (!c) continue;
    const triggered = c.tSfcC >= c.taC - TRIGGER_EXCESS_K;
    if (!triggered && c.cape < 20) continue; // Ruhephasen ohne jede Instabilität ausblenden
    const depth = Number.isFinite(c.elZDiluted) ? c.elZDiluted - c.cclZ : NaN;
    const wx = Number.isFinite(grid.surface?.wcode?.[i]) ? metarWeather(grid.surface.wcode[i]) : "";
    console.log(
      `${String(i).padStart(3)} ${String(localHour(grid.times[i], pt.lon)).padStart(2)}h  ` +
      `${fmt(c.cclZ).padStart(6)}  ${fmt(c.taC, 1).padStart(6)} ${fmt(c.tSfcC, 1).padStart(7)}  |  ` +
      `${fmt(c.elZ).padStart(10)}  ${fmt(c.cape).padStart(5)}  |  ` +
      `${fmt(c.elZDiluted).padStart(8)}  ${fmt(c.elZDilutedFirstCross).padStart(7)}  ` +
      `${fmt(c.ecape, 1).padStart(6)}  ${fmt(depth).padStart(6)}  ${wx}` +
      (triggered ? "  *ausgelöst" : "")
    );
    shown++;
  }
  if (!shown) console.log("(keine Stunde mit Instabilität >= 20 J/kg im Vorhersagezeitraum)");
}
