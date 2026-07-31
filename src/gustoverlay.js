/**
 * Kartenlayer: Windböen an der Oberfläche (`wind_gusts_10m`, ~10 m AGL) als
 * flächige Darstellung — wahlweise halbtransparente Farbfläche ODER Zahlenwerte
 * am Gitterpunkt (Umschalter „mode"). Schwesterlayer zu windoverlay.js, teilt
 * sich dessen Gitter-/Zeichen-/Timing-Mechanik über overlayshared.js.
 *
 * Warum ein EIGENES Modul statt eines weiteren Parameters im Wind-Overlay:
 * Böen sind ein reines Oberflächenfeld — es gibt sie NUR in 10 m, nicht auf
 * nativen Modell-Leveln. Damit entfällt die gesamte Höhenband-Maschinerie des
 * Wind-Layers (kein `ensureBand`, kein Höhenschieber, eine Cache-Dimension
 * weniger). Zudem führt Michaels Modell-Level-Instanz (`API_BASE`) die
 * Oberflächenfelder nicht — Böen kommen von der öffentlichen Instanz
 * (`SURFACE_API_BASE`, siehe config.js/weather.js). Level-zentrierte Pipeline +
 * andere Datenquelle ⇒ sauberer als eigenständiger Layer.
 *
 * Zwei Darstellungsmodi (settings.gustLayerMode), bewusst als Umschalter (nicht
 * gleichzeitig), um das Kartenbild ruhig zu halten:
 *   "fill"    — interpolierte Farbfläche der Böengeschwindigkeit (wie Wind).
 *   "numbers" — Böengeschwindigkeit als Zahl (in der eingestellten Windeinheit)
 *               am Gitterpunkt, dunkel mit weißem Halo für Lesbarkeit über
 *               OSM/Satellit.
 *
 * Min-Zoom und Dichtestufen teilt er mit dem Wind-Layer (WIND_OVERLAY_MIN_ZOOM,
 * WIND_OVERLAY_DENSITY_OPTIONS). Punktebudget, Parallelität und Retry-Verhalten
 * sind dagegen EIGEN und bewusst sparsamer (GUST_OVERLAY_*): der Wind-Layer
 * trifft eine limitfreie Instanz, der Böen-Layer die gemeterte öffentliche —
 * die mit HTTP 429 antwortet, wenn zu viele Locations/Requests in kurzer Zeit
 * kommen. Bei 429 pausiert der Pool und wartet Retry-After ab (statt schnell
 * nachzufeuern und das Limit zu verschärfen). Caching (LRU je Punkt, 1 h TTL)
 * verhindert Re-Fetches beim Zeitschieben und Pannen im geladenen Gebiet.
 */

import {
  SURFACE_API_BASE, MODELS,
  WIND_OVERLAY_MIN_ZOOM, WIND_OVERLAY_DENSITY_OPTIONS,
  GUST_OVERLAY_MAX_POINTS, GUST_OVERLAY_POINTS_PER_REQUEST,
  GUST_OVERLAY_MAX_CONCURRENCY, GUST_OVERLAY_CHUNK_RETRIES,
  GUST_OVERLAY_RATE_LIMIT_COOLDOWN_MS,
} from "./config.js";
import { settings, updateSetting } from "./settings.js";
import { nearestIndex } from "./weather.js";
import { subscribe as subscribeTime, getMasterMs } from "./timeController.js";
import { windToDisplay, windUnit } from "./units.js";
import {
  clampNum, round5, classFor, hex, bilin, fillBlock,
  buildGrid, debounce, throttle, sleep,
} from "./overlayshared.js";

/* global L */

const el = (id) => document.getElementById(id);

