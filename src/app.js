import { MODELS, PREVIEW_HEIGHTS } from "./config.js";
import { WindField } from "./windfield.js";
import { fetchSurface, nearestIndex } from "./weather.js";
import { initTimeControls, setRange, getMasterMs, subscribe as subscribeTime } from "./timeController.js";
import { renderMeteogram } from "./meteogram.js";
import { fetchColumn, buildField, lowestSaturatedHeight } from "./column.js";
import { renderCrossSection } from "./crosssection.js";
import { buildBriefingHtml, buildBriefingContent } from "./briefing.js";
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
import * as astro from "./astro.js";
import { settings, loadSettings, updateSetting, OPTIONS } from "./settings.js";
import { parseCoordInput } from "./coords.js";
import { initGeoman } from "./geoman.js";
import { initMapLayers } from "./maplayers.js";
import { initWindOverlay } from "./windoverlay.js";
import { initGustOverlay } from "./gustoverlay.js";
import {
  fmtHeight, fmtWind, fmtTemp, fmtDirPadded, heightUnit, heightToDisplay,
} from "./units.js";

/* global L */

const el = (id) => document.getElementById(id);
const state = { point: null, marker: null, data: null };

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
initWindOverlay(map);

// Kartenlayer: Windböen 10 m flächig (Oberfläche, öffentliche Instanz) —
// Schwesterlayer zum Wind-Overlay, teilt sich den wxOverlays-Pane.
initGustOverlay(map);

// Masterzeit: die eine Zeitachse für Bedingungen, numerische Felder und
// Nowcasting. Nach initMapLayers/initWindOverlay verdrahten — die haben sich
// dort bereits als Subscriber registriert und reagieren auf das erste
// setRange(). Das Fenster wird schon vor dem ersten Laden gesetzt, damit
// Nowcasting (Radar/Sat) eigenständig ohne Punktvorhersage funktioniert;
// loadForecast() verfeinert die Grenzen später auf die echte Zeitreihe.
initTimeControls();
setMasterRange();
subscribeTime(() => { if (state.data) renderNow(); });

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
function goToCoordInput() {
  const parsed = parseCoordInput(el("coordinput").value);
  if (!parsed) { setStatus("Ungültige Koordinate.", "error"); return; }
  setPoint(parsed.lat, parsed.lon, { autoLoad: true });
  map.setView([parsed.lat, parsed.lon], Math.max(map.getZoom(), 11));
}
el("coordgo").addEventListener("click", goToCoordInput);
el("coordinput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); goToCoordInput(); }
});

// ---------------------------------------------------------------------------
// Vorhersage laden
// ---------------------------------------------------------------------------
el("load").addEventListener("click", loadForecast);

