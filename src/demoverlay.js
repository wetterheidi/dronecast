/**
 * Kartenlayer (Testfeature): Zwei wählbare Größen rund um DEM90 vs.
 * Modell-Orographie, flächig — wahlweise Farbfläche ODER Zahlenwerte am
 * Gitterpunkt, wie beim Böen-Layer. „Größe" (settings.demLayerQuantity)
 * schaltet zwischen:
 *
 *   - "height"   Δh = Modell-Orographie − DEM90 (m), STATISCH. Räumliche
 *     Darstellung derselben Diagnose, die am Operationspunkt schon als
 *     „Orographie"-Zeile mit Δ läuft (app.js `renderNow()`, siehe
 *     METHODIK.md Abschnitt 5b).
 *   - "pressure" ΔQFE = barometrisch auf DEM90 umgerechneter Modell-
 *     Bodendruck minus Modell-Bodendruck (hPa), STÜNDLICH (Masterzeit-
 *     gekoppelt wie Böen/Wolken).
 *
 * Drei unabhängige Quellen je Gitterpunkt (Details/Warum siehe config.js
 * Kopfkommentar zu DEM_OVERLAY_*):
 *   - DEM90 (`/v1/elevation`): primär API_BASE (Michaels Instanz, seit sie
 *     die weltweiten DEM90-Höhen hostet), Fallback SURFACE_API_BASE.
 *   - Modell-Orographie (`/v1/forecast?hourly=model_elevation&elevation=nan`):
 *     gegen `model.apiBase`, kein Fallback (Modell-Level-Felder gibt es nur
 *     bei Michael, wie bei windoverlay.js/gustoverlay.js). `elevation=nan`
 *     gilt für den GANZEN Request (nicht nur `model_elevation`) und pinnt
 *     damit auch `temperature_2m` auf die Modellhöhe statt auf DEM-Downscaling
 *     — nötig, weil die Druckformel unten konsistent von T2m AM MODELLGITTER
 *     ausgehen muss, nicht von einer bereits höhenkorrigierten Temperatur.
 *   - Modell-Bodendruck + T2m (`hourly=surface_pressure_model,temperature_2m`,
 *     nur im "pressure"-Modus mitgeholt): `surface_pressure_model` ist das
 *     rohe DWD-PS-Feld am Modellgitterpunkt (verifiziert, siehe Memo
 *     dwd-raw-vs-openmeteo-surface-pressure — NICHT `pressure_surface_model`,
 *     der Feldname ist andersherum).
 *
 * Δh-Vorzeichenkonvention wie app.js/METHODIK.md 5b: negativ = Modell glättet
 * einen Gipfel weg (Gelände höher als das Gitter zeigt), positiv = Modell
 * füllt einen Talkessel auf (Gelände niedriger als das Gitter zeigt).
 *
 * ΔQFE-Formel (barometrische Höhenreduktion von der Modellhöhe auf DEM90,
 * mit dem am Modellgitterpunkt herrschenden T2m als Referenztemperatur und
 * konstanter Lapse-Rate 0,0065 K/m — dieselbe Formelfamilie, mit der Open-
 * Meteo/DWD nachweislich `surface_pressure`/`surface_pressure_model`
 * erzeugen, siehe Memo):
 *   QFE_DEM90 = PS_Modell · (1 + 0,0065·Δh / T2m_K) ^ 5,25578
 *   ΔQFE = QFE_DEM90 − PS_Modell
 * Dasselbe Vorzeichenmuster wie Δh: negativ am unaufgelösten Gipfel (dort
 * real höher → real niedrigerer Druck als am Modellgitterpunkt), positiv im
 * unaufgelösten Talkessel. HEURISTISCH wie jede barometrische Extrapolation
 * (siehe [[feedback_document_derived_values]]): geht von einer konstanten
 * Lapse-Rate über die gesamte Δh-Strecke aus, ignoriert reale Schichtung
 * (Inversionen/Föhn) — bei großen |Δh| (Gebirge) entsprechend unsicherer.
 */

import {
  API_BASE, SURFACE_API_BASE, MODELS, TERRAIN_MISMATCH_WARN_M,
  WIND_OVERLAY_MIN_ZOOM, WIND_OVERLAY_DENSITY_OPTIONS,
  DEM_OVERLAY_MAX_POINTS, DEM_OVERLAY_POINTS_PER_REQUEST,
  DEM_OVERLAY_MAX_CONCURRENCY, DEM_OVERLAY_CHUNK_RETRIES,
  DEM_OVERLAY_RATE_LIMIT_COOLDOWN_MS,
} from "./config.js";
import { settings, updateSetting } from "./settings.js";
import { heightToDisplay, heightUnit } from "meteokit/units";
import { nearestIndex } from "meteokit/weather";
import { subscribe as subscribeTime, getMasterMs } from "./timeController.js";
import {
  round5, firstFinite, classFor, hex, bilin, fillBlock,
  buildGrid, debounce, throttle, sleep, qfeAtTarget,
} from "./overlayshared.js";