const KMH_TO_MS = 1 / 3.6;
const REFRESH_DEBOUNCE_MS = 500;
const GUST_MAX_RETRIES = 4; // Deckel für Auto-Nachladeversuche nach Teilfehlern
const CACHE_TTL_MS = 60 * 60 * 1000; // Modellläufe kommen ~stündlich neu
// LRU-Deckel: je Punkt EIN Eintrag (kein Levelband). Worst Case ist das
// Punktebudget des dichtesten Gitters mit reichlich Reserve für Pannen.
const CACHE_MAX = 8000;
const FILL_ZINDEX = 30; // im wxOverlays-Pane, wie die Windfläche
const PX_STEP = 2; // Canvas-Raster: je 2×2-px-Block einmal berechnet
const AUTO_CHECK_MS = 10 * 60 * 1000;

// Farbklassen der Böenfläche — intern m/s. Böen reichen höher als der
// mittlere Bodenwind; die 15-m/s-Grenze markiert das typische Böen-Limit aus
// droneProfiles.js (gustSurface). Bewusst statisch (nicht ans Profil gekoppelt).
const GUST_FILL_STOPS = [
  { max: 6, rgb: [110, 170, 235] },
  { max: 9, rgb: [120, 200, 160] },
  { max: 12, rgb: [160, 210, 100] },
  { max: 15, rgb: [235, 210, 80] }, // typ. Böen-Limit
  { max: 18, rgb: [240, 150, 60] },
  { max: 22, rgb: [225, 70, 60] },
  { max: Infinity, rgb: [150, 40, 160] },
];

