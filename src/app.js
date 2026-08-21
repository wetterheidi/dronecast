import {
  MODELS, PREVIEW_HEIGHTS, MIN_MAX_HEIGHT, MAX_MAX_HEIGHT, TERRAIN_MISMATCH_WARN_M,
} from "./config.js";
import { WindField } from "./windfield.js";
import { fetchSurface, fetchModelRunInit, nearestIndex, nearestIndexOrNull } from "meteokit/weather";
import {
  initTimeControls, setRange, getMasterMs, setMasterMs, subscribe as subscribeTime, HOUR_MS,
} from "./timeController.js";
import { renderMeteogram } from "./meteogram.js";
import { fetchColumn, buildField, sliceColumnAtTime } from "meteokit/column";
import { cloudCeiling, cloudLayers, classifyFog } from "meteokit/clouds";
import { renderCrossSection } from "meteokit/crosssection";
import { gridFromColumn, sampleAt, derive } from "meteokit/gramet";
import { ipiAt, ipiCategoryFloor, tfiAt, tfiCategoryFloor } from "meteokit/gramet/hazards";
import "meteokit/components/gramet-panel";
import "./components/windspinne-panel/windspinne-panel.js";
import { buildBriefingHtml, buildBriefingContent } from "meteokit/briefing";
import { evaluate as evaluateGoNoGo } from "./gonogo.js";
import { renderGoNoGoTable } from "./gonogotable.js";
import { DRONE_PROFILES } from "./droneProfiles.js";
import {
  listProfiles, getProfile, isEditable, getUserProfiles,
  duplicateProfile, createBlankProfile, updateProfile, deleteProfile,
  exportUserProfiles, importProfiles,
} from "./droneProfileStore.js";
import { renderProfileDetails } from "./droneProfileView.js";
import { renderProfileEditor } from "./droneProfileEditor.js";
import * as astro from "meteokit/astro";
import { settings, loadSettings, updateSetting, OPTIONS } from "./settings.js";
import { parseCoordInput } from "./coords.js";
import { initGeoman } from "./geoman.js";
import { initMapLayers } from "./maplayers.js";
import { initWindOverlay, WIND_FILL_STOPS } from "./windoverlay.js";
import { initGustOverlay } from "./gustoverlay.js";
import { initCloudOverlay } from "./cloudoverlay.js";
import { initDemOverlay } from "./demoverlay.js";
import {
  fmtHeight, fmtWind, fmtTemp, fmtDirPadded, heightUnit, heightToDisplay, heightFromDisplay,
} from "meteokit/units";
import { throttle, qfeAtTarget } from "./overlayshared.js";

/* global L */

const el = (id) => document.getElementById(id);
const state = { point: null, marker: null, data: null, coordInputDirty: false, briefingDay: null };

// Einstellungen vor Karteninit laden, damit Startposition/Basiskarte bereitstehen.
loadSettings();

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------
const initialCenter = settings.lastPoint ? [settings.lastPoint.lat, settings.lastPoint.lon] : [48.2, 11.6];
const initialZoom = settings.lastPoint ? 11 : 7;
const map = L.map("map", { zoomControl: true }).setView(initialCenter, initialZoom);

// Basiskarten: OSM und Esri-Hybrid (Satellitenbild + Beschriftung), wie in trajectories.
const baseLayers = {
  "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  }),
  "Esri Satellit (hybrid)": L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
    }),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      pane: "overlayPane",
      zIndex: 2,
    }),
  ], {
    attribution: "© Esri, USDA, USGS © OpenStreetMap contributors, and the GIS user community",
  }),
};
const initialBase = baseLayers[settings.baseLayer] ? settings.baseLayer : "OpenStreetMap";
baseLayers[initialBase].addTo(map);
L.control.layers(baseLayers, null, { position: "topleft" }).addTo(map);
map.on("baselayerchange", (e) => updateSetting("baseLayer", e.name));

// Geoman-Zeichenwerkzeug (Marker/Linie/Kreis, Peilung/Radius-Labels).
initGeoman(map);

// Kartenlayer: Satellit (DWD-WMS) + Niederschlagsradar (RainViewer).
initMapLayers(map);

// Kartenlayer: Wind 10 m flächig (unterstes Modelllevel, Michaels Instanz) —
// nach initMapLayers, da der gemeinsame wxOverlays-Pane dort angelegt wird.
// Jeder Layer liefert ein valueAt(lat, lon) zurück (Punktabfrage aus dessen
// Cache, dieselbe bilineare Interpolation wie beim Flächen-Rendering) — Basis
// für die Cursor-Statuszeile weiter unten.
const windOverlay = initWindOverlay(map);

// Kartenlayer: Windböen 10 m flächig (Oberfläche, öffentliche Instanz) —
// Schwesterlayer zum Wind-Overlay, teilt sich den wxOverlays-Pane.
const gustOverlay = initGustOverlay(map);

// Kartenlayer: Bedeckungsgrad (tief/mittel/hoch) + Ceiling, flächig —
// dieselbe clouds.js-Methodik wie Meteogramm/Briefing, hier räumlich statt
// am Operationspunkt. Datenquelle wie Wind: Michaels Instanz.
const cloudOverlay = initCloudOverlay(map);

// Kartenlayer (Testfeature): Δ Modell-Orographie − DEM90-Geländehöhe,
// flächig — räumliche Darstellung derselben Diagnose, die am Operationspunkt
// schon als „Modellorographie"-Zeile läuft (renderNow() unten, METHODIK.md
// 5b). Statisch, keine Masterzeit-Kopplung.
const demOverlay = initDemOverlay(map);

// Cursor-Statuszeile: zeigt für JEDEN aktuell eingeschalteten Kartenlayer den
// Wert unter dem Mauszeiger an (nicht nur den obersten) — Nutzerentscheidung,
// weil die Layer sich farblich/räumlich unterscheiden und meist bewusst
// zusammen betrachtet werden (z. B. Wind + Ceiling für die Flugplanung).
// Throttled wie das Flächen-Rendering (siehe overlayshared.js throttle()):
// mousemove feuert deutlich öfter als sinnvoll neu gezeichnet werden muss.
const cursorReadout = el("map-cursor-readout");
let pendingLatLng = null;
function renderCursorReadout() {
  if (!pendingLatLng) return;
  const { lat, lng } = pendingLatLng;
  const parts = [];
  const wind = windOverlay.valueAt(lat, lng);
  if (wind) parts.push(`Wind ${fmtDirPadded(wind.dirDeg)} ${fmtWind(wind.speedMs)}`);
  const gust = gustOverlay.valueAt(lat, lng);
  if (gust) parts.push(`Böen ${fmtWind(gust.speedMs)}`);
  const cloud = cloudOverlay.valueAt(lat, lng);
  if (cloud?.coverPct != null) parts.push(`Bedeckung ${Math.round(cloud.coverPct)} %`);
  if (cloud?.ceilingM != null) parts.push(`Ceiling ${fmtHeight(cloud.ceilingM)} AGL`);
  const dem = demOverlay.valueAt(lat, lng);
  if (dem?.deltaM != null) {
    const sign = dem.deltaM >= 0 ? "+" : "−";
    parts.push(`Δ Gelände ${sign}${Math.round(Math.abs(heightToDisplay(dem.deltaM)))} ${heightUnit()}`);
  } else if (dem?.deltaHpa != null) {
    const sign = dem.deltaHpa >= 0 ? "+" : "−";
    parts.push(`ΔQFE ${sign}${Math.abs(dem.deltaHpa).toFixed(1)} hPa`);
  }
  cursorReadout.hidden = !parts.length;
  if (parts.length) cursorReadout.textContent = parts.join(" · ");
}
const throttledCursorReadout = throttle(renderCursorReadout, 100);
map.on("mousemove", (e) => {
  pendingLatLng = e.latlng;
  throttledCursorReadout();
});
// pendingLatLng mit leeren, nicht nur die Pille verstecken: throttle() feuert
// nachlaufend (führend + nachlaufend, s. overlayshared.js) — ein beim Verlassen
// der Karte noch ausstehender Timer würde sonst kurz danach mit der letzten
// (noch gültigen) Position erneut rendern und die Pille wieder einblenden.
map.on("mouseout", () => { pendingLatLng = null; cursorReadout.hidden = true; });

// Masterzeit: die eine Zeitachse für Bedingungen, numerische Felder und
// Nowcasting. Nach initMapLayers/initWindOverlay verdrahten — die haben sich
// dort bereits als Subscriber registriert und reagieren auf das erste
// setRange(). Das Fenster wird schon vor dem ersten Laden gesetzt, damit
// Nowcasting (Radar/Sat) eigenständig ohne Punktvorhersage funktioniert;
// loadForecast() verfeinert die Grenzen später auf die echte Zeitreihe.
initTimeControls();
setMasterRange();
subscribeTime(() => {
  if (!state.data) return;
  renderNow();
  // Windspinne zeigt (anders als GRAMET/Cross-Section) nur EINEN Zeitpunkt --
  // muss deshalb bei jedem Masterzeit-Tick neu gezeichnet werden, nicht nur
  // beim Öffnen. Ohne bereits geladene Säule (noch nicht geöffnet) nichts tun.
  if (!el("windspinne").hidden && state.data.col) renderWs();
  syncGrametCursor();
});