/* global L */

const el = (id) => document.getElementById(id);

const REFRESH_DEBOUNCE_MS = 500;
const DEM_MAX_RETRIES = 4; // Deckel für Auto-Nachladeversuche nach Teilfehlern
// LRU-Deckel: je Punkt EIN Eintrag (Höhe + optional Druck-Zeitreihe).
const CACHE_MAX = 8000;
// Nur für den "pressure"-Teil relevant (Höhe bleibt für immer gültig): Modell-
// läufe kommen ~stündlich neu, wie beim Böen-Layer.
const CACHE_TTL_MS = 60 * 60 * 1000;
const AUTO_CHECK_MS = 10 * 60 * 1000;
const FILL_ZINDEX = 30; // im wxOverlays-Pane, wie Wind-/Böenfläche
const PX_STEP = 2; // Canvas-Raster: je 2×2-px-Block einmal berechnet

// Gemeinsame divergierende Farbpalette für beide Größen — nur die
// Klassengrenzen unterscheiden sich (m vs. hPa), die Farbwirkung bleibt
// zwischen "Höhendifferenz" und "Druckdifferenz" vergleichbar.
const DIVERGING_RGB = [
  [178, 24, 43], // stark negativ (Gipfel unaufgelöst)
  [239, 138, 98],
  [217, 240, 211], // Toleranzband
  [103, 169, 207],
  [33, 102, 172], // stark positiv (Talkessel aufgefüllt)
];

// Farbklassen Δh (m) — divergierend um 0, mit dem etablierten
// TERRAIN_MISMATCH_WARN_M (config.js) als innerer Toleranzgrenze und einer
// dreifachen Extremgrenze außen.
const DEM_HEIGHT_FILL_STOPS = [
  { max: -3 * TERRAIN_MISMATCH_WARN_M, rgb: DIVERGING_RGB[0] },
  { max: -TERRAIN_MISMATCH_WARN_M, rgb: DIVERGING_RGB[1] },
  { max: TERRAIN_MISMATCH_WARN_M, rgb: DIVERGING_RGB[2] },
  { max: 3 * TERRAIN_MISMATCH_WARN_M, rgb: DIVERGING_RGB[3] },
  { max: Infinity, rgb: DIVERGING_RGB[4] },
];

// Farbklassen ΔQFE (hPa) — Grenzen aus der empirisch ermittelten Sensitivität
// ~9,35 hPa/100 m Höhenlücke (Memo dwd-raw-vs-openmeteo-surface-pressure),
// grob deckungsgleich mit den Meter-Grenzen oben (100 m ≈ 10 hPa, 300 m ≈ 30 hPa).
const PRESSURE_TOLERANCE_HPA = 10;
const DEM_PRESSURE_FILL_STOPS = [
  { max: -3 * PRESSURE_TOLERANCE_HPA, rgb: DIVERGING_RGB[0] },
  { max: -PRESSURE_TOLERANCE_HPA, rgb: DIVERGING_RGB[1] },
  { max: PRESSURE_TOLERANCE_HPA, rgb: DIVERGING_RGB[2] },
  { max: 3 * PRESSURE_TOLERANCE_HPA, rgb: DIVERGING_RGB[3] },
  { max: Infinity, rgb: DIVERGING_RGB[4] },
];