export function initGustOverlay(map) {
  if (!map.getPane("wxOverlays")) {
    const pane = map.createPane("wxOverlays");
    pane.style.zIndex = 350;
    pane.style.pointerEvents = "none";
  }
  const pane = map.getPane("wxOverlays");

  const numGroup = L.layerGroup().addTo(map);
  const canvas = L.DomUtil.create("canvas", "gust-overlay-canvas", pane);
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.zIndex = String(FILL_ZINDEX);
  canvas.style.pointerEvents = "none";
  const ctx = canvas.getContext("2d");

  const cache = new Map(); // key "iLat,iLon,model" -> { g: Float32Array } (m/s je Stunde)
  let times = null; // Unix-Sekunden (stündlich)
  let timeIdx = 0;
  let cacheTs = 0;
  let currentModel = null;
  let lastNodes = null;
  let lastLatStride = 1;
  let lastLonStride = 1;
  let abortCtrl = null;
  let fetchGen = 0;

  // -- Grid ---------------------------------------------------------------------
  function densityMult() {
    const opt = WIND_OVERLAY_DENSITY_OPTIONS.find((d) => d.id === settings.gustLayerDensity);
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
  async function fetchChunk(chunk, modelKey, model, signal) {
    const params = new URLSearchParams({
      latitude: chunk.map(([a]) => round5(a * model.grid)).join(","),
      longitude: chunk.map(([, b]) => round5(b * model.grid)).join(","),
      hourly: "wind_gusts_10m",
      models: model.apiModel,
      timeformat: "unixtime",
      forecast_days: String(settings.forecastDays),
      cell_selection: "nearest",
    });
    const resp = await fetch(`${SURFACE_API_BASE}/v1/forecast?${params}`, { signal });
    // Rate-Limit der öffentlichen Instanz gesondert behandeln: nicht als
    // generischen Fehler schnell wiederholen (das verschärft das Limit nur),
    // sondern nach oben melden, damit der Pool pausiert und Retry-After abwartet.
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
    const arr = Array.isArray(data) ? data : [data];
    arr.forEach((d, i) => {
      const [iLat, iLon] = chunk[i];
      const h = d.hourly || {};
      if (!times) times = h.time || [];
      const T = times.length;
      const src = h.wind_gusts_10m || [];
      const g = new Float32Array(T);
      for (let t = 0; t < T; t++) g[t] = src[t] == null ? NaN : src[t] * KMH_TO_MS;
      cacheSet(cacheKey(iLat, iLon, modelKey), { g });
    });
  }

  async function fetchChunkWithRetry(chunk, modelKey, model, signal) {
    let lastErr;
    for (let attempt = 0; attempt <= GUST_OVERLAY_CHUNK_RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      try {
        await fetchChunk(chunk, modelKey, model, signal);
        return;
      } catch (e) {
        if (signal.aborted) throw e;
        if (e.rateLimited) throw e; // sofort nach oben — kein schnelles Retry
        lastErr = e;
        if (attempt < GUST_OVERLAY_CHUNK_RETRIES) await sleep(250 * (attempt + 1), signal);
      }
    }
    throw lastErr;
  }

  async function fetchMissing(nodes, modelKey, model, signal, onChunk) {
    const chunks = [];
    for (let i = 0; i < nodes.length; i += GUST_OVERLAY_POINTS_PER_REQUEST) {
      chunks.push(nodes.slice(i, i + GUST_OVERLAY_POINTS_PER_REQUEST));
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
            // Pool anhalten: keine weiteren Requests, damit das Limit nicht
            // weiter verschärft wird. Der aufrufende fetchAndRender wartet dann
            // Retry-After ab und lädt die (noch fehlenden) Punkte nach.
            rateLimited = true;
            retryAfterMs = e.retryAfterMs;
            return;
          }
          failed++;
        }
        onChunk?.(done, failed, chunks.length);
      }
    }
    const n = Math.min(GUST_OVERLAY_MAX_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: n }, worker));
    return { done, failed, total: chunks.length, rateLimited, retryAfterMs };
  }

  function missingNodes(nodes, modelKey) {
    return nodes.filter(([a, b]) => !cache.has(cacheKey(a, b, modelKey)));
  }

  // -- Refresh (Zoom-/Bounds-/Modellwechsel) ------------------------------------
  function computeGridForCurrentView() {
    if (!settings.gustLayerOn) return null;
    const zoom = map.getZoom();
    if (zoom < WIND_OVERLAY_MIN_ZOOM) {
      el("ml-gust-hint").hidden = false;
      lastNodes = null;
      numGroup.clearLayers();
      clearCanvas();
      setStatus("");
      return null;
    }
    el("ml-gust-hint").hidden = true;

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
    const { nodes, latStride, lonStride } = buildGrid(bounds, zoom, model, densityMult(), GUST_OVERLAY_MAX_POINTS);
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
        const loaded = Math.min(done * GUST_OVERLAY_POINTS_PER_REQUEST, missing.length);
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
      // Öffentliche Instanz gedrosselt: Retry-After abwarten, dann die noch
      // fehlenden Punkte nachladen (bereits geladene bleiben sichtbar/gecacht).
      const waitMs = result.retryAfterMs || GUST_OVERLAY_RATE_LIMIT_COOLDOWN_MS;
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

  // Nach einem 429: der Layer wartet die (vom Server genannte oder als Fallback
  // konfigurierte) Cooldown-Zeit ab und lädt dann nur die noch fehlenden Punkte
  // nach. Bewusst NICHT durch GUST_MAX_RETRIES gedeckelt (ein Rate-Limit ist
  // kein Serverausfall — Warten löst es zuverlässig), aber nur solange der
  // Layer aktiv bleibt.
  let rateLimitTimer = null;
  function scheduleRateLimitRetry(ms) {
    clearTimeout(rateLimitTimer);
    rateLimitTimer = setTimeout(() => {
      if (settings.gustLayerOn) refresh();
    }, ms);
  }

  let retryCount = 0;
  let retryTimer = null;
  function scheduleRetry() {
    if (!settings.gustLayerOn || retryCount >= GUST_MAX_RETRIES) return;
    clearTimeout(retryTimer);
    retryCount++;
    retryTimer = setTimeout(() => {
      if (settings.gustLayerOn) refresh();
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

  // -- Rendering: Sampling ------------------------------------------------------
  // Böen (m/s) je Knoten an der aktuellen Stunde; null bei Lücke.
  function collectSamples() {
    const out = new Map();
    if (!lastNodes || !times?.length) return out;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, currentModel));
      if (!e) continue;
      const v = e.g[timeIdx];
      if (Number.isFinite(v)) out.set(`${iLat},${iLon}`, v);
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
    if (!settings.gustLayerOn || settings.gustLayerMode !== "fill") { clearCanvas(); return; }
    const nodeSamples = collectSamples();
    if (!nodeSamples.size) { clearCanvas(); return; }

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
        const rgb = classFor(val, GUST_FILL_STOPS).rgb;
        fillBlock(data, size.x, size.y, px, py, PX_STEP, rgb);
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // -- Rendering: Zahlenwerte ---------------------------------------------------
  function renderNumbers() {
    numGroup.clearLayers();
    if (!settings.gustLayerOn || settings.gustLayerMode !== "numbers" || !lastNodes || !times?.length) return;
    const g = MODELS[currentModel].grid;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, currentModel));
      if (!e) continue;
      const v = e.g[timeIdx];
      if (!Number.isFinite(v)) continue;
      const label = String(Math.round(windToDisplay(v)));
      const html = `<div class="gust-num">${label}</div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [30, 16], iconAnchor: [15, 8] });
      L.marker([iLat * g, iLon * g], { icon, interactive: false, pane: "wxOverlays", keyboard: false }).addTo(numGroup);
    }
  }

  function renderAll() {
    renderFill();
    renderNumbers();
    updateTimeLabel();
  }

  // -- Zeit (an die Masterzeit gekoppelt) ---------------------------------------
  const throttledTimeRender = throttle(renderAll, 100);
  function syncToMasterTime(committed = true) {
    if (!times?.length) { updateTimeLabel(); return; }
    timeIdx = nearestIndex(times, getMasterMs());
    if (!settings.gustLayerOn) { updateTimeLabel(); return; }
    if (committed) renderAll(); else throttledTimeRender();
  }

  // Gemeinsame Zeitanzeige (mf-time-display) mit dem Wind-Layer — beide zeigen
  // dieselbe Masterstunde; nur schreiben, wenn dieser Layer aktiv ist und Daten
  // hat, sonst überschreibt er die Anzeige des Wind-Layers mit „–".
  function updateTimeLabel() {
    if (!settings.gustLayerOn || !times?.length) return;
    const d = new Date(times[timeIdx] * 1000);
    el("mf-time-display").textContent = `Gültig: ${d.toLocaleString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    })} loc`;
  }

  // -- Legende / Status ---------------------------------------------------------
  function renderLegend() {
    let last = 0;
    const chips = GUST_FILL_STOPS.map((s) => {
      const label = s.max === Infinity
        ? `> ${Math.round(windToDisplay(last))}`
        : `${Math.round(windToDisplay(last))}–${Math.round(windToDisplay(s.max))}`;
      last = s.max;
      return `<span><span class="chip" style="background:${hex(s.rgb)}"></span>${label}</span>`;
    });
    el("ml-gust-legend").innerHTML = chips.join("") + ` <span class="hint">${windUnit()}</span>`;
  }

  function renderDensityRadios() {
    el("ml-gust-density").innerHTML = WIND_OVERLAY_DENSITY_OPTIONS.map((d) => `
      <label>
        <input type="radio" name="ml-gust-density" value="${d.id}" />
        ${d.label}
      </label>
    `).join("");
  }

  function setStatus(msg, busy) {
    const s = el("ml-gust-status");
    s.textContent = msg;
    s.classList.toggle("busy", !!busy);
  }

  // -- UI-Verdrahtung -----------------------------------------------------------
  function setGustBodyVisible(visible) {
    el("ml-gust-body").hidden = !visible;
  }

  // Deckkraft-Regler und Legende betreffen nur die Farbfläche — im Zahlenmodus
  // ausblenden, damit das Panel zeigt, was gerade wirkt.
  function setModeUI(mode) {
    const fill = mode === "fill";
    el("ml-gust-opacity-row").hidden = !fill;
    el("ml-gust-opacity").hidden = !fill;
    el("ml-gust-legend").hidden = !fill;
  }

  function wireUI() {
    el("ml-gust-on").addEventListener("change", (e) => {
      updateSetting("gustLayerOn", e.target.checked);
      setGustBodyVisible(e.target.checked);
      if (e.target.checked) refresh(); else removeAll();
    });

    el("ml-gust-mode").addEventListener("change", (e) => {
      if (e.target.name !== "ml-gust-mode") return;
      updateSetting("gustLayerMode", e.target.value);
      setModeUI(e.target.value);
      renderAll();
    });

    const opacity = el("ml-gust-opacity");
    opacity.addEventListener("input", (e) => {
      el("ml-gust-opacity-val").textContent = `${e.target.value}%`;
      canvas.style.opacity = String(Number(e.target.value) / 100);
    });
    opacity.addEventListener("change", (e) => updateSetting("gustLayerOpacity", Number(e.target.value) / 100));

    subscribeTime((ms, committed) => syncToMasterTime(committed));

    el("ml-gust-density").addEventListener("change", (e) => {
      if (e.target.name !== "ml-gust-density") return;
      updateSetting("gustLayerDensity", e.target.value);
      refresh();
    });

    map.on("moveend zoomend resize", () => { resetCanvas(); refreshOnViewChange(); });
    map.on("zoomstart", clearCanvas);

    // Modell-/Horizontwechsel invalidieren den Cache (queueMicrotask wie im
    // Wind-Layer: unsere Listener laufen vor app.js' updateSetting).
    el("set-model")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null; currentModel = null;
      refresh();
    }));
    el("set-days")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null;
      refresh();
    }));
    // Windeinheit betrifft Legende UND Zahlenwerte.
    el("set-unitwind")?.addEventListener("change", () => queueMicrotask(() => {
      renderLegend();
      renderNumbers();
    }));
  }

  function removeAll() {
    lastNodes = null;
    clearTimeout(rateLimitTimer);
    numGroup.clearLayers();
    clearCanvas();
    setStatus("");
    el("ml-gust-hint").hidden = true;
  }

  function restoreFromSettings() {
    el("ml-gust-on").checked = settings.gustLayerOn;
    setGustBodyVisible(settings.gustLayerOn);
    const modeRadio = el("ml-gust-mode").querySelector(`input[value="${settings.gustLayerMode}"]`);
    if (modeRadio) modeRadio.checked = true;
    setModeUI(settings.gustLayerMode);
    el("ml-gust-opacity").value = String(Math.round(settings.gustLayerOpacity * 100));
    el("ml-gust-opacity-val").textContent = `${Math.round(settings.gustLayerOpacity * 100)}%`;
    canvas.style.opacity = String(settings.gustLayerOpacity);
    const densityRadio = el("ml-gust-density").querySelector(`input[value="${settings.gustLayerDensity}"]`);
    if (densityRadio) densityRadio.checked = true;
    if (settings.gustLayerOn) refresh();
  }

  renderModeRadios();
  renderDensityRadios();
  renderLegend();
  resetCanvas();
  wireUI();
  restoreFromSettings();

  setInterval(() => {
    if (settings.gustLayerOn && Date.now() - cacheTs > CACHE_TTL_MS) refresh();
  }, AUTO_CHECK_MS);

  function renderModeRadios() {
    el("ml-gust-mode").innerHTML = `
      <label><input type="radio" name="ml-gust-mode" value="fill" /> Fläche</label>
      <label><input type="radio" name="ml-gust-mode" value="numbers" /> Zahlenwerte</label>
    `;
  }
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