// GRAMET zeigt den ganzen Zeitraum auf einmal -- ein Masterzeit-Wechsel lädt
// dort also nichts nach, sondern verschiebt nur die Cursorlinie. Damit ist im
// Querschnitt jederzeit ablesbar, welcher Zeitpunkt gerade auf der Karte
// liegt. Im Punkt-Modus ist `pos` die Epochensekunde (s. `gridFromColumn`),
// die Umrechnung deshalb nur ms -> s.
function syncGrametCursor() {
  const gm = el("gramet");
  if (gm.hidden || !gm.grid) return;
  gm.cursor = getMasterMs() / 1000;
}

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Untergrenze 00Z heute (ab dort werden auch die numerischen Daten gehostet),
// Obergrenze das Ende des Vorhersagehorizonts. Ohne geladene Zeitreihe eine
// Schätzung aus dem eingestellten Horizont; mit Daten die echten Grenzen.
function setMasterRange() {
  const minMs = startOfTodayMs();
  const maxMs = state.data?.surface?.time?.length
    ? state.data.surface.time[state.data.surface.time.length - 1] * 1000
    : Date.now() + settings.forecastDays * 24 * 3600e3;
  setRange(minMs, maxMs);
}

// Punkt per Rechtsklick (Desktop) oder Long-Press (Touch) setzen und sofort
// laden. requestPoint entprellt, weil mobile Browser beim Long-Press oft
// zusätzlich ein contextmenu-Event feuern — sonst würde doppelt geladen.
let lastPointRequestAt = 0;
function requestPoint(lat, lon) {
  const now = Date.now();
  if (now - lastPointRequestAt < 700) return;
  lastPointRequestAt = now;
  // Punkt kommt von der Karte, nicht aus dem Eingabefeld — ein dort noch
  // stehender, nicht übernommener Text wäre jetzt veraltet und dürfte beim
  // nächsten Klick auf "Vorhersage laden" nicht versehentlich diesen Punkt
  // überschreiben (siehe goToCoordInput-Aufruf im load-Handler unten).
  el("coordinput").value = "";
  state.coordInputDirty = false;
  setPoint(lat, lon, { autoLoad: true });
}

// Rechtsklick auf die Karte setzt/verschiebt den Operationspunkt. Bewusst NICHT
// der Linksklick, damit das Arbeiten mit dem Geoman-Werkzeug den Marker nicht
// versehentlich verschiebt. Alternativ per Drag verschiebbar (dragend unten).
map.on("contextmenu", (e) => {
  if (map.pm.globalDrawModeEnabled() || map.pm.globalEditModeEnabled()) return;
  requestPoint(e.latlng.lat, e.latlng.lng);
});

// Long-Press auf Touch-Displays als Ersatz für den Rechtsklick: eigene
// Erkennung, da Leaflet kein verlässliches Long-Press-Event liefert.
(function enableLongPressPoint() {
  const container = map.getContainer();
  const HOLD_MS = 500;   // Haltedauer bis zum Auslösen
  const MOVE_TOL = 12;   // erlaubte Fingerbewegung (px); mehr = Pan/Zoom
  let timer = null, startX = 0, startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

  container.addEventListener("touchstart", (e) => {
    // Nur Einzelfinger, nicht während Geoman zeichnet/editiert, nicht auf dem
    // (ziehbaren) Marker selbst.
    if (e.touches.length !== 1) { cancel(); return; }
    if (map.pm.globalDrawModeEnabled() || map.pm.globalEditModeEnabled()) return;
    if (e.target.closest && e.target.closest(".leaflet-marker-icon")) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const rect = container.getBoundingClientRect();
      const cp = L.point(startX - rect.left, startY - rect.top);
      const ll = map.containerPointToLatLng(cp);
      requestPoint(ll.lat, ll.lng);
    }, HOLD_MS);
  }, { passive: true });

  container.addEventListener("touchmove", (e) => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > MOVE_TOL || Math.abs(t.clientY - startY) > MOVE_TOL) cancel();
  }, { passive: true });

  container.addEventListener("touchend", cancel, { passive: true });
  container.addEventListener("touchcancel", cancel, { passive: true });
})();

function setPoint(lat, lon, { autoLoad = false } = {}) {
  state.point = { lat, lon };
  const label = `${lat.toFixed(4)}°N ${lon.toFixed(4)}°E`;
  el("pointpos").textContent = label;
  if (state.marker) {
    state.marker.setLatLng([lat, lon]);
  } else {
    // Ziehbarer Marker; pmIgnore hält ihn aus dem Geoman-Editiermodus heraus.
    state.marker = L.marker([lat, lon], { draggable: true, pmIgnore: true }).addTo(map);
    // Nach dem Ziehen: neuen Punkt übernehmen und Vorhersage sofort neu laden.
    state.marker.on("dragend", () => {
      const p = state.marker.getLatLng();
      // Wie bei requestPoint: Karteninteraktion macht einen noch nicht
      // übernommenen Eingabefeld-Text ungültig.
      el("coordinput").value = "";
      state.coordInputDirty = false;
      setPoint(p.lat, p.lng, { autoLoad: true });
    });
  }
  state.marker.bindTooltip(label, { className: "point-tip" });
  el("load").disabled = false;
  setStatus("Bereit zum Laden.", "");
  updateSetting("lastPoint", { lat, lon });
  if (autoLoad) loadForecast();
}

// Zuletzt verwendete Position beim Start wiederherstellen (kein Auto-Laden).
if (settings.lastPoint) setPoint(settings.lastPoint.lat, settings.lastPoint.lon);

// ---------------------------------------------------------------------------
// Positions-Eingabe: Dezimalgrad oder MGRS, alternativ zum Kartenklick.
// ---------------------------------------------------------------------------
// Liefert true bei Erfolg. Gibt bei ungültiger Eingabe false zurück, statt
// (gefährlich) einfach den alten Punkt stehen zu lassen — Aufrufer müssen das
// prüfen, bevor sie z.B. eine Vorhersage laden.
function goToCoordInput() {
  const parsed = parseCoordInput(el("coordinput").value);
  if (!parsed) { setStatus("Ungültige Koordinate.", "error"); return false; }
  state.coordInputDirty = false;
  setPoint(parsed.lat, parsed.lon, { autoLoad: true });
  map.setView([parsed.lat, parsed.lon], Math.max(map.getZoom(), 11));
  return true;
}
el("coordgo").addEventListener("click", goToCoordInput);
el("coordinput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); goToCoordInput(); }
});
// Markiert das Feld als "noch nicht übernommen", sobald der Nutzer tippt.
// Verhindert, dass "Vorhersage laden" den alten Punkt neu lädt, während eine
// eingegebene, aber nicht per "Gehe zu"/Enter bestätigte Koordinate im Feld
// steht (siehe load-Handler unten).
el("coordinput").addEventListener("input", () => { state.coordInputDirty = true; });

// ---------------------------------------------------------------------------
// Vorhersage laden
// ---------------------------------------------------------------------------
// Steht im Koordinatenfeld noch unbestätigter Text (getippt, aber nicht per
// "Gehe zu"/Enter übernommen), übernimmt der Klick auf den prominenten
// "Vorhersage laden"-Button ihn zuerst — sonst würde sonst unbemerkt die
// Vorhersage des alten Standorts erneut geladen (siehe Nutzerfeedback).
el("load").addEventListener("click", () => {
  if (state.coordInputDirty && el("coordinput").value.trim()) {
    if (!goToCoordInput()) return; // ungültige Koordinate: nicht mit altem Punkt weiterladen
    return; // goToCoordInput löst über setPoint(..., { autoLoad: true }) das Laden bereits aus
  }
  loadForecast();
});

// Verwirft die Punktvorhersage des zuvor geladenen Punkts, inkl. aller davon
// abhängigen Overlays. Nötig, sobald ein neuer Punkt gewählt wird, für den
// (noch) keine gültigen Daten vorliegen — sonst zeigt das Panel weiter die
// alten Werte, obwohl Marker/Position schon auf den neuen Punkt zeigen.
function clearForecast() {
  state.data = null;
  el("now").hidden = true;
  el("now").open = false;
  el("now-body").innerHTML = "";
  el("products").hidden = true;
  el("meteogram").hidden = true;
  el("crosssection").hidden = true;
  el("gramet").hidden = true;
  el("gonogo").hidden = true;
  el("model-run-hint").hidden = true;
}

// Modell-Bodendruck + T2m am Operationspunkt, als Stundenreihe — Basis für
// QFE(DEM) in renderNow(). `elevation=nan` pinnt den Request auf die
// modelleigene Gitterhöhe (kein DEM-Downscaling von T2m), analog zu
// demoverlay.js' fetchModelChunk(), hier aber nur EIN Punkt über den vollen
// Horizont statt eines Chunks. Fehler hier dürfen das restliche Laden nicht
// verhindern (Aufrufer fängt mit .catch(() => null) ab, wie modelRunInit).
async function fetchModelPressure(lat, lon, model) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "surface_pressure_model,temperature_2m",
    models: model.apiModel,
    elevation: "nan",
    timeformat: "unixtime",
    forecast_days: String(settings.forecastDays),
    cell_selection: "nearest",
  });
  const resp = await fetch(`${model.apiBase}/v1/forecast?${params}`);
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(data.reason || `API-Fehler ${resp.status}`);
  const h = data.hourly || {};
  return { time: h.time || [], ps: h.surface_pressure_model || [], t2m: h.temperature_2m || [] };
}

