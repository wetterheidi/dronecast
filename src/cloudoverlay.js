/**
 * Kartenlayer: Bedeckungsgrad (tief/mittel/hoch) und Ceiling, flächig auf
 * einem Gitter — dieselbe Methodik wie Meteogramm/Briefing (`clouds.js`,
 * `cloudLayers()`/`cloudCeiling()`/`bandCoverage()`), nur räumlich statt an
 * einem Punkt ausgewertet. Schwesterlayer zu windoverlay.js/gustoverlay.js,
 * teilt sich deren Gitter-/Zeichen-/Timing-Mechanik über overlayshared.js.
 *
 * Datenquelle wie beim Wind-Layer: Michaels Instanz (Modell-Level-Daten),
 * weil `cloudFraction()` q/p/t/w je Level braucht — die öffentliche Instanz
 * führt diese nicht.
 *
 * Anders als beim Wind-Layer gibt es HIER keinen Höhenschieber und keine
 * Kopplung an `settings.maxHeight`: eine hohe Schicht (z. B. Cirrus) ist fürs
 * Bedeckungsbild relevant, auch wenn die Flughöhe deutlich niedriger liegt.
 * Das geladene Level-Band reicht daher immer bis `CLOUD_OVERLAY_CAP_M`
 * (analog zum `capM`-Default von `cloudLayers()`), modell-, aber nicht
 * maxHeight-abhängig — `ensureBand()` sondiert es einmal je Modell.
 *
 * EIN Fetch (6 Comps: Höhe/Temperatur/Druck/rel.+spez. Feuchte/Vertikalwind
 * je Bandlevel) speist zwei unabhängig ein-/ausschaltbare Darstellungen:
 *   Bedeckungsgrad — Graufläche, Deckkraft ~ CF (0…1) EINES Stockwerks
 *                     (tief/mittel/hoch, Umschalter, wie beim Böen-Layer).
 *   Ceiling        — Farbfläche (Höhe → Farbskala) ODER Zahlenwerte am
 *                     Gitterpunkt (Umschalter, wie beim Böen-Layer).
 * Beide lesen denselben Cache, unabhängig zuschaltbar (zwei Canvases, damit
 * z. B. Ceiling-Fläche UND Bedeckungsgrad-Fläche gleichzeitig sichtbar sein
 * können — Opacity-Regler je Darstellung steuern das Nebeneinander).
 *
 * Punktebudget deutlich kleiner als beim Wind-Layer: das Level-Band ist bei
 * Wolken oft viel tiefer (bis 12 km) als beim drohnenrelevanten Wind-Band,
 * macht den `hourly`-Variablenteil des Requests entsprechend länger. Noch
 * nicht gegen die echte API kalibriert (siehe config.js `CLOUD_OVERLAY_*`).
 */

import {
  MODELS,
  WIND_OVERLAY_MIN_ZOOM, WIND_OVERLAY_DENSITY_OPTIONS,
  CLOUD_OVERLAY_CAP_M, CLOUD_OVERLAY_MAX_POINTS,
  CLOUD_OVERLAY_POINTS_PER_REQUEST, CLOUD_OVERLAY_MAX_CONCURRENCY,
  CLOUD_OVERLAY_CHUNK_RETRIES,
} from "./config.js";
import { settings, updateSetting } from "./settings.js";
import { nearestIndex } from "./weather.js";
import { subscribe as subscribeTime, getMasterMs } from "./timeController.js";
import { heightToDisplay, heightUnit } from "./units.js";
import { bandCoverage, cloudCeiling } from "./clouds.js";
import {
  clampNum, firstFinite, round5, classFor, hex, bilin, fillBlock, fillBlockAlpha,
  buildGrid, debounce, throttle, sleep,
} from "./overlayshared.js";

/* global L */

const el = (id) => document.getElementById(id);

const REFRESH_DEBOUNCE_MS = 500;
const CLOUD_MAX_RETRIES = 4;
const CACHE_TTL_MS = 60 * 60 * 1000; // Modellläufe kommen ~stündlich neu
// LRU-Deckel: ein Eintrag je Punkt × Level (alle 6 Comps eines Levels
// gebündelt). Worst Case: Punktebudget × Bandtiefe (bis zum Modelltop bzw.
// CLOUD_OVERLAY_CAP_M) mit Reserve fürs Pannen.
const CACHE_MAX = 40000;
const COVER_ZINDEX = 29; // unter der Ceiling-Fläche — Bedeckungsgrad ist der "Hintergrund"
const CEILING_ZINDEX = 30; // wie Wind-/Böenfläche
const PX_STEP = 2;
const AUTO_CHECK_MS = 10 * 60 * 1000;

