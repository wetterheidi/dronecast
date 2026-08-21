/**
 * Kartenlayer: signifikantes Wetter (`weather_code`, WMO-Tabelle 4677) als
 * WMO-Symbol je Gitterpunkt — Schwesterlayer zu Wind/Böen/Wolken, teilt sich
 * deren Gitter-/Timing-Mechanik über overlayshared.js. Die Symbolzeichnung
 * selbst liegt in `meteokit/wwsymbols` (gemeinsam mit anderen Apps nutzbar).
 *
 * Wie Böen ein reines Oberflächenfeld (kein Level-Band, kein Höhenschieber) —
 * `weather_code` ist wie `wind_gusts_10m` bereits Teil von `SURFACE_CORE` und
 * damit auf BEIDEN Hosts (Michaels ratenlimitfreie Instanz `API_BASE` UND die
 * öffentliche `SURFACE_API_BASE`) mit echten Werten verfügbar (Downloadgruppe
 * "heidiVars", siehe meteokit/config.js) — derselbe Fallback bei jedem Fehler
 * wie bei Böen, keine Sonderbehandlung nötig.
 *
 * NUR EIN Darstellungsmodus (anders als Böen/Wolken): `weather_code` ist
 * kategorial, eine interpolierte Farbfläche zwischen zwei Codes ergäbe keinen
 * Sinn. Gezeichnet wird deshalb immer als Symbol-Marker je Gitterpunkt
 * (`L.divIcon`, wie `cloudoverlay.js`s Zahlenwerte-Modus) — Codes 0-3
 * (klar/bewölkt) bleiben ohne Marker, damit nur "Wetter" auf der Karte
 * erscheint. Aus demselben Grund liefert `valueAt()` den NÄCHSTEN Gitterpunkt
 * statt bilinear zu interpolieren (siehe dort).
 *
 * Kategorie-Farben (Glow-Box + Legende) sind bewusst dieselben sieben wie in
 * meteogram.js' `WW_TYPES` (fog/drizzle/rain/freezing/snow/showers/thunder) —
 * Kartenlayer und Meteogramm-Ribbon zeigen dieselbe Diagnose für denselben
 * Ort/dieselbe Stunde, ein zweites Farbschema wäre ein Widerspruch auf zwei
 * UI-Flächen. `WW_CATEGORIES` unten ist eine lokale Kopie (wie `GUST_FILL_STOPS`
 * auch je Layer lokal liegt) — bei Änderung an `WW_TYPES` dort mitziehen.
 */

import {
  API_BASE, SURFACE_API_BASE, MODELS,
  WIND_OVERLAY_MIN_ZOOM, WIND_OVERLAY_DENSITY_OPTIONS,
  WW_OVERLAY_MAX_POINTS, WW_OVERLAY_POINTS_PER_REQUEST,
  WW_OVERLAY_MAX_CONCURRENCY, WW_OVERLAY_CHUNK_RETRIES,
  WW_OVERLAY_RATE_LIMIT_COOLDOWN_MS,
} from "./config.js";
import { settings, updateSetting } from "./settings.js";
import { nearestIndex } from "meteokit/weather";
import { subscribe as subscribeTime, getMasterMs } from "./timeController.js";
import { wxSymbolMarkup, WX_SYMBOL_VIEWBOX, wmoWeatherCodeToWx, wmoWeatherCategory } from "meteokit/wwsymbols";
import { round5, buildGrid, debounce, throttle, sleep } from "./overlayshared.js";

/* global L */

const el = (id) => document.getElementById(id);

const REFRESH_DEBOUNCE_MS = 500;
const WW_MAX_RETRIES = 4; // Deckel für Auto-Nachladeversuche nach Teilfehlern
const CACHE_TTL_MS = 60 * 60 * 1000; // Modellläufe kommen ~stündlich neu
// LRU-Deckel: je Punkt EIN Eintrag (kein Levelband), wie beim Böen-Layer.
const CACHE_MAX = 8000;
const AUTO_CHECK_MS = 10 * 60 * 1000;
const NO_DATA = -1; // Sentinel im Int16Array: Modellstunde ohne Wert