async function loadForecast() {
  if (!state.point) return;
  const { lat, lon } = state.point;
  const model = MODELS[settings.model];

  if (lat < model.bbox.latMin || lat > model.bbox.latMax ||
      lon < model.bbox.lonMin || lon > model.bbox.lonMax) {
    // Sonst bliebe die Punktvorhersage des zuvor gewählten (gültigen) Punkts
    // sichtbar stehen und könnte fälschlich für den neuen Punkt gehalten werden.
    clearForecast();
    setStatus(`Punkt liegt außerhalb des ${model.label}-Gebiets.`, "error");
    return;
  }

  el("load").disabled = true;
  setStatus("Lade Modell- und Oberflächendaten …", "busy");

  const now = Date.now();
  const tMax = now + settings.forecastDays * 24 * 3600e3;

  try {
    // Oberflächenvariablen und Modell-Level-Windfeld parallel holen. Der
    // Modelllauf-Zeitstempel (fürs Infobutton) hängt am selben Modell, ist
    // aber unkritisch — ein Fehler dabei darf das restliche Laden nicht
    // verhindern (daher eigenes .catch statt scharf in Promise.all).
    const wf = new WindField(settings.model);
    const [surface, , modelRunInit, modelPressure] = await Promise.all([
      fetchSurface(lat, lon, settings.model, settings.forecastDays),
      wf.init(lat, lon, settings.maxHeight, now, tMax),
      fetchModelRunInit(settings.model).catch(() => null),
      fetchModelPressure(lat, lon, model).catch(() => null),
    ]);

    // Modell-eigene Orographie am Punkt (bilinear) — zum Abgleich mit der
    // echten (DEM-)Geländehöhe: großer Unterschied heißt, das Modellgitter
    // löst das lokale Gelände hier nicht auf (siehe METHODIK.md, „Wind auf
    // Höhe vs. Modell-Orographie"), nicht dass ein Wert falsch berechnet ist.
    // ensureCorners lädt die 4 Gitterecken am Punkt — elevationAt liefert sonst
    // null (init selbst lädt nur den Sondierungspunkt, nicht die Ecken).
    await wf.ensureCorners(lat, lon);
    const modelElevation = wf.elevationAt(lat, lon);

    // Die Modell-Level-Winde auf den Vorschau-Höhen berechnet renderNow zur
    // jeweils gewählten Masterzeit neu (billige In-Memory-Interpolation).
    state.data = { surface, loadedAt: now, wf, modelElevation, modelRunInit, modelPressure };
    setMasterRange(); // Zeitfenster auf die echte Zeitreihe verfeinern
    setStatus(`Geladen · ${model.label} · Elevation ${fmtHeight(surface.elevation)}`, "");
    updateModelRunHint();
    // Punktvorhersage beim ersten Laden aufklappen; danach die Nutzerwahl
    // (auf-/zugeklappt) über Neuladen hinweg respektieren.
    const firstReveal = el("now").hidden;
    el("now").hidden = false;
    if (firstReveal) el("now").open = true;
    el("products").hidden = false;
    renderNow();
    if (!el("meteogram").hidden) openMeteogram();       // offene Overlays aktualisieren
    if (!el("crosssection").hidden) openCrossSection();
    if (!el("gramet").hidden) openGramet();
    if (!el("windspinne").hidden) openWindspinne();
    if (!el("gonogo").hidden) openGoNoGo();
    // Briefing fehlte hier bisher (s. Nutzerfeedback): stand nach einem
    // Koordinatenwechsel bei geöffnetem Panel weiter mit den Daten des ALTEN
    // Punkts da -- ein Preflight-Briefing mit falschem Standort ist gefährlich,
    // nicht nur veraltet.
    if (!el("briefing").hidden) openBriefing();
  } catch (err) {
    setStatus(err.message || String(err), "error");
  } finally {
    el("load").disabled = false;
  }
}

// Infobutton neben der Modellauswahl: zeigt den Initialisierungszeitpunkt
// des aktuell geladenen Modelllaufs (z. B. "00-UTC-Lauf") in Lokalzeit.
el("model-run-info").addEventListener("click", () => {
  const hint = el("model-run-hint");
  const show = hint.hidden;
  hint.hidden = !show;
  el("model-run-info").setAttribute("aria-pressed", String(show));
});

function updateModelRunHint() {
  const t = state.data?.modelRunInit;
  const hint = el("model-run-hint");
  if (!Number.isFinite(t)) {
    hint.textContent = "Modelllauf: nicht verfügbar";
    return;
  }
  const label = new Date(t * 1000).toLocaleString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  hint.textContent = `Modelllauf: ${label} Uhr`;
}

// ---------------------------------------------------------------------------
// Produkt „Aktuell" (Lebenszeichen der Pipeline)
// ---------------------------------------------------------------------------
// TERRAIN_MISMATCH_WARN_M kommt aus config.js — dieselbe Konstante nutzt auch
// demoverlay.js für die Farbklassen des Kartenlayers (EINE Quelle statt zwei
// driftender Kopien, siehe METHODIK.md Abschnitt 5b).

// Neuberechnung serialisieren: renderNow ist async (Höhenwinde werden zur
// Masterzeit interpoliert). Beim schnellen Ziehen des Zeitreglers laufen
// mehrere Aufrufe an — nur das jüngste Ergebnis darf ins DOM.
let renderNowGen = 0;

async function renderNow() {
  const d = state.data;
  if (!d || !state.point) return;
  const gen = ++renderNowGen;
  const { surface, wf } = d;
  const { lat, lon } = state.point;
  const tMs = getMasterMs();
  const i = nearestIndex(surface.time, tMs);
  const at = (name) => (surface.vars[name] ? surface.vars[name][i] : null);
  const time = surface.time.length
    ? new Date(surface.time[i] * 1000).toLocaleString("de-DE", {
        weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      })
    : "–";

  // Modell-Level-Wind auf den Vorschau-Höhen zur Masterzeit (billig, da das
  // Windfeld am Punkt bereits im Speicher liegt). Vor dem DOM-Aufbau, damit die
  // Reihenfolge (Wind auf Höhe vor Oberfläche) erhalten bleibt.
  const winds = [];
  for (const h of PREVIEW_HEIGHTS) {
    if (h > settings.maxHeight) continue;
    const r = await wf.windAt(lat, lon, { type: "height", mode: "agl", value: h }, tMs);
    winds.push({ h, ...r });
  }
  if (gen !== renderNowGen) return; // durch neueren Aufruf überholt

  const rows = [];
  rows.push(`<div class="now-time">Gültig (Modellstunde): ${time} loc</div>`);

  // Modell-Orographie vs. echtes Gelände: großer Unterschied = lokales
  // Gelände vom Gitter nicht aufgelöst, Wind-auf-Höhe-Werte mit Vorsicht.
  if (d.modelElevation != null) {
    const deltaM = d.modelElevation - surface.elevation;
    const warn = Math.abs(deltaM) >= TERRAIN_MISMATCH_WARN_M;
    const sign = deltaM >= 0 ? "+" : "−";
    const deltaTxt = `${sign}${Math.round(Math.abs(heightToDisplay(deltaM)))} ${heightUnit()}`;
    rows.push(line("Orographie",
      `Modell ${fmtHeight(d.modelElevation)} · DEM ${fmtHeight(surface.elevation)} · Δ ${deltaTxt}`, warn));
    if (warn) {
      rows.push(`<div class="hint warn">⚠ Gelände hier vom Modellgitter nicht aufgelöst — Wind auf Höhe mit Vorsicht interpretieren.</div>`);
    }

    // QFE(DEM): Modell-Bodendruck barometrisch auf die DEM90-Höhe umgerechnet
    // (dieselbe Formel/Konstanten wie im ΔQFE-Kartenlayer, s. demoverlay.js
    // Kopfkommentar) — bewusst mit demselben `warn` eingefärbt wie die
    // Orographie-Zeile: derselbe Δh treibt beide, ein roter Wert hier soll
    // direkt zur Vorsicht bei der Orographie-Zeile darüber mahnen.
    const mp = d.modelPressure;
    if (mp?.time?.length) {
      const j = nearestIndex(mp.time, tMs);
      const t2mK = mp.t2m[j] != null ? mp.t2m[j] + 273.15 : null;
      const qfeDem = qfeAtTarget(mp.ps[j], t2mK, deltaM);
      if (qfeDem != null) rows.push(line("QFE (DEM)", `${qfeDem.toFixed(1)} hPa`, warn));
    }
  }

  // Modell-Level-Wind auf Flughöhe – der Kernvorteil.
  rows.push(`<div class="wx-group">Wind auf Höhe (${heightUnit()} AGL)</div>`);
  for (const w of winds) {
    const val = w.error
      ? `<span class="hint">${w.error}</span>`
      : `${fmtDirPadded(windFromDir(w.u, w.v))} ${fmtWind(Math.hypot(w.u, w.v))}`;
    rows.push(line(fmtHeight(w.h), val));
  }

  // Oberfläche / limitierende Faktoren.
  rows.push(`<div class="wx-group">Oberfläche</div>`);
  rows.push(line("Wind 10 m", at("wind_direction_10m") != null
    ? `${fmtDirPadded(at("wind_direction_10m"))} ${fmtWind(kmhToMs(at("wind_speed_10m")))}`
    : fmtWind(kmhToMs(at("wind_speed_10m")))));
  rows.push(line("Böen 10 m", fmtWind(kmhToMs(at("wind_gusts_10m")))));
  rows.push(line("Temperatur", fmtTemp(at("temperature_2m"))));
  rows.push(line("Taupunkt", fmtTemp(at("dew_point_2m"))));
  rows.push(line("Bewölkung", pct(at("cloud_cover")) + (at("cloud_cover_low") != null ? ` (tief ${pct(at("cloud_cover_low"))})` : "")));
  rows.push(line("Niederschlag", num(at("precipitation"), surface.units.precipitation || "mm")));
  if (at("visibility") != null) rows.push(line("Sicht", visKm(at("visibility"))));
  if (at("cape") != null) rows.push(line("CAPE", num(at("cape"), "J/kg")));
  if (at("freezing_level_height") != null) rows.push(line("Nullgradgrenze (AMSL)", fmtHeight(at("freezing_level_height"))));
  rows.push(line("Wetter", wmoText(at("weather_code"))));

  el("now-body").innerHTML = rows.join("");
}

