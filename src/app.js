import { MODELS, PREVIEW_HEIGHTS } from "./config.js";
import { WindField } from "./windfield.js";
import { fetchSurface, nearestFutureIndex } from "./weather.js";
import { renderMeteogram } from "./meteogram.js";
import { fetchColumn, buildField } from "./column.js";
import { renderCrossSection } from "./crosssection.js";
import { buildBriefingHtml } from "./briefing.js";
import { evaluate as evaluateGoNoGo } from "./gonogo.js";
import { renderGoNoGoTable } from "./gonogotable.js";
import { DRONE_PROFILES, getProfile } from "./droneProfiles.js";
import * as astro from "./astro.js";
import { settings, loadSettings, updateSetting, OPTIONS } from "./settings.js";
import {
  fmtHeight, fmtWind, fmtTemp, fmtDir, heightUnit,
} from "./units.js";

/* global L */

const el = (id) => document.getElementById(id);
const state = { point: null, marker: null, data: null };

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------
const map = L.map("map", { zoomControl: true }).setView([48.2, 11.6], 7);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap",
}).addTo(map);

map.on("click", (e) => setPoint(e.latlng.lat, e.latlng.lng));

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
}

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

    state.data = { surface, winds, loadedAt: now, wf };
    setStatus(`Geladen · ${model.label} · Gitterhöhe ${Math.round(surface.elevation)} m`, "");
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
  rows.push(`<div class="now-time">Gültig: ${time}</div>`);

  // Modell-Level-Wind auf Flughöhe – der Kernvorteil.
  rows.push(`<div class="wx-group">Wind auf Höhe (${heightUnit()} AGL)</div>`);
  for (const w of winds) {
    const val = w.error
      ? `<span class="hint">${w.error}</span>`
      : `${fmtWind(Math.hypot(w.u, w.v))} · ${fmtDir(windFromDir(w.u, w.v))}`;
    rows.push(line(fmtHeight(w.h), val));
  }

  // Oberfläche / limitierende Faktoren.
  rows.push(`<div class="wx-group">Oberfläche</div>`);
  rows.push(line("Wind 10 m", fmtWind(kmhToMs(at("wind_speed_10m")))
    + (at("wind_direction_10m") != null ? ` · ${fmtDir(at("wind_direction_10m"))}` : "")));
  rows.push(line("Böen 10 m", fmtWind(kmhToMs(at("wind_gusts_10m")))));
  rows.push(line("Temperatur", fmtTemp(at("temperature_2m"))));
  rows.push(line("Taupunkt", fmtTemp(at("dew_point_2m"))));
  rows.push(line("Bewölkung", pct(at("cloud_cover")) + (at("cloud_cover_low") != null ? ` (tief ${pct(at("cloud_cover_low"))})` : "")));
  rows.push(line("Niederschlag", num(at("precipitation"), surface.units.precipitation || "mm")));
  if (at("visibility") != null) rows.push(line("Sicht", visKm(at("visibility"))));
  if (at("cape") != null) rows.push(line("CAPE", num(at("cape"), "J/kg")));
  if (at("freezing_level_height") != null) rows.push(line("Nullgradgrenze", fmtHeight(at("freezing_level_height"))));
  rows.push(line("Wetter", wmoText(at("weather_code"))));

  el("now-body").innerHTML = rows.join("");
}

function line(k, v) {
  return `<div class="wx-line"><span class="k">${k}</span><span class="v">${v}</span></div>`;
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

function openMeteogram() {
  if (!state.data || !state.point) return;
  const { surface } = state.data;
  const { lat, lon } = state.point;
  el("meteogram").hidden = false;
  el("mg-sub").textContent = el("pointpos").textContent;

  // Mondauf-/-untergänge (positionsabhängig, im Code gerechnet) samt Phase.
  const t0 = surface.time[0] * 1000, t1 = surface.time[surface.time.length - 1] * 1000;
  const events = astro.moonRiseSetEvents(t0, t1, lat, lon)
    .map((e) => ({ ...e, ...astro.moonPhase(e.t) }));

  renderMeteogram(el("mg-body"), {
    time: surface.time,
    nights: surface.nights,
    vars: surface.vars,
    units: surface.units,
    moon: { events },
    maxHeightM: settings.maxHeight,
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

// Go/No-Go-Tabelle: Wind auf Flughöhe pro Stunde aus dem bereits gecachten
// WindField auflösen (keine neuen Requests, nur Interpolation) und gegen das
// gewählte Drohnenprofil bewerten.
async function openGoNoGo() {
  if (!state.data || !state.point) return;
  el("gonogo").hidden = false;
  el("gng-sub").textContent = el("pointpos").textContent;
  if (!state.data.windAtHeight) {
    el("gng-body").textContent = "Werte Wind auf Flughöhe aus …";
    try {
      const { lat, lon } = state.point;
      const { surface, wf } = state.data;
      const arr = [];
      for (const t of surface.time) {
        const r = await wf.windAt(lat, lon, { type: "height", mode: "agl", value: settings.maxHeight }, t * 1000);
        arr.push(r.error ? null : { u: r.u, v: r.v });
      }
      state.data.windAtHeight = arr;
    } catch (e) {
      el("gng-body").textContent = "Fehler beim Auswerten des Höhenwinds: " + (e.message || e);
      return;
    }
  }
  renderGoNoGoTable(el("gng-body"), evaluateGoNoGo(
    state.data.surface, state.data.windAtHeight, getProfile(settings.droneProfile), settings.maxHeight,
  ));
}
el("gng-close").addEventListener("click", () => { el("gonogo").hidden = true; });
el("gng-profile").addEventListener("change", (e) => {
  updateSetting("droneProfile", e.target.value);
  if (!el("gonogo").hidden) openGoNoGo();
});

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
  loadSettings();
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
  if (!el("gonogo").hidden && state.data?.windAtHeight) {
    renderGoNoGoTable(el("gng-body"), evaluateGoNoGo(
      state.data.surface, state.data.windAtHeight, getProfile(settings.droneProfile), settings.maxHeight,
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
