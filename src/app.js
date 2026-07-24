import { MODELS, PREVIEW_HEIGHTS } from "./config.js";
import { WindField } from "./windfield.js";
import { fetchSurface, nearestFutureIndex } from "./weather.js";
import { renderMeteogram } from "./meteogram.js";
import { fetchColumn, buildField, lowestSaturatedHeight } from "./column.js";
import { renderCrossSection } from "./crosssection.js";
import { buildBriefingHtml } from "./briefing.js";
import { evaluate as evaluateGoNoGo } from "./gonogo.js";
import { renderGoNoGoTable } from "./gonogotable.js";
import { DRONE_PROFILES, getProfile } from "./droneProfiles.js";
import * as astro from "./astro.js";
import { settings, loadSettings, updateSetting, OPTIONS } from "./settings.js";
import { parseCoordInput } from "./coords.js";
import { initGeoman } from "./geoman.js";
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

// Kartenklick setzt den Operationspunkt — außer Geoman zeichnet/editiert gerade.
map.on("click", (e) => {
  if (map.pm.globalDrawModeEnabled() || map.pm.globalEditModeEnabled()) return;
  setPoint(e.latlng.lat, e.latlng.lng);
});

function setPoint(lat, lon) {
  state.point = { lat, lon };
  const label = `${lat.toFixed(4)}°N ${lon.toFixed(4)}°E`;
  el("pointpos").textContent = label;
  if (state.marker) {
    state.marker.setLatLng([lat, lon]);
  } else {
    state.marker = L.marker([lat, lon]).addTo(map);
  }
  state.marker.bindTooltip(label, { className: "point-tip" });
  el("load").disabled = false;
  setStatus("Bereit zum Laden.", "");
  updateSetting("lastPoint", { lat, lon });
}

// Zuletzt verwendete Position beim Start wiederherstellen (kein Auto-Laden).
if (settings.lastPoint) setPoint(settings.lastPoint.lat, settings.lastPoint.lon);

// ---------------------------------------------------------------------------
// Positions-Eingabe: Dezimalgrad oder MGRS, alternativ zum Kartenklick.
// ---------------------------------------------------------------------------
function goToCoordInput() {
  const parsed = parseCoordInput(el("coordinput").value);
  if (!parsed) { setStatus("Ungültige Koordinate.", "error"); return; }
  setPoint(parsed.lat, parsed.lon);
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

    // Modell-Level-Wind auf den Vorschau-Höhen zur aktuellen Stunde.
    const winds = [];
    for (const h of PREVIEW_HEIGHTS) {
      if (h > settings.maxHeight) continue;
      const r = await wf.windAt(lat, lon, { type: "height", mode: "agl", value: h }, now);
      winds.push({ h, ...r });
    }

    // Modell-eigene Orographie am Punkt (bilinear) — zum Abgleich mit der
    // echten (DEM-)Geländehöhe: großer Unterschied heißt, das Modellgitter
    // löst das lokale Gelände hier nicht auf (siehe METHODIK.md, „Wind auf
    // Höhe vs. Modell-Orographie"), nicht dass ein Wert falsch berechnet ist.
    const modelElevation = wf.elevationAt(lat, lon);

    state.data = { surface, winds, loadedAt: now, wf, modelElevation };
    setStatus(`Geladen · ${model.label} · Elevation ${fmtHeight(surface.elevation)}`, "");
    el("now").hidden = false;
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

function renderNow() {
  const d = state.data;
  if (!d) return;
  const { surface, winds } = d;
  const i = nearestFutureIndex(surface.time, d.loadedAt);
  const at = (name) => (surface.vars[name] ? surface.vars[name][i] : null);
  const time = surface.time.length
    ? new Date(surface.time[i] * 1000).toLocaleString("de-DE", {
        weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      })
    : "–";

  const rows = [];
  rows.push(`<div class="now-time">Gültig (loc): ${time}</div>`);

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
  if (!state.data.field) {
    el("xs-body").textContent = "Lade Höhenprofil …";
    try {
      state.data.field = buildField(await ensureColumn());
    } catch (e) {
      el("xs-body").textContent = "Fehler beim Laden des Höhenprofils: " + (e.message || e);
      return;
    }
  }
  renderCrossSection(el("xs-body"), state.data.field, { maxHeightM: settings.maxHeight });
}
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
  if (!el("gonogo").hidden) openGoNoGo();
});

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

// Briefing: druckbare HTML-Seite in neuem Tab (Oberfläche + Höhendaten heute).
async function openBriefing() {
  if (!state.data || !state.point) return;
  setStatus("Erstelle Briefing …", "busy");
  try {
    const col = await ensureColumn();
    const html = buildBriefingHtml({
      surface: state.data.surface,
      col,
      point: state.point,
      modelLabel: MODELS[settings.model].label,
      maxHeightM: settings.maxHeight,
      loadedAt: state.data.loadedAt,
    });
    const tab = window.open();
    if (!tab) { setStatus("Briefing: Popup wurde blockiert — bitte erlauben.", "error"); return; }
    tab.document.open();
    tab.document.write(html);
    tab.document.close();
    setStatus("Briefing in neuem Tab geöffnet.", "");
  } catch (e) {
    setStatus("Briefing fehlgeschlagen: " + (e.message || e), "error");
  }
}

// Bei Größenänderung offenes Overlay neu zeichnen (SVG an Container gebunden).
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!el("meteogram").hidden) openMeteogram();
    if (!el("crosssection").hidden && state.data?.field) {
      renderCrossSection(el("xs-body"), state.data.field, { maxHeightM: settings.maxHeight });
    }
  }, 150);
});

// ---------------------------------------------------------------------------
// Settings-Panel verdrahten
// ---------------------------------------------------------------------------
function initSettings() {
  fillOptions("set-maxheight", OPTIONS.maxHeight, (v) => `${v} m`);
  fillOptions("set-days", OPTIONS.forecastDays, (v) => `${v} ${v === 1 ? "Tag" : "Tage"}`);
  el("gng-profile").innerHTML = DRONE_PROFILES.map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
  el("gng-profile").value = settings.droneProfile;

  el("set-model").value = settings.model;
  el("set-maxheight").value = String(settings.maxHeight);
  el("set-days").value = String(settings.forecastDays);
  el("set-unitheight").value = settings.unitHeight;
  el("set-unitwind").value = settings.unitWind;
  el("set-unittemp").value = settings.unitTemp;

  bind("set-model", "model");
  bind("set-maxheight", "maxHeight", () => needReload());
  bind("set-days", "forecastDays", () => needReload());
  bind("set-unitheight", "unitHeight", refreshViews);
  bind("set-unitwind", "unitWind", refreshViews);
  bind("set-unittemp", "unitTemp", refreshViews);
}

// Anzeige (Einheiten) neu rendern, ohne Daten neu zu laden.
function refreshViews() {
  renderNow();
  if (!el("meteogram").hidden) openMeteogram();
  if (!el("crosssection").hidden && state.data?.field) {
    renderCrossSection(el("xs-body"), state.data.field, { maxHeightM: settings.maxHeight });
  }
  if (!el("gonogo").hidden && state.data?.windBandMax) {
    renderGoNoGoTable(el("gng-body"), evaluateGoNoGo(
      state.data.surface, state.data.windBandMax, getProfile(settings.droneProfile), settings.maxHeight,
    ));
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

// Modell/Höhe/Horizont ändern die Datenbasis: erneutes Laden nötig.
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