function line(k, v, warn) {
  return `<div class="wx-line${warn ? " warn" : ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

// ---------------------------------------------------------------------------
// Vorhersageprodukte (öffnen als Overlay)
// ---------------------------------------------------------------------------
// Alle Produkt-Overlays belegen exakt dieselbe Bildschirmfläche (siehe CSS:
// gleiches inset, gleicher z-index) und sind daher als Einzelplatz gedacht --
// ohne Exklusivität bliebe ein neu geöffnetes Overlay unsichtbar hinter einem
// bereits offenen liegen (Nutzerfeedback: GoNoGo-Tabelle verdeckte Meteogramm).
const PRODUCT_OVERLAY_IDS = ["meteogram", "crosssection", "gramet", "windspinne", "gonogo", "briefing"];
function closeProductOverlays() {
  for (const id of PRODUCT_OVERLAY_IDS) el(id).hidden = true;
}

document.querySelectorAll(".product").forEach((btn) => {
  btn.addEventListener("click", () => {
    closeProductOverlays();
    if (btn.dataset.prod === "meteogram") openMeteogram();
    else if (btn.dataset.prod === "xsection") openCrossSection();
    else if (btn.dataset.prod === "gramet") openGramet();
    else if (btn.dataset.prod === "windspinne") openWindspinne();
    else if (btn.dataset.prod === "briefing") openBriefing();
    else if (btn.dataset.prod === "table") openGoNoGo();
  });
});

async function openMeteogram() {
  if (!state.data || !state.point) return;
  const { surface } = state.data;
  const { lat, lon } = state.point;
  el("meteogram").hidden = false;
  el("mg-sub").textContent = el("pointpos").textContent;

  // Mondauf-/-untergänge (positionsabhängig, im Code gerechnet) samt Phase.
  const t0 = surface.time[0] * 1000, t1 = surface.time[surface.time.length - 1] * 1000;
  const events = astro.moonRiseSetEvents(t0, t1, lat, lon)
    .map((e) => ({ ...e, ...astro.moonPhase(e.t) }));

  // Profil-Verfeinerung der Wolkenbasis: Säule wird ohnehin für
  // Cross-Section/Briefing gebraucht und hier mitgenutzt (gecacht in
  // state.data.col). Schlägt der Abruf fehl, zeichnet drawBaseVis einfach
  // mit der reinen LCL-Schätzung weiter (kein Hard-Fail fürs Meteogramm).
  // Basis + Okta-Kategorie kommen aus der UNTERSTEN Schicht (`cloudLayers`,
  // erste Schicht) — nicht aus `cloudCeiling` (das sucht die erste BKN/OVC-
  // Höhe im ganzen Profil, auch wenn eine tiefere FEW/SCT-Schicht darunter
  // liegt; für die Meteogramm-Linie soll aber die tatsächliche unterste
  // Wolke inkl. ihrer eigenen Kategorie erscheinen).
  // Pro Stunde eigenständig auf die Säule gemappt (nicht per Array-Längen-
  // vergleich): bei ICON Global enden die Modell-Level-Daten real bei +36 h,
  // die Oberflächenreihe läuft weiter. Jenseits davon liefert
  // `nearestIndexOrNull` `null` -> `mgFog[i]` wird `undefined` (keine
  // Säulendaten mehr, fogWwCat() unten fällt dort auf den rohen weather_code
  // zurück) statt `null` (Säule vorhanden, aber kein Nebel diagnostiziert).
  let lowestLayer = null, mgFog = null;
  try {
    const col = await ensureColumn();
    lowestLayer = surface.time.map((tSec) => {
      const j = nearestIndexOrNull(col.time, tSec * 1000);
      return j == null ? null : (cloudLayers(col, j, { maxLayers: 1 })[0] ?? null);
    });
    mgFog = surface.time.map((tSec, i) => {
      const j = nearestIndexOrNull(col.time, tSec * 1000);
      return j == null ? undefined : classifyFog(col, j, surface.vars.visibility?.[i], surface.vars.weather_code?.[i]);
    });
  } catch { /* Säule nicht verfügbar -> Meteogramm bleibt bei reiner LCL-Schätzung */ }

  renderMeteogram(el("mg-body"), {
    time: surface.time,
    nights: surface.nights,
    vars: surface.vars,
    units: surface.units,
    moon: { events },
    maxHeightM: settings.maxHeight,
    lowestLayer,
    fog: mgFog,
  });
}

el("mg-close").addEventListener("click", () => { el("meteogram").hidden = true; });

// Rohe Modell-Säule bei Bedarf laden und in state.data cachen (geteilt von
// Cross-Section und Briefing).
async function ensureColumn() {
  if (!state.data.col) {
    const { lat, lon } = state.point;
    state.data.col = await fetchColumn(lat, lon, settings.model, settings.forecastDays);
  }
  return state.data.col;
}

// Cross-Section: Höhenprofil bei erstem Öffnen laden (gecacht in state.data).
async function openCrossSection() {
  if (!state.data || !state.point) return;
  el("crosssection").hidden = false;
  el("xs-sub").textContent = el("pointpos").textContent;
  if (!state.data.col) {
    el("xs-body").textContent = "Lade Höhenprofil …";
    try {
      await ensureColumn();
    } catch (e) {
      el("xs-body").textContent = "Fehler beim Laden des Höhenprofils: " + (e.message || e);
      return;
    }
  }
  renderXs();
}

// Etwas Luft über der Flughöhe im Zoom-Modus, damit die Flughöhenlinie im
// Bild bleibt und der Bereich knapp darüber sichtbar ist.
const XS_ZOOM_HEADROOM = 1.15;

// Aktuelle Cross-Section zeichnen: je nach Modus das Gesamtfeld (log-Gitter)
// oder das feine Zoomfeld bis knapp über Flughöhe (lineares Gitter). Beide
// werden aus der gecachten Säule gebaut und in state.data wiederverwendet.
function renderXs() {
  if (!state.data?.col) return;
  syncXsToggle();
  let field, axis;
  if (settings.xsZoom) {
    const cap = Math.round(settings.maxHeight * XS_ZOOM_HEADROOM);
    if (!state.data.fieldZoom || state.data.fieldZoomCap !== cap) {
      state.data.fieldZoom = buildField(state.data.col, cap, 60, "lin");
      state.data.fieldZoomCap = cap;
    }
    field = state.data.fieldZoom;
    axis = "lin";
  } else {
    if (!state.data.field) state.data.field = buildField(state.data.col);
    field = state.data.field;
    axis = "log";
  }
  renderCrossSection(el("xs-body"), field, { maxHeightM: settings.maxHeight, axis });
}

function syncXsToggle() {
  document.querySelectorAll("#xs-range button").forEach((b) => {
    b.classList.toggle("active", (b.dataset.range === "zoom") === settings.xsZoom);
  });
}

el("xs-range").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-range]");
  if (!btn) return;
  updateSetting("xsZoom", btn.dataset.range === "zoom");
  renderXs();
  if (!el("gramet").hidden) renderGm(); // teilt sich denselben Höhenbereich-State
});
el("xs-close").addEventListener("click", () => { el("crosssection").hidden = true; });

// GRAMET-Meteogramm: dieselbe gecachte Säule wie Cross-Section/Briefing, dazu
// die ohnehin schon geladenen Oberflächenwerte (state.data.surface) — kein
// eigener Request (s. `meteokit/gramet`). Rendering/Ableitung von `view`
// übernimmt jetzt die <gramet-panel>-Komponente selbst (s.
// `meteokit/components/gramet-panel`); app.js reicht nur noch `grid` +
// Darstellungs-Einstellungen rein. `state.data.gmGrid` bleibt hier gecacht,
// weil es sich die Go/No-Go-Hazardzeilen weiter unten teilen (s.
// `icingBandMaxAt`/`turbulenceBandMaxAt`).
async function openGramet() {
  if (!state.data || !state.point) return;
  const gm = el("gramet");
  gm.hidden = false;
  // Der Klick-Hinweis steht im Untertitel, nicht im Hover-Tooltip: die
  // Bibliothek kennt keine Masterzeit, das ist eine Zusage dieser App.
  gm.subtitle = `${el("pointpos").textContent} · Klick setzt die Zeit`;
  if (!state.data.col) {
    gm.loading = "Lade Höhenprofil …";
    try {
      await ensureColumn();
    } catch (e) {
      gm.loading = "Fehler beim Laden des Höhenprofils: " + (e.message || e);
      return;
    }
  }
  renderGm();
}

function renderGm() {
  if (!state.data?.col) return;
  if (!state.data.gmGrid) {
    const { lat, lon } = state.point;
    state.data.gmGrid = gridFromColumn(state.data.col, state.data.surface, lat, lon);
  }
  el("gramet").update({
    grid: state.data.gmGrid,
    maxHeight: settings.maxHeight,
    range: settings.xsZoom ? "zoom" : "full",
    layers: {
      isotherms: settings.gmIsothermsOn,
      isotachs: settings.gmIsotachsOn,
      hazards: settings.gmHazardsOn,
      windbarbs: settings.gmWindbarbsOn,
    },
    exportNameParts: ["gramet", settings.model, state.point?.lat, state.point?.lon],
  });
  // Nach jedem Neuaufbau: die Linie soll ohne Zutun auf der Masterzeit stehen.
  syncGrametCursor();
}

// Persistenz der Panel-eigenen Darstellungs-Einstellungen ist Sache der
// Host-App (s. Doc-Kommentar in gramet-panel.js) -- hier in `settings.js`
// spiegeln. `xsZoom` teilt sich Cross-Section und GRAMET (dieselbe
// Umschaltfläche bedient beide Ansichten), daher bei jeder Änderung auch
// die Cross-Section neu zeichnen, falls offen.
el("gramet").addEventListener("settingschange", (e) => {
  const { range, layers } = e.detail;
  updateSetting("xsZoom", range === "zoom");
  updateSetting("gmIsothermsOn", layers.isotherms);
  updateSetting("gmIsotachsOn", layers.isotachs);
  updateSetting("gmHazardsOn", layers.hazards);
  updateSetting("gmWindbarbsOn", layers.windbarbs);
  if (!el("crosssection").hidden) renderXs();
});
el("gramet").addEventListener("close", () => { el("gramet").hidden = true; });

// Klick ins GRAMET übernimmt den abgelesenen Zeitpunkt als Masterzeit --
// derselbe Vorgang wie „+1 h", nur gezielt statt gesucht. Genau die Bewegung,
// die vorher Handarbeit war: im Querschnitt eine Vereisungsschicht oder eine
// Nebelphase sehen und dazu das horizontale Bild (Radar, Satellit,
// Flächenlayer) holen wollen.
//
// Bewusst NUR am Klick, nie am Hover: an der Masterzeit hängen Kachelabrufe
// (Radar/Satellit) und Vollbild-Redraws der numerischen Layer. Als
// „committed" gemeldet, weil es eine abgeschlossene Handlung ist -- die
// teuren Konsumenten sollen sofort nachziehen und nicht drosseln.
// Rastet auf die volle Stunde: GRAMET zeigt stündliche Modelldaten, ein Klick
// meint also „diese Modellstunde" und nicht „diese Pixelspalte". Ohne Raster
// landete man auf einer krummen Sekunde, aus der alle Konsumenten ohnehin
// wieder auf ihre Stunde zurückrunden -- nur ohne dass das Label es zeigt.
el("gramet").addEventListener("posclick", (e) => {
  if (Number.isFinite(e.detail?.pos)) setMasterMs(e.detail.pos * 1000, { grid: HOUR_MS });
});

// Windspinne: Windprofil (Richtung/Geschwindigkeit über Höhe) zur Masterzeit,
// aus derselben gecachten Säule wie Cross-Section/GRAMET/Briefing (kein
// eigener Request). Anders als GRAMET (Zeitverlauf) zeigt sie nur EINEN
// Zeitpunkt -- deshalb hier neu rendern, sobald sich die Masterzeit ändert
// (s. subscribeTime()-Callback oben), nicht nur beim Öffnen.
async function openWindspinne() {
  if (!state.data || !state.point) return;
  const ws = el("windspinne");
  ws.hidden = false;
  ws.subtitle = el("pointpos").textContent;
  if (!state.data.col) {
    ws.loading = "Lade Höhenprofil …";
    try {
      await ensureColumn();
    } catch (e) {
      ws.loading = "Fehler beim Laden des Höhenprofils: " + (e.message || e);
      return;
    }
  }
  renderWs();
}

function renderWs() {
  if (!state.data?.col) return;
  const slice = sliceColumnAtTime(state.data.col, getMasterMs() / 1000);
  const timeTxt = new Date(getMasterMs()).toLocaleString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  el("windspinne").update({
    profile: slice ? { z: slice.h, u: slice.u, v: slice.v } : null,
    maxHeight: settings.maxHeight,
    // Drohnenspezifische Farbgrenzen -- dieselbe Bedeutung wie beim
    // Windflächen-Kartenlayer (s. Doc-Kommentar in windspinne.js). Ein
    // künftiger Host für andere Aktivitäten (z. B. Fallschirmspringer) würde
    // hier eigene Grenzwerte übergeben statt WIND_FILL_STOPS.
    colorStops: WIND_FILL_STOPS,
    subtitle: `${el("pointpos").textContent} · gültig ${timeTxt} loc`,
    exportNameParts: ["windspinne", settings.model, state.point?.lat, state.point?.lon, Math.round(getMasterMs() / 1000)],
  });
}

el("windspinne").addEventListener("close", () => { el("windspinne").hidden = true; });

// Go/No-Go-Tabelle: Windmaximum zwischen 10 m und Flughöhe pro Stunde aus dem
// bereits gecachten WindField auflösen (keine neuen Requests, nur
// Interpolation an ein paar Stützhöhen) und gegen das Drohnenprofil bewerten.
async function openGoNoGo() {
  if (!state.data || !state.point) return;
  el("gonogo").hidden = false;
  el("gng-sub").textContent = el("pointpos").textContent;
  if (!state.data.windBandMax) {
    el("gng-body").textContent = "Werte Wind zwischen 10 m und Flughöhe aus …";
    try {
      const { lat, lon } = state.point;
      const { surface, wf } = state.data;
      const arr = [];
      for (const t of surface.time) {
        arr.push(await windBandMaxAt(wf, lat, lon, 10, settings.maxHeight, t * 1000));
      }
      state.data.windBandMax = arr;
    } catch (e) {
      el("gng-body").textContent = "Fehler beim Auswerten des Höhenwinds: " + (e.message || e);
      return;
    }
  }
  // Wolkenuntergrenze + Nebel aus der Säule (dieselbe wie Cross-
  // Section/Briefing, gecacht). Scheitert der Abruf, bleiben beide null →
  // die Tabelle fällt auf LCL-Schätzung bzw. reine weather_code-Erkennung
  // zurück (kein Hard-Fail).
  if (state.data.cloudCeiling === undefined) {
    try {
      const col = await ensureColumn();
      const ccLow = state.data.surface.vars.cloud_cover_low;
      const visArr = state.data.surface.vars.visibility, wcArr = state.data.surface.vars.weather_code;
      // Pro Stunde auf die Säule gemappt statt per Array-Längenvergleich (s.
      // openMeteogram) -- `undefined` = Säule endet hier (Zeile fällt in
      // gonogo.js auf die LCL-/weather_code-Heuristik zurück), `null` = Säule
      // vorhanden, aber kein Ceiling/Nebel diagnostiziert (bleibt so stehen).
      state.data.cloudCeiling = state.data.surface.time.map((tSec, i) => {
        const j = nearestIndexOrNull(col.time, tSec * 1000);
        return j == null ? undefined : (cloudCeiling(col, j, { ccLowPct: ccLow?.[i] })?.baseM ?? null);
      });
      state.data.fog = state.data.surface.time.map((tSec, i) => {
        const j = nearestIndexOrNull(col.time, tSec * 1000);
        return j == null ? undefined : classifyFog(col, j, visArr?.[i], wcArr?.[i]);
      });
    } catch { state.data.cloudCeiling = null; state.data.fog = null; }
  }
  // Vereisung: IPI-Bandmaximum aus derselben Säule, kein eigener Request
  // (s. `icingBandMaxAt`). Gitter wird mit GRAMET geteilt (`state.data.gmGrid`)
  // -- bei bereits geöffnetem GRAMET fällt der Aufbau ganz weg.
  if (state.data.icingBandMax === undefined) {
    try {
      const col = await ensureColumn();
      const { lat, lon } = state.point;
      if (!state.data.gmGrid) state.data.gmGrid = gridFromColumn(col, state.data.surface, lat, lon);
      const grid = state.data.gmGrid;
      // Pro Stunde auf die Säule gemappt (s. cloudCeiling oben) -- ohne
      // Einzel-Level-Fallback bleibt eine Stunde jenseits des Säulenhorizonts
      // schlicht `null` (icingRow() zeigt dafür "na").
      state.data.icingBandMax = state.data.surface.time.map((tSec) => {
        const j = nearestIndexOrNull(grid.times, tSec * 1000);
        return j == null ? null : icingBandMaxAt(grid, j, 10, settings.maxHeight);
      });
    } catch { state.data.icingBandMax = null; }
  }
  // Turbulenz: TFI-Bandmaximum aus derselben Säule/demselben Gitter wie
  // Vereisung oben (`state.data.gmGrid` ist zu diesem Zeitpunkt bereits
  // gesetzt) -- Ri/Scherung stehen an `derive(grid)` bereits pro Modell-
  // schicht bereit, s. `turbulenceBandMaxAt`.
  if (state.data.turbulenceBandMax === undefined) {
    try {
      const col = await ensureColumn();
      const { lat, lon } = state.point;
      if (!state.data.gmGrid) state.data.gmGrid = gridFromColumn(col, state.data.surface, lat, lon);
      const grid = state.data.gmGrid;
      // Pro Stunde auf die Säule gemappt (s. icingBandMax oben).
      state.data.turbulenceBandMax = state.data.surface.time.map((tSec) => {
        const j = nearestIndexOrNull(grid.times, tSec * 1000);
        return j == null ? null : turbulenceBandMaxAt(grid, j, 10, settings.maxHeight);
      });
    } catch { state.data.turbulenceBandMax = null; }
  }
  renderGoNoGoTable(el("gng-body"), evaluateGoNoGo(
    state.data.surface, state.data.windBandMax, getProfile(settings.droneProfile), settings.maxHeight,
    state.data.cloudCeiling ?? null, state.data.fog ?? null, state.data.icingBandMax ?? null,
    state.data.turbulenceBandMax ?? null,
  ));
}
el("gng-close").addEventListener("click", () => { el("gonogo").hidden = true; });
el("gng-profile").addEventListener("change", (e) => {
  updateSetting("droneProfile", e.target.value);
  profileMode = "view"; // Profilwechsel verlässt den Editor
  refreshProfileDetails();
  if (!el("gonogo").hidden) openGoNoGo();
});

// --- Datenbank-Ansicht/-Editor (Stufe 1–3) ----------------------------------
// "view" = read-only Detailkarte mit Toolbar · "edit" = Formular.
let profileMode = "view";
let profileStatus = null; // einmalige Rückmeldung (Import/Export), s. refresh

// Profildetails ein-/ausblenden.
el("gng-info").addEventListener("click", () => {
  const panel = el("gng-details");
  const show = panel.hidden;
  panel.hidden = !show;
  el("gng-info").setAttribute("aria-pressed", String(show));
  if (show) { profileMode = "view"; refreshProfileDetails(); }
});

// Befüllt die Profilauswahl aus der effektiven Liste (Werks- + Nutzerprofile),
// mit Herkunftsmarkierung im Optionstext.
function populateProfileSelect() {
  el("gng-profile").innerHTML = listProfiles()
    .map((p) => `<option value="${p.id}">${optionLabel(p)}</option>`)
    .join("");
  el("gng-profile").value = getProfile(settings.droneProfile).id;
}

function optionLabel(p) {
  if (p.origin === "user") return `${p.label} · eigenes`;
  if (p.origin === "imported") return `${p.label} · importiert`;
  return p.label;
}

// Wählt ein Profil, aktualisiert Auswahl/Tabelle und rendert die Details neu.
function selectProfile(id) {
  updateSetting("droneProfile", id);
  populateProfileSelect();
  refreshProfileDetails();
  if (!el("gonogo").hidden) openGoNoGo();
}

function refreshProfileDetails() {
  const panel = el("gng-details");
  if (panel.hidden) return;
  panel.innerHTML = "";
  const prof = getProfile(settings.droneProfile);

  if (profileMode === "edit") {
    renderProfileEditor(panel, prof, {
      onSave: (patch) => {
        updateProfile(prof.id, patch);
        profileMode = "view";
        selectProfile(prof.id); // Label könnte sich geändert haben -> Select neu
      },
      onCancel: () => { profileMode = "view"; refreshProfileDetails(); },
      onDelete: isEditable(prof.id) ? () => {
        deleteProfile(prof.id);
        profileMode = "view";
        selectProfile(DRONE_PROFILES[0].id); // zurück auf erstes Werksmodell
      } : null,
    });
    return;
  }

  // Ansichtsmodus: Toolbar (Aktionen) + read-only Detailkarte.
  const bar = document.createElement("div");
  bar.className = "dp-toolbar";
  if (isEditable(prof.id)) {
    bar.append(toolButton("Bearbeiten", "dp-primary", () => { profileMode = "edit"; refreshProfileDetails(); }));
  }
  bar.append(toolButton(isEditable(prof.id) ? "Duplizieren" : "Duplizieren & bearbeiten", "", () => {
    const copy = duplicateProfile(prof.id);
    profileMode = "edit";
    selectProfile(copy.id);
  }));
  bar.append(toolButton("Neu", "", () => {
    const fresh = createBlankProfile();
    profileMode = "edit";
    selectProfile(fresh.id);
  }));

  // Globale Datenbank-Aktionen (rechts): Export/Import der Nutzerprofile.
  const spacer = document.createElement("span");
  spacer.className = "dp-spacer";
  bar.append(spacer);
  const exportBtn = toolButton("Exportieren", "", exportProfiles);
  if (getUserProfiles().length === 0) {
    exportBtn.disabled = true;
    exportBtn.title = "Keine eigenen Profile zum Exportieren";
  }
  bar.append(exportBtn);
  bar.append(toolButton("Importieren", "", importProfilesFromFile));
  panel.append(bar);

  if (profileStatus) {
    const s = document.createElement("p");
    s.className = `dp-status${profileStatus.err ? " err" : ""}`;
    s.textContent = profileStatus.text;
    panel.append(s);
  }
  profileStatus = null; // nur einmal anzeigen

  const content = document.createElement("div");
  renderProfileDetails(content, prof);
  panel.append(content);
}

// Nutzerprofile als JSON-Datei herunterladen (Herkunft je Profil inklusive).
function exportProfiles() {
  const data = exportUserProfiles();
  if (data.profiles.length === 0) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `droneforecast-drohnenprofile_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  profileStatus = { text: `${data.profiles.length} Profil(e) exportiert.`, err: false };
  refreshProfileDetails();
}