async function loadForecast() {
  if (!state.point) return;
  const { lat, lon } = state.point;
  const model = MODELS[settings.model];

  if (lat < model.bbox.latMin || lat > model.bbox.latMax ||
      lon < model.bbox.lonMin || lon > model.bbox.lonMax) {
    setStatus(`Punkt liegt außerhalb des ${model.label}-Gebiets.`, "error");
    return;
  }

  el("load").disabled = true;
  setStatus("Lade Modell- und Oberflächendaten …", "busy");

  const now = Date.now();
  const tMax = now + settings.forecastDays * 24 * 3600e3;

  try {
    // Oberflächenvariablen und Modell-Level-Windfeld parallel holen.
    const wf = new WindField(settings.model);
    const [surface] = await Promise.all([
      fetchSurface(lat, lon, settings.model, settings.forecastDays),
      wf.init(lat, lon, settings.maxHeight, now, tMax),
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
    state.data = { surface, loadedAt: now, wf, modelElevation };
    setMasterRange(); // Zeitfenster auf die echte Zeitreihe verfeinern
    setStatus(`Geladen · ${model.label} · Elevation ${fmtHeight(surface.elevation)}`, "");
    // Punktvorhersage beim ersten Laden aufklappen; danach die Nutzerwahl
    // (auf-/zugeklappt) über Neuladen hinweg respektieren.
    const firstReveal = el("now").hidden;
    el("now").hidden = false;
    if (firstReveal) el("now").open = true;
    el("products").hidden = false;
    renderNow();
    if (!el("meteogram").hidden) openMeteogram();       // offene Overlays aktualisieren
    if (!el("crosssection").hidden) openCrossSection();
    if (!el("gonogo").hidden) openGoNoGo();
  } catch (err) {
    setStatus(err.message || String(err), "error");
  } finally {
    el("load").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Produkt „Aktuell" (Lebenszeichen der Pipeline)
// ---------------------------------------------------------------------------
// Ab dieser Differenz zwischen echter (DEM-)Geländehöhe und modelleigener
// Orographie gilt das lokale Gelände als vom Gitter nicht aufgelöst — grobe
// Faustregel, keine Literaturkonstante (siehe METHODIK.md).
const TERRAIN_MISMATCH_WARN_M = 100;

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
    rows.push(line("Modellorographie", `${fmtHeight(d.modelElevation)} (Δ ${deltaTxt})`, warn));
    if (warn) {
      rows.push(`<div class="hint warn">⚠ Gelände hier vom Modellgitter nicht aufgelöst — Wind auf Höhe mit Vorsicht interpretieren.</div>`);
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
document.querySelectorAll(".product").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.prod === "meteogram") openMeteogram();
    else if (btn.dataset.prod === "xsection") openCrossSection();
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

  // RH-Profil-Verfeinerung der Wolkenbasis: Säule wird ohnehin für
  // Cross-Section/Briefing gebraucht und hier mitgenutzt (gecacht in
  // state.data.col). Schlägt der Abruf fehl, zeichnet drawBaseVis einfach
  // mit der reinen LCL-Schätzung weiter (kein Hard-Fail fürs Meteogramm).
  let rhCeiling = null;
  try {
    const col = await ensureColumn();
    if (col.time.length === surface.time.length) {
      rhCeiling = surface.time.map((_, i) => lowestSaturatedHeight(col, i));
    }
  } catch { /* Säule nicht verfügbar -> Meteogramm bleibt bei reiner LCL-Schätzung */ }

  renderMeteogram(el("mg-body"), {
    time: surface.time,
    nights: surface.nights,
    vars: surface.vars,
    units: surface.units,
    moon: { events },
    maxHeightM: settings.maxHeight,
    rhCeiling,
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
});
el("xs-close").addEventListener("click", () => { el("crosssection").hidden = true; });

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
  renderGoNoGoTable(el("gng-body"), evaluateGoNoGo(
    state.data.surface, state.data.windBandMax, getProfile(settings.droneProfile), settings.maxHeight,
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
    el("brf-body").innerHTML = buildBriefingContent(briefingOpts());
  } catch (e) {
    el("brf-body").innerHTML = "<p style='padding:8px'>Briefing fehlgeschlagen: "
      + (e.message || e) + "</p>";
  }
}

// Opts für Briefing aus dem aktuellen Zustand (Säule muss gecacht sein).
function briefingOpts() {
  return {
    surface: state.data.surface,
    col: state.data.col,
    point: state.point,
    modelLabel: MODELS[settings.model].label,
    maxHeightM: settings.maxHeight,
    loadedAt: state.data.loadedAt,
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
  fillOptions("set-maxheight", OPTIONS.maxHeight, (v) => `${v} m`);
  fillOptions("set-days", OPTIONS.forecastDays, (v) => `${v} ${v === 1 ? "Tag" : "Tage"}`);
  // Werks- + Nutzerprofile; getProfile() fällt auf das erste Werksmodell zurück,
  // falls ein gespeichertes Profil (z. B. gelöscht) nicht mehr existiert.
  populateProfileSelect();

  el("set-model").value = settings.model;
  el("set-maxheight").value = String(settings.maxHeight);
  el("set-days").value = String(settings.forecastDays);
  el("set-unitheight").value = settings.unitHeight;
  el("set-unitwind").value = settings.unitWind;
  el("set-unittemp").value = settings.unitTemp;

  bind("set-model", "model");
  bind("set-maxheight", "maxHeight", () => {
    needReload();
    // Cross-Section kann sofort nachziehen: die Säule enthält alle Level,
    // Flughöhenlinie und Zoom-Bereich hängen nur von dieser Einstellung ab.
    if (!el("crosssection").hidden) renderXs();
  });
  // Der Horizont ändert die Datenbasis (mehr/weniger Stunden). Ist ein Punkt
  // geladen, sofort automatisch neu abrufen, damit Meteogramm/Cross-Section und
  // die übrigen Produkte direkt nachziehen, statt auf einen manuellen Reload zu
  // warten. Ohne geladenen Punkt bleibt es beim reinen Speichern der Einstellung.
  bind("set-days", "forecastDays", () => { if (state.data) loadForecast(); });
  bind("set-unitheight", "unitHeight", refreshViews);
  bind("set-unitwind", "unitWind", refreshViews);
  bind("set-unittemp", "unitTemp", refreshViews);
}

// Anzeige (Einheiten) neu rendern, ohne Daten neu zu laden.
function refreshViews() {
  renderNow();
  if (!el("meteogram").hidden) openMeteogram();
  if (!el("crosssection").hidden) renderXs();
  if (!el("gonogo").hidden && state.data?.windBandMax) {
    renderGoNoGoTable(el("gng-body"), evaluateGoNoGo(
      state.data.surface, state.data.windBandMax, getProfile(settings.droneProfile), settings.maxHeight,
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

// Modellwechsel ändert die Datenbasis grundlegend (anderes Gitter/andere API):
// erneutes Laden nötig. Der Horizont lädt inzwischen automatisch neu (s. o.).
function needReload() {
  if (state.data) setStatus("Einstellung geändert — bitte Vorhersage neu laden.", "busy");
}
el("set-model").addEventListener("change", needReload);

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