// Bedeckungsgrad-Fläche: einfarbig grau, Deckkraft ~ CF (0…1). Keine
// Farbklassen wie bei Wind/Böen — die Fläche codiert die Bedeckung
// kontinuierlich in Transparenz, nicht in Farbstufen.
const COVER_RGB = [90, 92, 100];
const COVER_MAX_ALPHA = 220; // bei CF = 1 (0…255)

const COVER_BAND_LABELS = { low: "tief (< 2 km)", mid: "mittel (2–6,5 km)", high: "hoch (> 6,5 km)" };

// Ceiling-Farbfläche: Höhe (m AGL, native Einheit) → Farbe. Rot = niedrig/
// kritisch bis Grün = hoch/unkritisch, an typischen Sichtflug-Minima
// orientiert. Startwerte, noch nicht kalibriert.
const CEILING_FILL_STOPS = [
  { max: 150, rgb: [190, 40, 40] },
  { max: 300, rgb: [225, 120, 40] },
  { max: 600, rgb: [230, 200, 60] },
  { max: 1000, rgb: [140, 200, 90] },
  { max: Infinity, rgb: [60, 160, 90] },
];

export function initCloudOverlay(map) {
  if (!map.getPane("wxOverlays")) {
    const pane = map.createPane("wxOverlays");
    pane.style.zIndex = 350;
    pane.style.pointerEvents = "none";
  }
  const pane = map.getPane("wxOverlays");

  const numGroup = L.layerGroup().addTo(map);
  const coverCanvas = L.DomUtil.create("canvas", "cloud-cover-canvas", pane);
  const ceilingCanvas = L.DomUtil.create("canvas", "cloud-ceiling-canvas", pane);
  for (const [canvas, z] of [[coverCanvas, COVER_ZINDEX], [ceilingCanvas, CEILING_ZINDEX]]) {
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.zIndex = String(z);
    canvas.style.pointerEvents = "none";
  }
  const coverCtx = coverCanvas.getContext("2d");
  const ceilingCtx = ceilingCanvas.getContext("2d");

  const cache = new Map(); // key "iLat,iLon,level,model" -> {comps: {h,t,p,rh,q,w: Float32Array}}
  let times = null;
  let timeIdx = 0;
  let cacheTs = 0;
  let currentModel = null;
  let currentBand = null; // { levels: [nLevels…], heights: [~m AGL…] }, levels[0] = Boden
  let bandKey = null; // modelKey — für welches Modell currentBand gilt (kein maxHeight-Bezug)
  let lastNodes = null;
  let lastLatStride = 1;
  let lastLonStride = 1;
  let abortCtrl = null;
  let fetchGen = 0;

  const COMPS = [
    { name: "h", varFor: (l) => `height_agl_level${l}`, factor: 1 },
    { name: "t", varFor: (l) => `temperature_level${l}`, factor: 1 },
    { name: "p", varFor: (l) => `pressure_level${l}`, factor: 1 },
    { name: "rh", varFor: (l) => `relative_humidity_level${l}`, factor: 1 },
    { name: "q", varFor: (l) => `specific_humidity_level${l}`, factor: 1e-3 },
    { name: "w", varFor: (l) => `wind_w_level${l}`, factor: 1 },
  ];

  // -- Grid-Geometrie -----------------------------------------------------------
  function densityMult() {
    const opt = WIND_OVERLAY_DENSITY_OPTIONS.find((d) => d.id === settings.cloudLayerDensity);
    return (opt || WIND_OVERLAY_DENSITY_OPTIONS[0]).mult;
  }

  // -- Cache (LRU) --------------------------------------------------------------
  function cacheKey(iLat, iLon, lvl, modelKey) {
    return `${iLat},${iLon},${lvl},${modelKey}`;
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

  // -- Fetch ----------------------------------------------------------------------
  async function fetchChunk(chunk, modelKey, model, band, signal) {
    const hourlyVars = [];
    for (const lvl of band.levels) for (const c of COMPS) hourlyVars.push(c.varFor(lvl));
    const params = new URLSearchParams({
      latitude: chunk.map(([a]) => round5(a * model.grid)).join(","),
      longitude: chunk.map(([, b]) => round5(b * model.grid)).join(","),
      hourly: hourlyVars.join(","),
      models: model.apiModel,
      timeformat: "unixtime",
      forecast_days: String(settings.forecastDays),
      cell_selection: "nearest",
    });
    const resp = await fetch(`${model.apiBase}/v1/forecast?${params}`, { signal });
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
    const arr = Array.isArray(data) ? data : [data];
    arr.forEach((d, i) => {
      const [iLat, iLon] = chunk[i];
      const h = d.hourly || {};
      if (!times) times = h.time || [];
      const T = times.length;
      for (const lvl of band.levels) {
        const comps = {};
        for (const c of COMPS) {
          const src = h[c.varFor(lvl)] || [];
          const a = new Float32Array(T);
          for (let t = 0; t < T; t++) a[t] = src[t] == null ? NaN : src[t] * c.factor;
          comps[c.name] = a;
        }
        cacheSet(cacheKey(iLat, iLon, lvl, modelKey), { comps });
      }
    });
  }

  async function fetchChunkWithRetry(chunk, modelKey, model, band, signal) {
    let lastErr;
    for (let attempt = 0; attempt <= CLOUD_OVERLAY_CHUNK_RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      try {
        await fetchChunk(chunk, modelKey, model, band, signal);
        return;
      } catch (e) {
        if (signal.aborted) throw e;
        lastErr = e;
        if (attempt < CLOUD_OVERLAY_CHUNK_RETRIES) await sleep(250 * (attempt + 1), signal);
      }
    }
    throw lastErr;
  }

  async function fetchMissing(nodes, modelKey, model, band, signal, onChunk) {
    const chunks = [];
    for (let i = 0; i < nodes.length; i += CLOUD_OVERLAY_POINTS_PER_REQUEST) {
      chunks.push(nodes.slice(i, i + CLOUD_OVERLAY_POINTS_PER_REQUEST));
    }
    let next = 0, done = 0, failed = 0;
    async function worker() {
      while (!signal.aborted) {
        const i = next++;
        if (i >= chunks.length) return;
        try {
          await fetchChunkWithRetry(chunks[i], modelKey, model, band, signal);
          done++;
        } catch {
          if (signal.aborted) return;
          failed++;
        }
        onChunk?.(done, failed, chunks.length);
      }
    }
    const n = Math.min(CLOUD_OVERLAY_MAX_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: n }, worker));
    return { done, failed, total: chunks.length };
  }

  function missingNodes(nodes, band, modelKey) {
    return nodes.filter(([a, b]) => !band.levels.every((l) => cache.has(cacheKey(a, b, l, modelKey))));
  }

  // -- Level-Band -----------------------------------------------------------------
  // Sondiert einmal je Modell die Höhe (AGL) ALLER Level am Kartenzentrum und
  // schneidet das Band bei CLOUD_OVERLAY_CAP_M ab — anders als beim Wind-
  // Layer unabhängig von settings.maxHeight (s. Kopfkommentar).
  async function ensureBand(modelKey, model, signal) {
    if (bandKey === modelKey && currentBand) return currentBand;
    const c = map.getCenter();
    const lat = clampNum(c.lat, model.bbox.latMin, model.bbox.latMax);
    const lon = clampNum(c.lng, model.bbox.lonMin, model.bbox.lonMax);
    const probeLevels = [];
    for (let l = model.nLevels; l >= 1; l--) probeLevels.push(l);
    const params = new URLSearchParams({
      latitude: String(round5(lat)),
      longitude: String(round5(lon)),
      hourly: probeLevels.map((l) => `height_agl_level${l}`).join(","),
      models: model.apiModel,
      timeformat: "unixtime",
      forecast_days: "1",
      cell_selection: "nearest",
    });
    const resp = await fetch(`${model.apiBase}/v1/forecast?${params}`, { signal });
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
    const h = (Array.isArray(data) ? data[0] : data).hourly || {};
    const levels = [];
    const heights = [];
    for (const l of probeLevels) {
      const hl = firstFinite(h[`height_agl_level${l}`]);
      levels.push(l);
      heights.push(hl);
      if (hl != null && hl >= CLOUD_OVERLAY_CAP_M) break;
    }
    currentBand = { levels, heights };
    bandKey = modelKey;
    return currentBand;
  }

  // -- Refresh (Zoom-/Bounds-/Modellwechsel) ---------------------------------------
  function layerActive() {
    return settings.cloudLayerOn && (settings.cloudCoverOn || settings.cloudCeilingOn);
  }

  function computeGridForCurrentView() {
    if (!layerActive()) return null;
    const zoom = map.getZoom();
    if (zoom < WIND_OVERLAY_MIN_ZOOM) {
      el("ml-cloud-hint").hidden = false;
      lastNodes = null;
      numGroup.clearLayers();
      clearCanvases();
      setStatus("");
      return null;
    }
    el("ml-cloud-hint").hidden = true;

    const modelKey = settings.model;
    const model = MODELS[modelKey];
    if (!model) return null;

    if (cacheTs && Date.now() - cacheTs > CACHE_TTL_MS) {
      cache.clear(); times = null; currentBand = null; bandKey = null;
    }
    if (currentModel !== modelKey) {
      cache.clear(); times = null; currentBand = null; bandKey = null;
      currentModel = modelKey;
    }

    const bounds = map.getBounds();
    const { nodes, latStride, lonStride } = buildGrid(bounds, zoom, model, densityMult(), CLOUD_OVERLAY_MAX_POINTS);
    lastNodes = nodes;
    lastLatStride = latStride;
    lastLonStride = lonStride;
    renderAll();

    return { nodes, modelKey, model };
  }

  async function fetchAndRender(nodes, modelKey, model) {
    let band = (bandKey === modelKey && currentBand) ? currentBand : null;
    if (band && !missingNodes(nodes, band, modelKey).length) {
      setStatus(`${nodes.length} Punkte (alle aus Cache)`);
      renderAll();
      return;
    }

    abortCtrl?.abort();
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    const myGen = ++fetchGen;

    if (!band) {
      setStatus("Bestimme Modelllevel …", true);
      try {
        band = await ensureBand(modelKey, model, ctrl.signal);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setStatus(`Fehler: ${e.message || e}`);
        scheduleRetry();
        return;
      }
      if (myGen !== fetchGen) return;
      renderAll();
    }

    const missing = missingNodes(nodes, band, modelKey);
    if (!missing.length) {
      setStatus(`${nodes.length} Punkte (alle aus Cache)`);
      renderAll();
      return;
    }

    const throttledRender = throttle(renderAll, 150);
    setStatus(`Lade 0/${missing.length} Punkte …`, true);
    let result;
    try {
      result = await fetchMissing(missing, modelKey, model, band, ctrl.signal, (done, failed, total) => {
        if (myGen !== fetchGen) return;
        const loaded = Math.min(done * CLOUD_OVERLAY_POINTS_PER_REQUEST, missing.length);
        setStatus(`Lade ${loaded}/${missing.length} Punkte …`, true);
        throttledRender();
      });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setStatus(`Fehler: ${e.message || e}`);
      scheduleRetry();
      return;
    }
    if (myGen !== fetchGen) return;
    cacheTs = Date.now();
    if (times?.length) timeIdx = nearestIndex(times, getMasterMs());
    renderAll();
    if (result.failed) {
      setStatus(`${result.failed} von ${result.total} Blöcken fehlgeschlagen – erneuter Versuch …`, true);
      scheduleRetry();
    } else {
      retryCount = 0;
      setStatus(`${nodes.length} Punkte geladen`);
    }
  }

  let retryCount = 0;
  let retryTimer = null;
  function scheduleRetry() {
    if (!layerActive() || retryCount >= CLOUD_MAX_RETRIES) return;
    clearTimeout(retryTimer);
    retryCount++;
    retryTimer = setTimeout(() => { if (layerActive()) refresh(); }, 1500 * retryCount);
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

  // -- Sampling: Mini-Säule je Punkt aus dem Level-Cache -----------------------
  // Baut eine zu clouds.js kompatible `col` (h/t/p/rh/q/w je Level, über die
  // ganze Zeitreihe) OHNE Kopieren — je Level nur die Referenz auf das
  // gecachte Float32Array. `cloudCeiling`/`bandCoverage` lesen daraus per
  // `timeIdx` genau wie am Operationspunkt (column.js) — dieselbe Methodik,
  // nur räumlich statt punktuell ausgewertet.
  function colAt(iLat, iLon, band, modelKey) {
    const nLevels = band.levels.length;
    const h = [], t = [], p = [], rh = [], q = [], w = [];
    for (const lvl of band.levels) {
      const e = cacheGet(cacheKey(iLat, iLon, lvl, modelKey));
      if (!e) return null;
      h.push(e.comps.h); t.push(e.comps.t); p.push(e.comps.p);
      rh.push(e.comps.rh); q.push(e.comps.q); w.push(e.comps.w);
    }
    return { nLevels, h, t, p, rh, q, w };
  }

  function collectCoverSamples() {
    const out = new Map();
    if (!lastNodes || !times?.length || !currentBand) return out;
    const bandId = settings.cloudCoverBand;
    for (const [iLat, iLon] of lastNodes) {
      const col = colAt(iLat, iLon, currentBand, currentModel);
      if (!col) continue;
      const cov = bandCoverage(col, timeIdx, { capM: CLOUD_OVERLAY_CAP_M });
      const cf = cov[bandId];
      if (Number.isFinite(cf)) out.set(`${iLat},${iLon}`, cf);
    }
    return out;
  }

  function collectCeilingSamples() {
    const out = new Map();
    if (!lastNodes || !times?.length || !currentBand) return out;
    for (const [iLat, iLon] of lastNodes) {
      const col = colAt(iLat, iLon, currentBand, currentModel);
      if (!col) continue;
      const ceil = cloudCeiling(col, timeIdx, { ccLowPct: null });
      if (ceil) out.set(`${iLat},${iLon}`, ceil.baseM);
    }
    return out;
  }

  // -- Rendering: Canvases -----------------------------------------------------
  function resetCanvases() {
    const size = map.getSize();
    for (const canvas of [coverCanvas, ceilingCanvas]) {
      canvas.width = size.x;
      canvas.height = size.y;
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    }
  }
  function clearCanvases() {
    coverCtx.clearRect(0, 0, coverCanvas.width, coverCanvas.height);
    ceilingCtx.clearRect(0, 0, ceilingCanvas.width, ceilingCanvas.height);
  }

  // Gemeinsames Pixelraster für beide Flächen (Web-Mercator separabel, wie
  // Wind-/Böenfläche): liefert die vorab aufgelösten Lon-/Lat-Spalten/Zeilen.
  function pixelAxes(size) {
    const lons = new Float64Array(Math.ceil(size.x / PX_STEP) + 1);
    for (let px = 0, i = 0; px < size.x; px += PX_STEP, i++) lons[i] = map.containerPointToLatLng([px, 0]).lng;
    const lats = new Float64Array(Math.ceil(size.y / PX_STEP) + 1);
    for (let py = 0, i = 0; py < size.y; py += PX_STEP, i++) lats[i] = map.containerPointToLatLng([0, py]).lat;
    return { lons, lats };
  }

  function renderScalarFill(ctx, canvas, samples, cellDegLat, cellDegLon, draw) {
    const size = map.getSize();
    if (canvas.width !== size.x || canvas.height !== size.y) return;
    const { lons, lats } = pixelAxes(size);
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
        const v00 = samples.get(`${uv00row},${lon0}`);
        const v10 = samples.get(`${uv10row},${lon0}`);
        const v01 = samples.get(`${uv00row},${lon1}`);
        const v11 = samples.get(`${uv10row},${lon1}`);
        if (v00 == null || v10 == null || v01 == null || v11 == null) continue;
        const val = bilin(v00, v10, v01, v11, fy, fx);
        draw(data, size.x, size.y, px, py, val);
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function renderCoverFill() {
    if (!settings.cloudLayerOn || !settings.cloudCoverOn) { coverCtx.clearRect(0, 0, coverCanvas.width, coverCanvas.height); return; }
    const samples = collectCoverSamples();
    if (!samples.size) { coverCtx.clearRect(0, 0, coverCanvas.width, coverCanvas.height); return; }
    const cellDegLat = MODELS[currentModel].grid * lastLatStride;
    const cellDegLon = MODELS[currentModel].grid * lastLonStride;
    renderScalarFill(coverCtx, coverCanvas, samples, cellDegLat, cellDegLon, (data, w, h, px, py, cf) => {
      const alpha = Math.round(clampNum(cf, 0, 1) * COVER_MAX_ALPHA);
      fillBlockAlpha(data, w, h, px, py, PX_STEP, COVER_RGB, alpha);
    });
  }

  function renderCeilingFill() {
    if (!settings.cloudLayerOn || !settings.cloudCeilingOn || settings.cloudCeilingMode !== "fill") {
      ceilingCtx.clearRect(0, 0, ceilingCanvas.width, ceilingCanvas.height);
      return;
    }
    const samples = collectCeilingSamples();
    if (!samples.size) { ceilingCtx.clearRect(0, 0, ceilingCanvas.width, ceilingCanvas.height); return; }
    const cellDegLat = MODELS[currentModel].grid * lastLatStride;
    const cellDegLon = MODELS[currentModel].grid * lastLonStride;
    renderScalarFill(ceilingCtx, ceilingCanvas, samples, cellDegLat, cellDegLon, (data, w, h, px, py, baseM) => {
      const rgb = classFor(baseM, CEILING_FILL_STOPS).rgb;
      fillBlock(data, w, h, px, py, PX_STEP, rgb);
    });
  }

  function renderCeilingNumbers() {
    numGroup.clearLayers();
    if (!settings.cloudLayerOn || !settings.cloudCeilingOn || settings.cloudCeilingMode !== "numbers"
        || !lastNodes || !times?.length || !currentBand) return;
    const g = MODELS[currentModel].grid;
    for (const [iLat, iLon] of lastNodes) {
      const col = colAt(iLat, iLon, currentBand, currentModel);
      if (!col) continue;
      const ceil = cloudCeiling(col, timeIdx, { ccLowPct: null });
      if (!ceil) continue;
      const label = String(Math.round(heightToDisplay(ceil.baseM)));
      const html = `<div class="cloud-num">${label}</div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [36, 16], iconAnchor: [18, 8] });
      L.marker([iLat * g, iLon * g], { icon, interactive: false, pane: "wxOverlays", keyboard: false }).addTo(numGroup);
    }
  }

  function renderAll() {
    renderCoverFill();
    renderCeilingFill();
    renderCeilingNumbers();
    updateTimeLabel();
  }

  // -- Zeit (an die Masterzeit gekoppelt) -----------------------------------------
  const throttledTimeRender = throttle(renderAll, 100);
  function syncToMasterTime(committed = true) {
    if (!times?.length) { updateTimeLabel(); return; }
    timeIdx = nearestIndex(times, getMasterMs());
    if (!layerActive()) { updateTimeLabel(); return; }
    if (committed) renderAll(); else throttledTimeRender();
  }

  // Gemeinsame Zeitanzeige mit Wind-/Böenlayer — nur schreiben, wenn dieser
  // Layer aktiv ist, sonst überschreibt er deren Anzeige mit „–".
  function updateTimeLabel() {
    if (!layerActive() || !times?.length) return;
    const d = new Date(times[timeIdx] * 1000);
    el("mf-time-display").textContent = `Gültig: ${d.toLocaleString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    })} loc`;
  }

  // -- Legende / Status --------------------------------------------------------------
  function renderCoverLegend() {
    el("ml-cloud-cover-legend").innerHTML = `
      <span class="cloud-cover-gradient"></span>
      <span class="hint">0 % … 100 % Bedeckung, Stockwerk ${COVER_BAND_LABELS[settings.cloudCoverBand]}</span>
    `;
  }

  function renderCeilingLegend() {
    let last = 0;
    const chips = CEILING_FILL_STOPS.map((s) => {
      const label = s.max === Infinity
        ? `> ${Math.round(heightToDisplay(last))}`
        : `${Math.round(heightToDisplay(last))}–${Math.round(heightToDisplay(s.max))}`;
      last = s.max;
      return `<span><span class="chip" style="background:${hex(s.rgb)}"></span>${label}</span>`;
    });
    el("ml-cloud-ceiling-legend").innerHTML = chips.join("") + ` <span class="hint">${heightUnit()} AGL</span>`;
  }

  function setStatus(msg, busy) {
    const s = el("ml-cloud-status");
    s.textContent = msg;
    s.classList.toggle("busy", !!busy);
  }

  // -- UI-Verdrahtung -----------------------------------------------------------------
  function setCloudBodyVisible(visible) {
    el("ml-cloud-body").hidden = !visible;
  }
  function setCoverUI() {
    const on = settings.cloudCoverOn;
    el("ml-cloud-cover-band").hidden = !on;
    el("ml-cloud-cover-opacity-row").hidden = !on;
    el("ml-cloud-cover-opacity").hidden = !on;
    el("ml-cloud-cover-legend").hidden = !on;
    coverCanvas.style.display = on ? "" : "none";
  }
  function setCeilingUI() {
    const on = settings.cloudCeilingOn;
    const fill = on && settings.cloudCeilingMode === "fill";
    el("ml-cloud-ceiling-mode").hidden = !on;
    el("ml-cloud-ceiling-opacity-row").hidden = !fill;
    el("ml-cloud-ceiling-opacity").hidden = !fill;
    el("ml-cloud-ceiling-legend").hidden = !fill;
    ceilingCanvas.style.display = fill ? "" : "none";
  }

  function renderDensityRadios() {
    el("ml-cloud-density").innerHTML = WIND_OVERLAY_DENSITY_OPTIONS.map((d) => `
      <label><input type="radio" name="ml-cloud-density" value="${d.id}" />${d.label}</label>
    `).join("");
  }
  function renderCoverBandRadios() {
    el("ml-cloud-cover-band").innerHTML = `
      <label><input type="radio" name="ml-cloud-cover-band" value="low" /> tief</label>
      <label><input type="radio" name="ml-cloud-cover-band" value="mid" /> mittel</label>
      <label><input type="radio" name="ml-cloud-cover-band" value="high" /> hoch</label>
    `;
  }
  function renderCeilingModeRadios() {
    el("ml-cloud-ceiling-mode").innerHTML = `
      <label><input type="radio" name="ml-cloud-ceiling-mode" value="fill" /> Fläche</label>
      <label><input type="radio" name="ml-cloud-ceiling-mode" value="numbers" /> Zahlenwerte</label>
    `;
  }

  function wireUI() {
    el("ml-cloud-on").addEventListener("change", (e) => {
      updateSetting("cloudLayerOn", e.target.checked);
      setCloudBodyVisible(e.target.checked);
      if (e.target.checked) refresh(); else removeAll();
    });

    el("ml-cloud-cover-on").addEventListener("change", (e) => {
      updateSetting("cloudCoverOn", e.target.checked);
      setCoverUI();
      renderAll();
    });
    el("ml-cloud-cover-band").addEventListener("change", (e) => {
      if (e.target.name !== "ml-cloud-cover-band") return;
      updateSetting("cloudCoverBand", e.target.value);
      renderCoverLegend();
      renderAll();
    });
    const coverOpacity = el("ml-cloud-cover-opacity");
    coverOpacity.addEventListener("input", (e) => {
      el("ml-cloud-cover-opacity-val").textContent = `${e.target.value}%`;
      coverCanvas.style.opacity = String(Number(e.target.value) / 100);
    });
    coverOpacity.addEventListener("change", (e) => updateSetting("cloudCoverOpacity", Number(e.target.value) / 100));

    el("ml-cloud-ceiling-on").addEventListener("change", (e) => {
      updateSetting("cloudCeilingOn", e.target.checked);
      setCeilingUI();
      renderAll();
    });
    el("ml-cloud-ceiling-mode").addEventListener("change", (e) => {
      if (e.target.name !== "ml-cloud-ceiling-mode") return;
      updateSetting("cloudCeilingMode", e.target.value);
      setCeilingUI();
      renderAll();
    });
    const ceilingOpacity = el("ml-cloud-ceiling-opacity");
    ceilingOpacity.addEventListener("input", (e) => {
      el("ml-cloud-ceiling-opacity-val").textContent = `${e.target.value}%`;
      ceilingCanvas.style.opacity = String(Number(e.target.value) / 100);
    });
    ceilingOpacity.addEventListener("change", (e) => updateSetting("cloudCeilingOpacity", Number(e.target.value) / 100));

    subscribeTime((ms, committed) => syncToMasterTime(committed));

    el("ml-cloud-density").addEventListener("change", (e) => {
      if (e.target.name !== "ml-cloud-density") return;
      updateSetting("cloudLayerDensity", e.target.value);
      refresh();
    });

    map.on("moveend zoomend resize", () => { resetCanvases(); refreshOnViewChange(); });
    map.on("zoomstart", clearCanvases);

    el("set-model")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null; currentModel = null; currentBand = null; bandKey = null;
      refresh();
    }));
    el("set-days")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null;
      refresh();
    }));
    el("set-unitheight")?.addEventListener("change", () => queueMicrotask(() => {
      renderCeilingLegend();
      renderCeilingNumbers();
    }));
  }

  function removeAll() {
    lastNodes = null;
    numGroup.clearLayers();
    clearCanvases();
    setStatus("");
    el("ml-cloud-hint").hidden = true;
  }

  function restoreFromSettings() {
    el("ml-cloud-on").checked = settings.cloudLayerOn;
    setCloudBodyVisible(settings.cloudLayerOn);

    const densityRadio = el("ml-cloud-density").querySelector(`input[value="${settings.cloudLayerDensity}"]`);
    if (densityRadio) densityRadio.checked = true;

    el("ml-cloud-cover-on").checked = settings.cloudCoverOn;
    const bandRadio = el("ml-cloud-cover-band").querySelector(`input[value="${settings.cloudCoverBand}"]`);
    if (bandRadio) bandRadio.checked = true;
    el("ml-cloud-cover-opacity").value = String(Math.round(settings.cloudCoverOpacity * 100));
    el("ml-cloud-cover-opacity-val").textContent = `${Math.round(settings.cloudCoverOpacity * 100)}%`;
    coverCanvas.style.opacity = String(settings.cloudCoverOpacity);
    setCoverUI();

    el("ml-cloud-ceiling-on").checked = settings.cloudCeilingOn;
    const modeRadio = el("ml-cloud-ceiling-mode").querySelector(`input[value="${settings.cloudCeilingMode}"]`);
    if (modeRadio) modeRadio.checked = true;
    el("ml-cloud-ceiling-opacity").value = String(Math.round(settings.cloudCeilingOpacity * 100));
    el("ml-cloud-ceiling-opacity-val").textContent = `${Math.round(settings.cloudCeilingOpacity * 100)}%`;
    ceilingCanvas.style.opacity = String(settings.cloudCeilingOpacity);
    setCeilingUI();

    if (settings.cloudLayerOn) refresh();
  }

  renderDensityRadios();
  renderCoverBandRadios();
  renderCeilingModeRadios();
  renderCoverLegend();
  renderCeilingLegend();
  resetCanvases();
  wireUI();
  restoreFromSettings();

  setInterval(() => {
    if (layerActive() && Date.now() - cacheTs > CACHE_TTL_MS) refresh();
  }, AUTO_CHECK_MS);

  // Punktabfrage für die Cursor-Statuszeile (app.js): die 4 umschließenden
  // Knoten-Säulen holen (wie colAt in collectCoverSamples/collectCeilingSamples),
  // Bedeckungsgrad/Ceiling je Knoten ableiten und ERST DANN (wie renderScalarFill)
  // bilinear interpolieren — nicht die rohen Säulen selbst interpolieren, das
  // wäre fachlich falsch (CF/Ceiling sind keine linearen Größen der Rohdaten).
  function valueAt(lat, lon) {
    if (!settings.cloudLayerOn || !lastNodes || !times?.length || !currentBand) return null;
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
    const col00 = colAt(uv00row, lon0, currentBand, currentModel);
    const col10 = colAt(uv10row, lon0, currentBand, currentModel);
    const col01 = colAt(uv00row, lon1, currentBand, currentModel);
    const col11 = colAt(uv10row, lon1, currentBand, currentModel);
    if (!col00 || !col10 || !col01 || !col11) return null;

    let coverPct = null;
    if (settings.cloudCoverOn) {
      const bandId = settings.cloudCoverBand;
      const cf00 = bandCoverage(col00, timeIdx, { capM: CLOUD_OVERLAY_CAP_M })[bandId];
      const cf10 = bandCoverage(col10, timeIdx, { capM: CLOUD_OVERLAY_CAP_M })[bandId];
      const cf01 = bandCoverage(col01, timeIdx, { capM: CLOUD_OVERLAY_CAP_M })[bandId];
      const cf11 = bandCoverage(col11, timeIdx, { capM: CLOUD_OVERLAY_CAP_M })[bandId];
      if ([cf00, cf10, cf01, cf11].every(Number.isFinite)) {
        coverPct = bilin(cf00, cf10, cf01, cf11, fy, fx) * 100;
      }
    }

    let ceilingM = null;
    if (settings.cloudCeilingOn) {
      const ceil00 = cloudCeiling(col00, timeIdx, { ccLowPct: null });
      const ceil10 = cloudCeiling(col10, timeIdx, { ccLowPct: null });
      const ceil01 = cloudCeiling(col01, timeIdx, { ccLowPct: null });
      const ceil11 = cloudCeiling(col11, timeIdx, { ccLowPct: null });
      if (ceil00 && ceil10 && ceil01 && ceil11) {
        ceilingM = bilin(ceil00.baseM, ceil10.baseM, ceil01.baseM, ceil11.baseM, fy, fx);
      }
    }

    if (coverPct == null && ceilingM == null) return null;
    return { coverPct, ceilingM, band: settings.cloudCoverBand };
  }

  return { valueAt };
}