// JSON-Datei einlesen und Profile importieren (als "importiert" gekennzeichnet).
function importProfilesFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { added, skipped } = importProfiles(JSON.parse(await file.text()));
      profileStatus = added
        ? { text: `${added} Profil(e) importiert${skipped ? `, ${skipped} übersprungen` : ""}.`, err: false }
        : { text: "Keine gültigen Profile in der Datei gefunden.", err: true };
      populateProfileSelect();
      refreshProfileDetails();
    } catch (e) {
      profileStatus = { text: `Import fehlgeschlagen: ${e.message || "keine gültige JSON-Datei"}`, err: true };
      refreshProfileDetails();
    }
  });
  input.click();
}

function toolButton(text, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  if (cls) b.className = cls;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

// Maximale mittlere Windgeschwindigkeit (m/s) zwischen hMinM und hMaxM zu
// einem Zeitpunkt: an ein paar Stützhöhen abgetastet (das WindField ist am
// Punkt bereits gecacht, also reine Interpolation ohne neue Requests).
async function windBandMaxAt(wf, lat, lon, hMinM, hMaxM, tMs) {
  let max = null;
  for (const h of bandHeights(hMinM, hMaxM)) {
    const r = await wf.windAt(lat, lon, { type: "height", mode: "agl", value: h }, tMs);
    if (r.error) continue;
    const s = Math.hypot(r.u, r.v);
    if (max == null || s > max) max = s;
  }
  return max;
}

// Stützhöhen fürs Bandmaximum: mind. 3, höchstens 16, grob alle 50 m.
function bandHeights(hMinM, hMaxM) {
  if (hMaxM <= hMinM) return [hMinM];
  const n = Math.min(16, Math.max(3, Math.round((hMaxM - hMinM) / 50) + 1));
  const out = [];
  for (let i = 0; i < n; i++) out.push(hMinM + (hMaxM - hMinM) * i / (n - 1));
  return out;
}

const KELVIN = 273.15;

// Maximaler Icing-Potential-Index zwischen hMinM und hMaxM zur Stunde `i`,
// plus das Höhenband der stärksten Vereisung (für die Go/No-Go-Zeile, s.
// gonogo.js `icingRow`) -- dieselben Stützhöhen wie beim Windbandmaximum
// (`bandHeights`), aber SYNCHRON: anders als `windBandMaxAt` (WindField,
// eigene Requests) sitzt `grid` bereits vollständig geladen im Speicher
// (`gridFromColumn` auf der ohnehin gecachten Säule, s. `renderGm`) -- reine
// Interpolation, s. METHODIK.md 7.6/6.7.
//
// Band = zusammenhängender Bereich um das Maximum, in dem der IPI die
// UNTERE Schwelle von dessen eigener Kategorie nicht unterschreitet (z. B.
// bei Maximum "severe": wo der IPI >= IPI_SEVERE bleibt) -- die exakten
// Bandgrenzen werden wie bei Wolkenbasis/-obergrenze (`crossHeight` in
// clouds.js) linear zwischen den Stützhöhen interpoliert, an denen der IPI
// die Schwelle kreuzt. Kein Band ("none"-Kategorie) -> bandBottomM/TopM null.
function icingBandMaxAt(grid, i, hMinM, hMaxM) {
  const samples = bandHeights(hMinM, hMaxM).map((h) => {
    const s = sampleAt(grid, i, h);
    return { h, ipi: ipiAt(s.T - KELVIN, s.cloudFrac) };
  });
  let maxIdx = 0;
  for (let k = 1; k < samples.length; k++) {
    if (samples[k].ipi > samples[maxIdx].ipi) maxIdx = k;
  }
  const ipi = samples[maxIdx].ipi;
  const floor = ipiCategoryFloor(ipi);
  if (floor <= 0) return { ipi, bandBottomM: null, bandTopM: null };

  let lo = maxIdx, hi = maxIdx;
  while (lo > 0 && samples[lo - 1].ipi >= floor) lo--;
  while (hi < samples.length - 1 && samples[hi + 1].ipi >= floor) hi++;
  const bandBottomM = lo > 0
    ? crossHeight(samples[lo - 1].h, samples[lo - 1].ipi, samples[lo].h, samples[lo].ipi, floor)
    : samples[lo].h;
  const bandTopM = hi < samples.length - 1
    ? crossHeight(samples[hi].h, samples[hi].ipi, samples[hi + 1].h, samples[hi + 1].ipi, floor)
    : samples[hi].h;
  return { ipi, bandBottomM, bandTopM };
}

// Höhe, an der eine linear zwischen (h0,v0) und (h1,v1) interpolierte Größe
// den Schwellwert `thr` kreuzt -- wie `crossHeight` in clouds.js.
function crossHeight(h0, v0, h1, v1, thr) {
  if (v1 === v0) return h0;
  return h0 + (thr - v0) / (v1 - v0) * (h1 - h0);
}

// Maximaler Turbulence-Flag-Index zwischen hMinM und hMaxM zur Stunde `i`,
// plus das Höhenband der stärksten Turbulenz (für die Go/No-Go-Zeile, s.
// gonogo.js `turbulenceRow`). Anders als `icingBandMaxAt`/`windBandMaxAt`
// wird HIER NICHT auf `bandHeights()`-Stützhöhen resampelt: Ri/Scherung
// (`grid.js` `derive()`) sind bereits Differenzenquotienten über die
// jeweilige Schichtdicke zwischen zwei Modell-Leveln, ein Resampling würde
// nur künstliche, nicht durch Daten gestützte Zwischenwerte erzeugen. Statt-
// dessen direkt über die echten Modellschichten iterieren, deren Mittelpunkt
// im Band liegt (Bandgrenzen linear zwischen Schicht-Mittelpunkten
// interpoliert, `crossHeight`, analog Vereisung/Wolkenbasis).
//
// Fällt keine Schicht-Mittelhöhe ins Band (sehr niedrige Flughöhe, gröbere
// Levelauflösung am unteren Rand als das Band breit ist), Fallback auf die
// dem Bandzentrum nächstgelegene Schicht -- sonst bliebe die Zeile bei
// niedrigen `maxHeight`-Einstellungen (gerade der Hauptfall für Drohnen)
// leer, statt zumindest eine Näherung zu zeigen.
function turbulenceBandMaxAt(grid, i, hMinM, hMaxM) {
  const { ri, shear2, nm } = derive(grid);
  const { nk } = grid;
  const layers = [];
  for (let k = 0; k < nm; k++) {
    const ix0 = i * nk + k, ix1 = i * nk + k + 1;
    const z0 = grid.z[ix0], z1 = grid.z[ix1];
    if (!Number.isFinite(z0) || !Number.isFinite(z1)) continue;
    // Windstärke-Gate braucht die mittlere Windgeschwindigkeit der Schicht
    // (komponentenweise gemittelt, Betrag danach, wie `layerWindSpeed` in
    // hazards/turbulence.js).
    const windSpeed = Math.hypot((grid.u[ix0] + grid.u[ix1]) / 2, (grid.v[ix0] + grid.v[ix1]) / 2);
    layers.push({ h: (z0 + z1) / 2, tfi: tfiAt(ri[i * nm + k], shear2[i * nm + k], windSpeed) });
  }
  if (!layers.length) return { tfi: NaN, bandBottomM: null, bandTopM: null };

  const center = (hMinM + hMaxM) / 2;
  let inBand = layers.filter((l) => l.h >= hMinM && l.h <= hMaxM);
  if (!inBand.length) {
    inBand = [layers.reduce((a, b) => (Math.abs(b.h - center) < Math.abs(a.h - center) ? b : a))];
  }

  let maxIdx = 0;
  for (let k = 1; k < inBand.length; k++) {
    if (inBand[k].tfi > inBand[maxIdx].tfi) maxIdx = k;
  }
  const tfi = inBand[maxIdx].tfi;
  const floor = tfiCategoryFloor(tfi);
  if (floor <= 0) return { tfi, bandBottomM: null, bandTopM: null };

  let lo = maxIdx, hi = maxIdx;
  while (lo > 0 && inBand[lo - 1].tfi >= floor) lo--;
  while (hi < inBand.length - 1 && inBand[hi + 1].tfi >= floor) hi++;
  const bandBottomM = lo > 0
    ? crossHeight(inBand[lo - 1].h, inBand[lo - 1].tfi, inBand[lo].h, inBand[lo].tfi, floor)
    : inBand[lo].h;
  const bandTopM = hi < inBand.length - 1
    ? crossHeight(inBand[hi].h, inBand[hi].tfi, inBand[hi + 1].h, inBand[hi + 1].tfi, floor)
    : inBand[hi].h;
  return { tfi, bandBottomM, bandTopM };
}

// Briefing: Overlay (Oberfläche + Höhendaten heute), analog zu den anderen
// Produkten. Der Inhalt wird als Fragment ins Overlay gehängt; PDF/Drucken
// bauen aus denselben Daten ein in sich geschlossenes Dokument (buildBriefingHtml).
async function openBriefing() {
  if (!state.data || !state.point) return;
  el("briefing").hidden = false;
  el("brf-sub").textContent = el("pointpos").textContent;
  el("brf-body").innerHTML = "<p style='padding:8px'>Erstelle Briefing …</p>";
  try {
    await ensureColumn();
    // Jedes (Wieder-)Öffnen -- auch nach einem Neuladen (Punkt/Modell/Horizont)
    // -- setzt die Tagesauswahl auf den Default "heute" zurück; das hält den
    // gewählten Tag automatisch gültig, statt auf einen nach dem Reload evtl.
    // nicht mehr geladenen Tag zu zeigen (s. Nutzerwunsch: Default = heute).
    state.briefingDay = null;
    populateBriefingDaySelect();
    el("brf-body").innerHTML = buildBriefingContent(briefingOpts());
  } catch (e) {
    el("brf-body").innerHTML = "<p style='padding:8px'>Briefing fehlgeschlagen: "
      + (e.message || e) + "</p>";
  }
}

// Befüllt die Tagesauswahl im Briefing-Kopf aus den tatsächlich geladenen
// Stunden (state.data.surface.time) -- zeigt also genau so viele Tage, wie
// aktuell über die Einstellung "Horizont" geladen sind.
function populateBriefingDaySelect() {
  const todayYmd = new Date(state.data.loadedAt).toISOString().slice(0, 10);
  const days = [...new Set(state.data.surface.time.map(
    (s) => new Date(s * 1000).toISOString().slice(0, 10),
  ))];
  el("brf-day").innerHTML = days.map(
    (d) => `<option value="${d}">${briefingDaySelectLabel(d, todayYmd)}</option>`,
  ).join("");
  el("brf-day").value = state.briefingDay || todayYmd;
}

function briefingDaySelectLabel(ymd, todayYmd) {
  const diffDays = Math.round((Date.parse(ymd) - Date.parse(todayYmd)) / 86400000);
  const dm = `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.`;
  if (diffDays === 0) return `Heute (${dm})`;
  if (diffDays === 1) return `Morgen (${dm})`;
  return dm;
}

el("brf-day").addEventListener("change", (e) => {
  state.briefingDay = e.target.value;
  el("brf-body").innerHTML = buildBriefingContent(briefingOpts());
});

// Opts für Briefing aus dem aktuellen Zustand (Säule muss gecacht sein).
function briefingOpts() {
  return {
    surface: state.data.surface,
    col: state.data.col,
    point: state.point,
    modelLabel: MODELS[settings.model].label,
    maxHeightM: settings.maxHeight,
    loadedAt: state.data.loadedAt,
    selectedDate: state.briefingDay,
  };
}

// Briefing über die Druck-Engine des Browsers ausgeben (Drucken bzw. „Als PDF
// speichern"). Das komplette, in sich geschlossene Dokument (mit @media
// print-Regeln) wird in einen unsichtbaren iframe geschrieben und dessen
// print() ausgelöst — so umgeht man den Popup-Blocker.
function printBriefing() {
  if (!state.data || !state.data.col) return;
  const html = buildBriefingHtml(briefingOpts());
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const cleanup = () => { setTimeout(() => frame.remove(), 1000); };
  frame.onload = () => {
    const win = frame.contentWindow;
    win.onafterprint = cleanup;
    win.focus();
    win.print();
    // Fallback, falls onafterprint nicht feuert (z. B. Dialog abgebrochen).
    setTimeout(cleanup, 60000);
  };
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
}

el("brf-close").addEventListener("click", () => { el("briefing").hidden = true; });
el("brf-print").addEventListener("click", printBriefing);

// Bei Größenänderung offenes Overlay neu zeichnen (SVG an Container gebunden).
// GRAMET zeichnet sich seit dem Path-Modus-Umbau selbst über einen eigenen
// ResizeObserver auf seinem Host-Element neu (render.js) -- hier also bewusst
// nicht mehr mitbedient.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!el("meteogram").hidden) openMeteogram();
    if (!el("crosssection").hidden) renderXs();
  }, 150);
});