export function initDemOverlay(map) {
  if (!map.getPane("wxOverlays")) {
    const pane = map.createPane("wxOverlays");
    pane.style.zIndex = 350;
    pane.style.pointerEvents = "none";
  }
  const pane = map.getPane("wxOverlays");

  const numGroup = L.layerGroup().addTo(map);
  const canvas = L.DomUtil.create("canvas", "dem-overlay-canvas", pane);
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.zIndex = String(FILL_ZINDEX);
  canvas.style.pointerEvents = "none";
  const ctx = canvas.getContext("2d");

  // key "iLat,iLon,model" -> { dem, mdl, delta (m, immer gesetzt),
  //   ps, t2m (Float32Array je Stunde, hPa/K, nur im "pressure"-Modus),
  //   pressureFetchedAt (ms, für die TTL-Prüfung von ps/t2m) }
  const cache = new Map();
  let times = null; // Unix-Sekunden (stündlich) — nur "pressure"-Modus
  let timeIdx = 0;
  let currentModel = null;
  let lastNodes = null;
  let lastLatStride = 1;
  let lastLonStride = 1;
  let abortCtrl = null;
  let fetchGen = 0;

  // -- Grid ---------------------------------------------------------------------
  function densityMult() {
    const opt = WIND_OVERLAY_DENSITY_OPTIONS.find((d) => d.id === settings.demLayerDensity);
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

  // Ein Eintrag ist veraltet, wenn Δh fehlt (Basis für BEIDE Größen) oder —
  // nur im "pressure"-Modus — wenn ps/t2m fehlen oder ihre TTL abgelaufen ist
  // (Δh selbst hat keine TTL, s. Kopfkommentar).
  function isMissing(entry, quantity) {
    if (!entry || !Number.isFinite(entry.delta)) return true;
    if (quantity === "pressure") {
      if (!entry.ps || !entry.t2m) return true;
      if (!entry.pressureFetchedAt || Date.now() - entry.pressureFetchedAt > CACHE_TTL_MS) return true;
    }
    return false;
  }

  // -- Fetch --------------------------------------------------------------------
  // Generischer Abruf gegen einen Host/Pfad. Wirft bei HTTP-Fehler/Parse-
  // Fehler/API-Error; 429 (nur an der öffentlichen Instanz relevant) trägt
  // `rateLimited`.
  async function fetchJson(base, path, params, signal) {
    const resp = await fetch(`${base}${path}?${params}`, { signal });
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

  // DEM90-Geländehöhe je Punkt: primär Michaels Instanz, bei JEDEM Fehler
  // sofort die öffentliche Instanz (dort schon immer DEM90-basiert) — wie
  // beim Böen-Layer, unabhängig vom gewählten ICON-Modell.
  async function fetchDemChunk(latStr, lonStr, signal) {
    const params = new URLSearchParams({ latitude: latStr, longitude: lonStr });
    let data;
    try {
      data = await fetchJson(API_BASE, "/v1/elevation", params, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      data = await fetchJson(SURFACE_API_BASE, "/v1/elevation", params, signal);
    }
    return Array.isArray(data.elevation) ? data.elevation : [data.elevation];
  }

  // Modell-eigene Orographie (immer) + optional Bodendruck/T2m (nur
  // "pressure"-Modus) je Punkt, EIN Request. `elevation=nan` pinnt den
  // GESAMTEN Request auf die modelleigene Gitterhöhe (kein serverseitiges
  // DEM-Downscaling irgendeines Felds — auch nicht von T2m, s. Kopfkommentar).
  // Bei Mehrpunkt-Requests verlangt die API einen `elevation`-Wert PRO
  // Koordinate, nicht einen einzelnen Skalar für den ganzen Batch.
  // Kein Fallback-Host — Modell-Level-/Modell-eigene Felder gibt es nur bei
  // Michael, wie bei windoverlay.js/gustoverlay.js.
  async function fetchModelChunk(latStr, lonStr, count, model, needPressure, signal) {
    const hourlyVars = needPressure
      ? "model_elevation,surface_pressure_model,temperature_2m"
      : "model_elevation";
    const params = new URLSearchParams({
      latitude: latStr,
      longitude: lonStr,
      elevation: Array(count).fill("nan").join(","),
      hourly: hourlyVars,
      models: model.apiModel,
      timeformat: "unixtime",
      forecast_days: needPressure ? String(settings.forecastDays) : "1",
      cell_selection: "nearest",
    });
    const data = await fetchJson(model.apiBase, "/v1/forecast", params, signal);
    const arr = Array.isArray(data) ? data : [data];
    return arr.map((d) => {
      const h = d.hourly || {};
      const mdl = firstFinite(h.model_elevation);
      if (!needPressure) return { mdl, ps: null, t2m: null };
      if (!times) times = h.time || [];
      const T = (h.time || []).length;
      const psSrc = h.surface_pressure_model || [];
      const t2mSrc = h.temperature_2m || [];
      const ps = new Float32Array(T);
      const t2m = new Float32Array(T);
      for (let t = 0; t < T; t++) {
        ps[t] = psSrc[t] == null ? NaN : psSrc[t];
        t2m[t] = t2mSrc[t] == null ? NaN : t2mSrc[t] + 273.15; // °C -> K
      }
      return { mdl, ps, t2m };
    });
  }

  // Beide Quellen parallel, aber mit allSettled statt Promise.all: ein
  // Fehlschlag wird VOR dem Werfen mit seiner Quelle (DEM90/Modell)
  // beschriftet, statt in einer generischen "X von Y fehlgeschlagen"-Zeile
  // unterzugehen — sonst ist im Status nicht zu unterscheiden, welche der
  // zwei API-Abfragen eigentlich klemmt.
  async function fetchChunk(chunk, modelKey, model, quantity, signal) {
    const latStr = chunk.map(([a]) => round5(a * model.grid)).join(",");
    const lonStr = chunk.map(([, b]) => round5(b * model.grid)).join(",");
    const needPressure = quantity === "pressure";

    const [demRes, mdlRes] = await Promise.allSettled([
      fetchDemChunk(latStr, lonStr, signal),
      fetchModelChunk(latStr, lonStr, chunk.length, model, needPressure, signal),
    ]);
    if (demRes.status === "rejected") throw tagSource(demRes.reason, "DEM90", signal);
    if (mdlRes.status === "rejected") {
      throw tagSource(mdlRes.reason, needPressure ? "Modell (Orographie/Druck)" : "Modell-Orographie", signal);
    }
    const demValues = demRes.value, mdlData = mdlRes.value;

    chunk.forEach(([iLat, iLon], i) => {
      const dem = demValues[i];
      const { mdl, ps, t2m } = mdlData[i];
      const delta = Number.isFinite(dem) && Number.isFinite(mdl) ? mdl - dem : NaN;
      const key = cacheKey(iLat, iLon, modelKey);
      const prev = cache.get(key);
      cacheSet(key, {
        dem, mdl, delta,
        ps: needPressure ? ps : (prev?.ps ?? null),
        t2m: needPressure ? t2m : (prev?.t2m ?? null),
        pressureFetchedAt: needPressure ? Date.now() : (prev?.pressureFetchedAt ?? null),
      });
    });
  }

  async function fetchChunkWithRetry(chunk, modelKey, model, quantity, signal) {
    let lastErr;
    for (let attempt = 0; attempt <= DEM_OVERLAY_CHUNK_RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      try {
        await fetchChunk(chunk, modelKey, model, quantity, signal);
        return;
      } catch (e) {
        if (signal.aborted) throw e;
        if (e.rateLimited) throw e; // sofort nach oben — kein schnelles Retry
        lastErr = e;
        if (attempt < DEM_OVERLAY_CHUNK_RETRIES) await sleep(250 * (attempt + 1), signal);
      }
    }
    throw lastErr;
  }

  async function fetchMissing(nodes, modelKey, model, quantity, signal, onChunk) {
    const chunks = [];
    for (let i = 0; i < nodes.length; i += DEM_OVERLAY_POINTS_PER_REQUEST) {
      chunks.push(nodes.slice(i, i + DEM_OVERLAY_POINTS_PER_REQUEST));
    }
    let next = 0;
    let done = 0;
    let failed = 0;
    let rateLimited = false;
    let retryAfterMs = null;
    let lastError = null; // letzte konkrete Fehlermeldung (mit Quelle) für den Status
    async function worker() {
      while (!signal.aborted && !rateLimited) {
        const i = next++;
        if (i >= chunks.length) return;
        try {
          await fetchChunkWithRetry(chunks[i], modelKey, model, quantity, signal);
          done++;
        } catch (e) {
          if (signal.aborted) return;
          if (e.rateLimited) {
            rateLimited = true;
            retryAfterMs = e.retryAfterMs;
            return;
          }
          failed++;
          lastError = e.message || String(e);
        }
        onChunk?.(done, failed, chunks.length);
      }
    }
    const n = Math.min(DEM_OVERLAY_MAX_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: n }, worker));
    return { done, failed, total: chunks.length, rateLimited, retryAfterMs, lastError };
  }

  function missingNodes(nodes, modelKey, quantity) {
    return nodes.filter(([a, b]) => isMissing(cache.get(cacheKey(a, b, modelKey)), quantity));
  }

  // -- Refresh (Zoom-/Bounds-/Modellwechsel) ------------------------------------
  function computeGridForCurrentView() {
    if (!settings.demLayerOn) return null;
    const zoom = map.getZoom();
    if (zoom < WIND_OVERLAY_MIN_ZOOM) {
      el("ml-dem-hint").hidden = false;
      lastNodes = null;
      numGroup.clearLayers();
      clearCanvas();
      setStatus("");
      return null;
    }
    el("ml-dem-hint").hidden = true;

    const modelKey = settings.model;
    const model = MODELS[modelKey];
    if (!model) return null;
    const quantity = settings.demLayerQuantity;

    // Modellwechsel entwertet ALLES (Gitterindizierung UND Zeitachse hängen
    // am Modell) — die Höhe (Δh) hat sonst keinen eigenen Ablauf, s. o.
    if (currentModel !== modelKey) {
      cache.clear();
      times = null;
      currentModel = modelKey;
    }

    const bounds = map.getBounds();
    const { nodes, latStride, lonStride } = buildGrid(bounds, zoom, model, densityMult(), DEM_OVERLAY_MAX_POINTS);
    lastNodes = nodes;
    lastLatStride = latStride;
    lastLonStride = lonStride;
    if (quantity === "pressure" && times?.length) timeIdx = nearestIndex(times, getMasterMs());
    renderAll(); // sofort aus Cache

    return { nodes, modelKey, model, quantity };
  }

  async function fetchAndRender(nodes, modelKey, model, quantity) {
    if (!missingNodes(nodes, modelKey, quantity).length) {
      setStatus(`${nodes.length} Punkte (alle aus Cache)`);
      renderAll();
      return;
    }

    abortCtrl?.abort();
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    const myGen = ++fetchGen;

    const missing = missingNodes(nodes, modelKey, quantity);
    const throttledRender = throttle(renderAll, 150);
    setStatus(`Lade 0/${missing.length} Punkte …`, true);
    let result;
    try {
      result = await fetchMissing(missing, modelKey, model, quantity, ctrl.signal, (done, failed, total) => {
        if (myGen !== fetchGen) return;
        const loaded = Math.min(done * DEM_OVERLAY_POINTS_PER_REQUEST, missing.length);
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
    if (quantity === "pressure" && times?.length) timeIdx = nearestIndex(times, getMasterMs());
    renderAll();
    if (result.rateLimited) {
      const waitMs = result.retryAfterMs || DEM_OVERLAY_RATE_LIMIT_COOLDOWN_MS;
      setStatus(`Rate-Limit von Open-Meteo erreicht – warte ${Math.ceil(waitMs / 1000)} s …`, true);
      scheduleRateLimitRetry(waitMs);
    } else if (result.failed) {
      const detail = result.lastError ? ` (${result.lastError})` : "";
      setStatus(`${result.failed} von ${result.total} Blöcken fehlgeschlagen${detail} – erneuter Versuch …`, true);
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
      if (settings.demLayerOn) refresh();
    }, ms);
  }

  let retryCount = 0;
  let retryTimer = null;
  function scheduleRetry() {
    if (!settings.demLayerOn || retryCount >= DEM_MAX_RETRIES) return;
    clearTimeout(retryTimer);
    retryCount++;
    retryTimer = setTimeout(() => {
      if (settings.demLayerOn) refresh();
    }, 1500 * retryCount);
  }

  const debouncedFetchAndRender = debounce(fetchAndRender, REFRESH_DEBOUNCE_MS);

  function refresh() {
    const view = computeGridForCurrentView();
    if (!view) return;
    debouncedFetchAndRender.now(view.nodes, view.modelKey, view.model, view.quantity);
  }

  function refreshOnViewChange() {
    const view = computeGridForCurrentView();
    if (!view) return;
    retryCount = 0;
    debouncedFetchAndRender(view.nodes, view.modelKey, view.model, view.quantity);
  }

  // -- Rendering: Sampling ------------------------------------------------------
  // ΔQFE (hPa) am Gitterpunkt zur aktuellen Masterstunde. Formel/Vorzeichen
  // siehe Kopfkommentar; `qfeAtTarget` (overlayshared.js) kapselt die
  // eigentliche Barometrieformel, geteilt mit dem QFE(DEM)-Wert in app.js.
  function pressureDeltaHpa(entry, t) {
    if (!entry?.ps || !entry?.t2m) return NaN;
    const psModel = entry.ps[t];
    const qfeDem = qfeAtTarget(psModel, entry.t2m[t], entry.delta);
    return qfeDem == null ? NaN : qfeDem - psModel;
  }

  // Wert der aktuell gewählten Größe für einen Cache-Eintrag.
  function sampleValue(entry) {
    if (!entry) return NaN;
    return settings.demLayerQuantity === "pressure" ? pressureDeltaHpa(entry, timeIdx) : entry.delta;
  }

  function collectSamples() {
    const out = new Map();
    if (!lastNodes) return out;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, currentModel));
      const v = sampleValue(e);
      if (!Number.isFinite(v)) continue;
      out.set(`${iLat},${iLon}`, v);
    }
    return out;
  }

  // -- Rendering: Farbfläche ----------------------------------------------------
  function resetCanvas() {
    const size = map.getSize();
    canvas.width = size.x;
    canvas.height = size.y;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
  }

  function clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function renderFill() {
    if (!settings.demLayerOn || settings.demLayerMode !== "fill") { clearCanvas(); return; }
    const nodeSamples = collectSamples();
    if (!nodeSamples.size) { clearCanvas(); return; }

    const stops = settings.demLayerQuantity === "pressure" ? DEM_PRESSURE_FILL_STOPS : DEM_HEIGHT_FILL_STOPS;
    const cellDegLat = MODELS[currentModel].grid * lastLatStride;
    const cellDegLon = MODELS[currentModel].grid * lastLonStride;
    const size = map.getSize();
    if (canvas.width !== size.x || canvas.height !== size.y) return; // resize läuft

    const lons = new Float64Array(Math.ceil(size.x / PX_STEP) + 1);
    for (let px = 0, i = 0; px < size.x; px += PX_STEP, i++) lons[i] = map.containerPointToLatLng([px, 0]).lng;
    const lats = new Float64Array(Math.ceil(size.y / PX_STEP) + 1);
    for (let py = 0, i = 0; py < size.y; py += PX_STEP, i++) lats[i] = map.containerPointToLatLng([0, py]).lat;

    const imgData = ctx.createImageData(size.x, size.y);
    const data = imgData.data;

    for (let py = 0, yi = 0; py < size.y; py += PX_STEP, yi++) {
      const fLat = lats[yi] / cellDegLat;
      const cLat0 = Math.floor(fLat);
      const fy = fLat - cLat0;
      const uv00row = cLat0 * lastLatStride, uv10row = (cLat0 + 1) * lastLatStride;
      for (let px = 0, xi = 0; px < size.x; px += PX_STEP, xi++) {
        const fLon = lons[xi] / cellDegLon;
        const cLon0 = Math.floor(fLon);
        const fx = fLon - cLon0;
        const lon0 = cLon0 * lastLonStride, lon1 = (cLon0 + 1) * lastLonStride;
        const c00 = nodeSamples.get(`${uv00row},${lon0}`);
        const c10 = nodeSamples.get(`${uv10row},${lon0}`);
        const c01 = nodeSamples.get(`${uv00row},${lon1}`);
        const c11 = nodeSamples.get(`${uv10row},${lon1}`);
        if (c00 == null || c10 == null || c01 == null || c11 == null) continue; // Datenlücke

        const val = bilin(c00, c10, c01, c11, fy, fx);
        const rgb = classFor(val, stops).rgb;
        fillBlock(data, size.x, size.y, px, py, PX_STEP, rgb);
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // -- Rendering: Zahlenwerte ---------------------------------------------------
  function fmtHeightDelta(deltaM) {
    const sign = deltaM >= 0 ? "+" : "−";
    return `${sign}${Math.round(Math.abs(heightToDisplay(deltaM)))}`;
  }
  function fmtPressureDelta(deltaHpa) {
    const sign = deltaHpa >= 0 ? "+" : "−";
    return `${sign}${Math.abs(deltaHpa).toFixed(1)}`;
  }

  function renderNumbers() {
    numGroup.clearLayers();
    if (!settings.demLayerOn || settings.demLayerMode !== "numbers" || !lastNodes) return;
    const g = MODELS[currentModel].grid;
    const quantity = settings.demLayerQuantity;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, currentModel));
      const v = sampleValue(e);
      if (!Number.isFinite(v)) continue;
      const label = quantity === "pressure" ? fmtPressureDelta(v) : fmtHeightDelta(v);
      const html = `<div class="dem-num">${label}</div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [36, 16], iconAnchor: [18, 8] });
      L.marker([iLat * g, iLon * g], { icon, interactive: false, pane: "wxOverlays", keyboard: false }).addTo(numGroup);
    }
  }

  function renderAll() {
    renderFill();
    renderNumbers();
    updateTimeLabel();
  }

  // -- Zeit (nur "pressure"-Modus, an die Masterzeit gekoppelt) ----------------
  const throttledTimeRender = throttle(renderAll, 100);
  function syncToMasterTime(committed = true) {
    if (settings.demLayerQuantity !== "pressure" || !times?.length) return;
    timeIdx = nearestIndex(times, getMasterMs());
    if (!settings.demLayerOn) return;
    if (committed) renderAll(); else throttledTimeRender();
  }

  // Gemeinsame Zeitanzeige (mf-time-display) mit Wind-/Böen-Layer — nur
  // schreiben, wenn dieser Layer im Druckmodus aktiv ist UND Daten hat, sonst
  // überschreibt er die Anzeige der anderen Layer mit „–".
  function updateTimeLabel() {
    if (!settings.demLayerOn || settings.demLayerQuantity !== "pressure" || !times?.length) return;
    const d = new Date(times[timeIdx] * 1000);
    el("mf-time-display").textContent = `Gültig: ${d.toLocaleString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    })} loc`;
  }

  // -- Legende / Status ---------------------------------------------------------
  // Divergierende Legende (nicht wie gust/cloud aufsteigend ab 0): jede Klasse
  // zeigt ihr Intervall — je nach Größe in der eingestellten Höheneinheit oder
  // in hPa.
  function fmtHeightBound(m) {
    const sign = m > 0 ? "+" : "";
    return `${sign}${Math.round(heightToDisplay(m))}`;
  }
  function fmtPressureBound(hpa) {
    const sign = hpa > 0 ? "+" : "";
    return `${sign}${Math.round(hpa)}`;
  }

  function renderLegend() {
    const isPressure = settings.demLayerQuantity === "pressure";
    const stops = isPressure ? DEM_PRESSURE_FILL_STOPS : DEM_HEIGHT_FILL_STOPS;
    const fmtBound = isPressure ? fmtPressureBound : fmtHeightBound;
    const unitLabel = isPressure ? "hPa" : heightUnit();
    const bounds = stops.map((s) => s.max);
    const chips = stops.map((s, i) => {
      const lo = i === 0 ? -Infinity : bounds[i - 1];
      const hi = s.max;
      let label;
      if (lo === -Infinity) label = `< ${fmtBound(hi)}`;
      else if (hi === Infinity) label = `> ${fmtBound(lo)}`;
      else label = `${fmtBound(lo)}…${fmtBound(hi)}`;
      return `<span><span class="chip" style="background:${hex(s.rgb)}"></span>${label}</span>`;
    });
    el("ml-dem-legend").innerHTML = chips.join("") + ` <span class="hint">${unitLabel}</span>`;
  }

  function renderDensityRadios() {
    el("ml-dem-density").innerHTML = WIND_OVERLAY_DENSITY_OPTIONS.map((d) => `
      <label>
        <input type="radio" name="ml-dem-density" value="${d.id}" />
        ${d.label}
      </label>
    `).join("");
  }

  function renderQuantityRadios() {
    el("ml-dem-quantity").innerHTML = `
      <label><input type="radio" name="ml-dem-quantity" value="height" /> Höhendifferenz (Δh)</label>
      <label><input type="radio" name="ml-dem-quantity" value="pressure" /> Druckdifferenz (ΔQFE)</label>
    `;
  }

  function renderModeRadios() {
    el("ml-dem-mode").innerHTML = `
      <label><input type="radio" name="ml-dem-mode" value="fill" /> Fläche</label>
      <label><input type="radio" name="ml-dem-mode" value="numbers" /> Zahlenwerte</label>
    `;
  }

  function setStatus(msg, busy) {
    const s = el("ml-dem-status");
    s.textContent = msg;
    s.classList.toggle("busy", !!busy);
  }

  // -- UI-Verdrahtung -----------------------------------------------------------
  function setDemBodyVisible(visible) {
    el("ml-dem-body").hidden = !visible;
  }

  function setModeUI(mode) {
    const fill = mode === "fill";
    el("ml-dem-opacity-row").hidden = !fill;
    el("ml-dem-opacity").hidden = !fill;
    el("ml-dem-legend").hidden = !fill;
  }

  function wireUI() {
    el("ml-dem-on").addEventListener("change", (e) => {
      updateSetting("demLayerOn", e.target.checked);
      setDemBodyVisible(e.target.checked);
      if (e.target.checked) refresh(); else removeAll();
    });

    el("ml-dem-quantity").addEventListener("change", (e) => {
      if (e.target.name !== "ml-dem-quantity") return;
      updateSetting("demLayerQuantity", e.target.value);
      renderLegend();
      refresh(); // ggf. fehlende Druckdaten für die neue Größe nachladen
    });

    el("ml-dem-mode").addEventListener("change", (e) => {
      if (e.target.name !== "ml-dem-mode") return;
      updateSetting("demLayerMode", e.target.value);
      setModeUI(e.target.value);
      renderAll();
    });

    const opacity = el("ml-dem-opacity");
    opacity.addEventListener("input", (e) => {
      el("ml-dem-opacity-val").textContent = `${e.target.value}%`;
      canvas.style.opacity = String(Number(e.target.value) / 100);
    });
    opacity.addEventListener("change", (e) => updateSetting("demLayerOpacity", Number(e.target.value) / 100));

    el("ml-dem-density").addEventListener("change", (e) => {
      if (e.target.name !== "ml-dem-density") return;
      updateSetting("demLayerDensity", e.target.value);
      refresh();
    });

    subscribeTime((ms, committed) => syncToMasterTime(committed));

    map.on("moveend zoomend resize", () => { resetCanvas(); refreshOnViewChange(); });
    map.on("zoomstart", clearCanvas);

    // Modellwechsel invalidiert den Cache (queueMicrotask: unsere Listener
    // laufen vor app.js' updateSetting, wie bei windoverlay.js/gustoverlay.js).
    el("set-model")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null; currentModel = null;
      refresh();
    }));
    // Horizontwechsel betrifft nur den Druckmodus (Höhe fragt immer nur 1 Tag
    // ab), invalidiert aber sicherheitshalber den ganzen Cache wie bei Böen/
    // Wolken.
    el("set-days")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null;
      refresh();
    }));
    // Höheneinheit betrifft Legende UND Zahlenwerte (nur im Höhenmodus).
    el("set-unitheight")?.addEventListener("change", () => queueMicrotask(() => {
      renderLegend();
      renderNumbers();
    }));
  }

  function removeAll() {
    lastNodes = null;
    clearTimeout(rateLimitTimer);
    clearTimeout(retryTimer);
    numGroup.clearLayers();
    clearCanvas();
    setStatus("");
    el("ml-dem-hint").hidden = true;
  }

  function restoreFromSettings() {
    el("ml-dem-on").checked = settings.demLayerOn;
    setDemBodyVisible(settings.demLayerOn);
    const quantityRadio = el("ml-dem-quantity").querySelector(`input[value="${settings.demLayerQuantity}"]`);
    if (quantityRadio) quantityRadio.checked = true;
    const modeRadio = el("ml-dem-mode").querySelector(`input[value="${settings.demLayerMode}"]`);
    if (modeRadio) modeRadio.checked = true;
    setModeUI(settings.demLayerMode);
    el("ml-dem-opacity").value = String(Math.round(settings.demLayerOpacity * 100));
    el("ml-dem-opacity-val").textContent = `${Math.round(settings.demLayerOpacity * 100)}%`;
    canvas.style.opacity = String(settings.demLayerOpacity);
    const densityRadio = el("ml-dem-density").querySelector(`input[value="${settings.demLayerDensity}"]`);
    if (densityRadio) densityRadio.checked = true;
    if (settings.demLayerOn) refresh();
  }

  renderQuantityRadios();
  renderModeRadios();
  renderDensityRadios();
  renderLegend();
  resetCanvas();
  wireUI();
  restoreFromSettings();

  // Periodischer Auto-Refresh: nur im Druckmodus relevant (Höhe hat keine
  // TTL) — holt Punkte nach, deren ps/t2m-TTL zwischenzeitlich abgelaufen ist.
  // missingNodes()/isMissing() entscheiden fein je Punkt, kein pauschales
  // Cache-Leeren nötig.
  setInterval(() => {
    if (settings.demLayerOn && settings.demLayerQuantity === "pressure") refresh();
  }, AUTO_CHECK_MS);

  // Punktabfrage für die Cursor-Statuszeile (app.js) — wie renderFill(), aber
  // nur die 4 umschließenden Knoten statt des vollen Canvas-Rasters.
  function valueAt(lat, lon) {
    if (!settings.demLayerOn || !lastNodes) return null;
    const model = MODELS[currentModel];
    if (!model) return null;
    const cellDegLat = model.grid * lastLatStride;
    const cellDegLon = model.grid * lastLonStride;
    const fLat = lat / cellDegLat;
    const cLat0 = Math.floor(fLat);
    const fy = fLat - cLat0;
    const fLon = lon / cellDegLon;
    const cLon0 = Math.floor(fLon);
    const fx = fLon - cLon0;
    const uv00row = cLat0 * lastLatStride, uv10row = (cLat0 + 1) * lastLatStride;
    const lon0 = cLon0 * lastLonStride, lon1 = (cLon0 + 1) * lastLonStride;
    const e00 = cacheGet(cacheKey(uv00row, lon0, currentModel));
    const e10 = cacheGet(cacheKey(uv10row, lon0, currentModel));
    const e01 = cacheGet(cacheKey(uv00row, lon1, currentModel));
    const e11 = cacheGet(cacheKey(uv10row, lon1, currentModel));
    const v00 = sampleValue(e00), v10 = sampleValue(e10), v01 = sampleValue(e01), v11 = sampleValue(e11);
    if (![v00, v10, v01, v11].every(Number.isFinite)) return null;
    const val = bilin(v00, v10, v01, v11, fy, fx);
    return settings.demLayerQuantity === "pressure" ? { deltaHpa: val } : { deltaM: val };
  }

  return { valueAt };
}

// Fehler mit seiner Quelle beschriften, ohne rateLimited/retryAfterMs zu
// verlieren (fetchChunkWithRetry prüft e.rateLimited weiterhin). Ein Abort
// bleibt unangetastet durch — nicht als "fehlgeschlagen" beschriften, das
// wäre irreführend beim gezielten Abbruch eines überholten Refreshs.
function tagSource(err, source, signal) {
  if (signal.aborted) return err;
  err.message = `${source}: ${err.message}`;
  return err;
}

// Retry-After-Header → Millisekunden. Open-Meteo sendet i. d. R. Sekunden als
// Ganzzahl; als Fallback auch das HTTP-Date-Format. null, wenn unbrauchbar
// (dann greift die konfigurierte Cooldown-Zeit).
function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const secs = Number(headerVal);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(headerVal);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}