// Dieselben sieben Kategorien wie meteogram.js' WW_TYPES (siehe Kopfkommentar).
const WW_CATEGORIES = [
  { key: "fog", label: "Nebel", color: "#b0a06a" },
  { key: "drizzle", label: "Niesel", color: "#a6d96a" },
  { key: "rain", label: "Regen", color: "#1a7a1a" },
  { key: "freezing", label: "Vereisung", color: "#7c3aed" },
  { key: "snow", label: "Schnee", color: "#66d9e8" },
  { key: "showers", label: "Schauer", color: "#2a78d6" },
  { key: "thunder", label: "Gewitter", color: "#e34948" },
];
const catByKey = (k) => WW_CATEGORIES.find((c) => c.key === k);

export function initWwOverlay(map) {
  if (!map.getPane("wxOverlays")) {
    const pane = map.createPane("wxOverlays");
    pane.style.zIndex = 350;
    pane.style.pointerEvents = "none";
  }

  const numGroup = L.layerGroup().addTo(map);

  const cache = new Map(); // key "iLat,iLon,model" -> { code: Int16Array }
  let times = null; // Unix-Sekunden (stündlich)
  let timeIdx = 0;
  let cacheTs = 0;
  let currentModel = null;
  let lastNodes = null;
  let lastLatStride = 1;
  let lastLonStride = 1;
  let abortCtrl = null;
  let fetchGen = 0;
  // Getrennt von settings.wwLayerOpacity: der Regler committet erst bei
  // "change" (siehe wireUI) — während des Ziehens soll renderMarkers() aber
  // schon den Live-Wert zeigen, auch wenn zwischenzeitlich ein Masterzeit-Tick
  // einen vollen Rebuild auslöst.
  let displayOpacity = settings.wwLayerOpacity;

  // -- Grid ---------------------------------------------------------------------
  function densityMult() {
    const opt = WIND_OVERLAY_DENSITY_OPTIONS.find((d) => d.id === settings.wwLayerDensity);
    return (opt || WIND_OVERLAY_DENSITY_OPTIONS[0]).mult;
  }

  // -- Cache (LRU) --------------------------------------------------------------
  function cacheKey(iLat, iLon, modelKey) {
    return `${iLat},${iLon},${modelKey}`;
  }
  function cacheGet(key) {
    const v = cache.get(key);
    if (v) { cache.delete(key); cache.set(key, v); }
    return v;
  }
  function cacheSet(key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // -- Fetch --------------------------------------------------------------------
  async function fetchFromHost(base, params, signal) {
    const resp = await fetch(`${base}/v1/forecast?${params}`, { signal });
    if (resp.status === 429) {
      const e = new Error("Rate-Limit (429) der öffentlichen Open-Meteo-Instanz erreicht");
      e.rateLimited = true;
      e.retryAfterMs = parseRetryAfter(resp.headers.get("retry-after"));
      throw e;
    }
    const body = await resp.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`Serverfehler: ${body.slice(0, 180)}`);
    }
    if (!resp.ok || data.error) {
      throw new Error(data.reason ? `API-Fehler: ${data.reason.slice(0, 180)}` : `API-Fehler ${resp.status}`);
    }
    return data;
  }

  async function fetchChunk(chunk, modelKey, model, signal) {
    const params = new URLSearchParams({
      latitude: chunk.map(([a]) => round5(a * model.grid)).join(","),
      longitude: chunk.map(([, b]) => round5(b * model.grid)).join(","),
      hourly: "weather_code",
      models: model.apiModel,
      timeformat: "unixtime",
      forecast_days: String(settings.forecastDays),
      cell_selection: "nearest",
    });

    let data;
    try {
      data = await fetchFromHost(API_BASE, params, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      data = await fetchFromHost(SURFACE_API_BASE, params, signal);
    }

    const arr = Array.isArray(data) ? data : [data];
    arr.forEach((d, i) => {
      const [iLat, iLon] = chunk[i];
      const h = d.hourly || {};
      if (!times) times = h.time || [];
      const T = times.length;
      const src = h.weather_code || [];
      const code = new Int16Array(T);
      for (let t = 0; t < T; t++) code[t] = src[t] == null ? NO_DATA : src[t];
      cacheSet(cacheKey(iLat, iLon, modelKey), { code });
    });
  }

  async function fetchChunkWithRetry(chunk, modelKey, model, signal) {
    let lastErr;
    for (let attempt = 0; attempt <= WW_OVERLAY_CHUNK_RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      try {
        await fetchChunk(chunk, modelKey, model, signal);
        return;
      } catch (e) {
        if (signal.aborted) throw e;
        if (e.rateLimited) throw e; // sofort nach oben — kein schnelles Retry
        lastErr = e;
        if (attempt < WW_OVERLAY_CHUNK_RETRIES) await sleep(250 * (attempt + 1), signal);
      }
    }
    throw lastErr;
  }

  async function fetchMissing(nodes, modelKey, model, signal, onChunk) {
    const chunks = [];
    for (let i = 0; i < nodes.length; i += WW_OVERLAY_POINTS_PER_REQUEST) {
      chunks.push(nodes.slice(i, i + WW_OVERLAY_POINTS_PER_REQUEST));
    }
    let next = 0;
    let done = 0;
    let failed = 0;
    let rateLimited = false;
    let retryAfterMs = null;
    async function worker() {
      while (!signal.aborted && !rateLimited) {
        const i = next++;
        if (i >= chunks.length) return;
        try {
          await fetchChunkWithRetry(chunks[i], modelKey, model, signal);
          done++;
        } catch (e) {
          if (signal.aborted) return;
          if (e.rateLimited) {
            rateLimited = true;
            retryAfterMs = e.retryAfterMs;
            return;
          }
          failed++;
        }
        onChunk?.(done, failed, chunks.length);
      }
    }
    const n = Math.min(WW_OVERLAY_MAX_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: n }, worker));
    return { done, failed, total: chunks.length, rateLimited, retryAfterMs };
  }

  function missingNodes(nodes, modelKey) {
    return nodes.filter(([a, b]) => !cache.has(cacheKey(a, b, modelKey)));
  }

  // -- Refresh (Zoom-/Bounds-/Modellwechsel) ------------------------------------
  function computeGridForCurrentView() {
    if (!settings.wwLayerOn) return null;
    const zoom = map.getZoom();
    if (zoom < WIND_OVERLAY_MIN_ZOOM) {
      el("ml-ww-hint").hidden = false;
      lastNodes = null;
      numGroup.clearLayers();
      setStatus("");
      return null;
    }
    el("ml-ww-hint").hidden = true;

    const modelKey = settings.model;
    const model = MODELS[modelKey];
    if (!model) return null;

    if (cacheTs && Date.now() - cacheTs > CACHE_TTL_MS) {
      cache.clear();
      times = null;
    }
    if (currentModel !== modelKey) {
      cache.clear();
      times = null;
      currentModel = modelKey;
    }

    const bounds = map.getBounds();
    const { nodes, latStride, lonStride } = buildGrid(bounds, zoom, model, densityMult(), WW_OVERLAY_MAX_POINTS);
    lastNodes = nodes;
    lastLatStride = latStride;
    lastLonStride = lonStride;
    renderAll(); // sofort aus Cache

    return { nodes, modelKey, model };
  }

  async function fetchAndRender(nodes, modelKey, model) {
    if (!missingNodes(nodes, modelKey).length) {
      setStatus(`${nodes.length} Punkte (alle aus Cache)`);
      renderAll();
      return;
    }

    abortCtrl?.abort();
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    const myGen = ++fetchGen;

    const missing = missingNodes(nodes, modelKey);
    const throttledRender = throttle(renderAll, 150);
    setStatus(`Lade 0/${missing.length} Punkte …`, true);
    let result;
    try {
      result = await fetchMissing(missing, modelKey, model, ctrl.signal, (done, failed, total) => {
        if (myGen !== fetchGen) return;
        const loaded = Math.min(done * WW_OVERLAY_POINTS_PER_REQUEST, missing.length);
        setStatus(`Lade ${loaded}/${missing.length} Punkte …`, true);
        throttledRender();
      });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setStatus(`Fehler: ${e.message || e}`);
      scheduleRetry();
      return;
    }
    if (myGen !== fetchGen) return; // durch neueren Refresh überholt
    cacheTs = Date.now();
    if (times?.length) timeIdx = nearestIndex(times, getMasterMs());
    renderAll();
    if (result.rateLimited) {
      const waitMs = result.retryAfterMs || WW_OVERLAY_RATE_LIMIT_COOLDOWN_MS;
      setStatus(`Rate-Limit von Open-Meteo erreicht – warte ${Math.ceil(waitMs / 1000)} s …`, true);
      scheduleRateLimitRetry(waitMs);
    } else if (result.failed) {
      setStatus(`${result.failed} von ${result.total} Blöcken fehlgeschlagen – erneuter Versuch …`, true);
      scheduleRetry();
    } else {
      retryCount = 0;
      setStatus(`${nodes.length} Punkte geladen`);
    }
  }

  let rateLimitTimer = null;
  function scheduleRateLimitRetry(ms) {
    clearTimeout(rateLimitTimer);
    rateLimitTimer = setTimeout(() => {
      if (settings.wwLayerOn) refresh();
    }, ms);
  }

  let retryCount = 0;
  let retryTimer = null;
  function scheduleRetry() {
    if (!settings.wwLayerOn || retryCount >= WW_MAX_RETRIES) return;
    clearTimeout(retryTimer);
    retryCount++;
    retryTimer = setTimeout(() => {
      if (settings.wwLayerOn) refresh();
    }, 1500 * retryCount);
  }

  const debouncedFetchAndRender = debounce(fetchAndRender, REFRESH_DEBOUNCE_MS);

  function refresh() {
    const view = computeGridForCurrentView();
    if (!view) return;
    debouncedFetchAndRender.now(view.nodes, view.modelKey, view.model);
  }

  function refreshOnViewChange() {
    const view = computeGridForCurrentView();
    if (!view) return;
    retryCount = 0;
    debouncedFetchAndRender(view.nodes, view.modelKey, view.model);
  }

  // -- Rendering: Symbol-Marker --------------------------------------------------
  function renderMarkers() {
    numGroup.clearLayers();
    if (!settings.wwLayerOn || !lastNodes || !times?.length) return;
    const g = MODELS[currentModel].grid;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, currentModel));
      if (!e) continue;
      const code = e.code[timeIdx];
      if (code === NO_DATA) continue;
      const category = wmoWeatherCategory(code);
      if (!category) continue; // 0-3 (klar/bewölkt): kein Marker
      const svg = wxSymbolMarkup(wmoWeatherCodeToWx(code));
      if (!svg) continue;
      const color = catByKey(category)?.color || "#888";
      const html = `<div class="ww-symbol-box" style="--ww-tint:${color};opacity:${displayOpacity}">` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="${WX_SYMBOL_VIEWBOX}">${svg}</svg>` +
        `</div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [28, 28], iconAnchor: [14, 14] });
      L.marker([iLat * g, iLon * g], { icon, interactive: false, pane: "wxOverlays", keyboard: false }).addTo(numGroup);
    }
  }

  function renderAll() {
    renderMarkers();
    updateTimeLabel();
  }

  // -- Zeit (an die Masterzeit gekoppelt) ---------------------------------------
  const throttledTimeRender = throttle(renderAll, 100);
  function syncToMasterTime(committed = true) {
    if (!times?.length) { updateTimeLabel(); return; }
    timeIdx = nearestIndex(times, getMasterMs());
    if (!settings.wwLayerOn) { updateTimeLabel(); return; }
    if (committed) renderAll(); else throttledTimeRender();
  }

  // Gemeinsame Zeitanzeige (mf-time-display) mit Wind-/Böen-Layer.
  function updateTimeLabel() {
    if (!settings.wwLayerOn || !times?.length) return;
    const d = new Date(times[timeIdx] * 1000);
    el("mf-time-display").textContent = `Gültig: ${d.toLocaleString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    })} loc`;
  }

  // -- Legende / Status ---------------------------------------------------------
  function renderLegend() {
    const chips = WW_CATEGORIES.map((c) =>
      `<span><span class="chip" style="background:${c.color}"></span>${c.label}</span>`);
    el("ml-ww-legend").innerHTML = chips.join("");
  }

  function renderDensityRadios() {
    el("ml-ww-density").innerHTML = WIND_OVERLAY_DENSITY_OPTIONS.map((d) => `
      <label>
        <input type="radio" name="ml-ww-density" value="${d.id}" />
        ${d.label}
      </label>
    `).join("");
  }

  function setStatus(msg, busy) {
    const s = el("ml-ww-status");
    s.textContent = msg;
    s.classList.toggle("busy", !!busy);
  }

  // -- UI-Verdrahtung -----------------------------------------------------------
  function setWwBodyVisible(visible) {
    el("ml-ww-body").hidden = !visible;
  }

  function wireUI() {
    el("ml-ww-on").addEventListener("change", (e) => {
      updateSetting("wwLayerOn", e.target.checked);
      setWwBodyVisible(e.target.checked);
      if (e.target.checked) refresh(); else removeAll();
    });

    const opacity = el("ml-ww-opacity");
    opacity.addEventListener("input", (e) => {
      el("ml-ww-opacity-val").textContent = `${e.target.value}%`;
      displayOpacity = Number(e.target.value) / 100;
      renderMarkers();
    });
    opacity.addEventListener("change", (e) => updateSetting("wwLayerOpacity", Number(e.target.value) / 100));

    subscribeTime((ms, committed) => syncToMasterTime(committed));

    el("ml-ww-density").addEventListener("change", (e) => {
      if (e.target.name !== "ml-ww-density") return;
      updateSetting("wwLayerDensity", e.target.value);
      refresh();
    });

    map.on("moveend zoomend resize", refreshOnViewChange);

    el("set-model")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null; currentModel = null;
      refresh();
    }));
    el("set-days")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null;
      refresh();
    }));
  }

  function removeAll() {
    lastNodes = null;
    clearTimeout(rateLimitTimer);
    numGroup.clearLayers();
    setStatus("");
    el("ml-ww-hint").hidden = true;
  }

  function restoreFromSettings() {
    el("ml-ww-on").checked = settings.wwLayerOn;
    setWwBodyVisible(settings.wwLayerOn);
    el("ml-ww-opacity").value = String(Math.round(settings.wwLayerOpacity * 100));
    el("ml-ww-opacity-val").textContent = `${Math.round(settings.wwLayerOpacity * 100)}%`;
    const densityRadio = el("ml-ww-density").querySelector(`input[value="${settings.wwLayerDensity}"]`);
    if (densityRadio) densityRadio.checked = true;
    if (settings.wwLayerOn) refresh();
  }

  renderDensityRadios();
  renderLegend();
  wireUI();
  restoreFromSettings();

  setInterval(() => {
    if (settings.wwLayerOn && Date.now() - cacheTs > CACHE_TTL_MS) refresh();
  }, AUTO_CHECK_MS);

  // Punktabfrage für die Cursor-Statuszeile (app.js): NÄCHSTER Gitterpunkt statt
  // bilinearer Interpolation — weather_code ist kategorial, ein "Mittelwert"
  // zwischen z. B. 61 (Regen) und 95 (Gewitter) ergäbe keinen sinnvollen Code.
  function valueAt(lat, lon) {
    if (!settings.wwLayerOn || !lastNodes || !times?.length) return null;
    const model = MODELS[currentModel];
    if (!model) return null;
    const g = model.grid;
    const iLat = Math.round(lat / g / lastLatStride) * lastLatStride;
    const iLon = Math.round(lon / g / lastLonStride) * lastLonStride;
    const e = cacheGet(cacheKey(iLat, iLon, currentModel));
    if (!e) return null;
    const code = e.code[timeIdx];
    if (code === NO_DATA) return null;
    return { code, category: wmoWeatherCategory(code) };
  }

  return { valueAt };
}

// Retry-After-Header → Millisekunden (siehe gustoverlay.js).
function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const secs = Number(headerVal);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(headerVal);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}