// ---------------------------------------------------------------------------
// Settings-Panel verdrahten
// ---------------------------------------------------------------------------
function initSettings() {
  fillOptions("set-days", OPTIONS.forecastDays, (v) => `${v} ${v === 1 ? "Tag" : "Tage"}`);
  // Werks- + Nutzerprofile; getProfile() fällt auf das erste Werksmodell zurück,
  // falls ein gespeichertes Profil (z. B. gelöscht) nicht mehr existiert.
  populateProfileSelect();

  el("set-model").value = settings.model;
  syncMaxHeightInput();
  el("set-days").value = String(settings.forecastDays);
  el("set-unitheight").value = settings.unitHeight;
  el("set-unitwind").value = settings.unitWind;
  el("set-unittemp").value = settings.unitTemp;

  // Modellwechsel ändert die Datenbasis grundlegend (anderes Gitter/andere API).
  // Ist ein Punkt geladen, sofort automatisch neu abrufen statt auf den
  // manuellen "Vorhersage laden"-Button zu warten.
  bind("set-model", "model", () => { if (state.data) loadForecast(); });
  el("set-maxheight").addEventListener("change", (e) => {
    // Eingabe steht in der aktuell gewählten Anzeigeeinheit (m oder ft) --
    // zurück in Meter rechnen, das ist die intern durchgehend genutzte Einheit
    // (AGL-Grenze fürs Datenabrufen/Rendern, s. settings.maxHeight-Nutzung).
    const rawM = Math.round(heightFromDisplay(Number(e.target.value)));
    const clampedM = Number.isFinite(rawM)
      ? Math.min(MAX_MAX_HEIGHT, Math.max(MIN_MAX_HEIGHT, rawM))
      : settings.maxHeight;
    updateSetting("maxHeight", clampedM);
    syncMaxHeightInput(); // zeigt den (ggf. geklemmten) Wert gerundet in der Anzeigeeinheit
    needReload();
    // Cross-Section/GRAMET können sofort nachziehen: die Säule enthält alle
    // Level, Flughöhenlinie und Zoom-Bereich hängen nur von dieser Einstellung ab.
    if (!el("crosssection").hidden) renderXs();
    if (!el("gramet").hidden) renderGm();
    if (!el("windspinne").hidden) renderWs();
  });
  // Der Horizont ändert die Datenbasis (mehr/weniger Stunden). Ist ein Punkt
  // geladen, sofort automatisch neu abrufen, damit Meteogramm/Cross-Section und
  // die übrigen Produkte direkt nachziehen, statt auf einen manuellen Reload zu
  // warten. Ohne geladenen Punkt bleibt es beim reinen Speichern der Einstellung.
  bind("set-days", "forecastDays", () => { if (state.data) loadForecast(); });
  // Höheneinheit koppelt auch das Max.-Höhe-Feld: Wert bleibt intern in Metern
  // gespeichert, wird hier nur zur neuen Einheit passend neu anzeigt/umgerechnet.
  bind("set-unitheight", "unitHeight", () => { syncMaxHeightInput(); refreshViews(); });
  bind("set-unitwind", "unitWind", refreshViews);
  bind("set-unittemp", "unitTemp", refreshViews);
}

// Anzeige (Einheiten) neu rendern, ohne Daten neu zu laden.
function refreshViews() {
  renderNow();
  if (!el("meteogram").hidden) openMeteogram();
  if (!el("crosssection").hidden) renderXs();
  if (!el("gramet").hidden) renderGm();
  if (!el("windspinne").hidden) renderWs();
  if (!el("gonogo").hidden && state.data?.windBandMax) {
    renderGoNoGoTable(el("gng-body"), evaluateGoNoGo(
      state.data.surface, state.data.windBandMax, getProfile(settings.droneProfile), settings.maxHeight,
      state.data.cloudCeiling ?? null, state.data.fog ?? null,
    ));
  }
  if (!el("briefing").hidden && state.data?.col) {
    el("brf-body").innerHTML = buildBriefingContent(briefingOpts());
  }
}

function bind(id, key, after) {
  el(id).addEventListener("change", (e) => {
    updateSetting(key, e.target.value);
    if (after) after();
  });
}

function fillOptions(id, values, label) {
  el(id).innerHTML = values.map((v) => `<option value="${v}">${label(v)}</option>`).join("");
}

// Max.-Höhe-Feld an die aktuell gewählte Höheneinheit anpassen: Anzeigewert,
// min/max/step und Einheiten-Suffix. Die ANZEIGE wird immer auf ganze
// Hunderter gerundet (krumme Umrechnungswerte wie "984 ft" wirken sonst
// unruhig) -- settings.maxHeight bleibt davon unberührt und speichert
// weiterhin den exakten Meterwert (Quelle: MIN_MAX_HEIGHT/MAX_MAX_HEIGHT aus
// config.js), mit dem an allen anderen Stellen gerechnet wird.
function syncMaxHeightInput() {
  const input = el("set-maxheight");
  const unit = heightUnit();
  const minDisplay = heightToDisplay(MIN_MAX_HEIGHT);
  const maxDisplay = heightToDisplay(MAX_MAX_HEIGHT);
  input.min = String(Math.ceil(minDisplay / 100) * 100);
  input.max = String(Math.floor(maxDisplay / 100) * 100);
  input.step = "100";
  const rounded = Math.round(heightToDisplay(settings.maxHeight) / 100) * 100;
  // An den Rändern nie unter/über die echte Grenze runden (sonst wirkt das
  // Feld, als würde es einen ungültigen Wert anzeigen).
  input.value = String(Math.min(maxDisplay, Math.max(minDisplay, rounded)));
  el("set-maxheight-unit").textContent = unit;
}

function needReload() {
  if (state.data) setStatus("Einstellung geändert — bitte Vorhersage neu laden.", "busy");
}

// ---------------------------------------------------------------------------
// Panel ein-/ausklappen (mobil)
// ---------------------------------------------------------------------------
el("paneltoggle").addEventListener("click", () => {
  const panel = el("panel");
  const collapsed = panel.classList.toggle("collapsed");
  el("paneltoggle").setAttribute("aria-expanded", String(!collapsed));
});

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------
function setStatus(msg, cls) {
  const s = el("status");
  s.textContent = msg;
  s.className = cls || "";
  if (cls === "error") {
    // Fehler dürfen nicht unbemerkt bleiben: Panel ggf. aufklappen (mobil,
    // eingeklappter Zustand) und zur Meldung scrollen (Panel kann durch
    // eine zuvor geladene Vorhersage weit nach unten gescrollt sein).
    el("panel").classList.remove("collapsed");
    el("paneltoggle").setAttribute("aria-expanded", "true");
    s.scrollIntoView({ block: "nearest" });
  }
}

function windFromDir(u, v) {
  return (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
}
function kmhToMs(kmh) { return kmh == null ? null : kmh / 3.6; }
function pct(x) { return x == null ? "–" : `${Math.round(x)} %`; }
function num(x, unit) { return x == null ? "–" : `${x} ${unit}`; }
function visKm(m) { return m == null ? "–" : `${(m / 1000).toFixed(1)} km`; }

const WMO = {
  0: "wolkenlos", 1: "heiter", 2: "wolkig", 3: "bedeckt",
  45: "Nebel", 48: "Reifnebel",
  51: "leichter Niesel", 53: "Niesel", 55: "starker Niesel",
  56: "gefr. Niesel", 57: "gefr. Niesel",
  61: "leichter Regen", 63: "Regen", 65: "starker Regen",
  66: "gefr. Regen", 67: "gefr. Regen",
  71: "leichter Schnee", 73: "Schnee", 75: "starker Schnee", 77: "Schneegriesel",
  80: "Regenschauer", 81: "Regenschauer", 82: "starke Schauer",
  85: "Schneeschauer", 86: "Schneeschauer",
  95: "Gewitter", 96: "Gewitter m. Hagel", 99: "schweres Gewitter",
};
function wmoText(code) { return code == null ? "–" : (WMO[code] || `Code ${code}`); }

// ---------------------------------------------------------------------------
initSettings();
