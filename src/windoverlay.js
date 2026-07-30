/**
 * Kartenlayer: Wind 10 m (unterstes Modelllevel) als flächige Darstellung —
 * WMO-Windfiedern an Gitterpunkten plus interpolierte, halbtransparente
 * Farbfläche der Windgeschwindigkeit. Datenquelle wie windfield.js/column.js:
 * Michaels Instanz (Modell-Level-Daten, siehe config.js `API_BASE`), hier
 * aber gitterweise statt punktweise abgefragt — es gibt keinen eigenen
 * Gitter-/Tile-Endpunkt, nur die normale Multi-Punkt-`/v1/forecast`-API
 * (komma-getrennte lat/lon-Listen).
 *
 * Level ist überall Parameter (`currentLevel()`) — bewusst so gebaut, damit
 * ein späterer Höhen-Slider (Ausbaustufe 2/3) nur diese eine Funktion
 * ersetzen muss, statt Fetch/Cache/Rendering umzubauen.
 *
 * Räumliche Begrenzung: Drohnenflüge sind kleinräumig, daher liefert der
 * Layer erst ab einem Mindest-Zoom Daten (WIND_OVERLAY_MIN_ZOOM, config.js)
 * und begrenzt zusätzlich die Punktzahl je Refresh (WIND_OVERLAY_MAX_POINTS)
 * durch Ausdünnung des nativen Modellgitters. Lastabschätzung Worst Case:
 * MAX_POINTS Punkte → max. MAX_POINTS/POINTS_PER_REQUEST parallele Requests
 * mit je 2 Variablen über den gewählten Vorhersagehorizont (~100 KB JSON,
 * URL-Länge unkritisch). Zeitslider-Bewegungen und Pannen im bereits
 * geladenen Gebiet erzeugen keine neuen Requests (voller Stunden-Cache je
 * Gitterpunkt).
 *
 * Gitterauflösung: Die Ausdünnung wird getrennt für Breite und Länge in
 * Kilometern (nicht in Grad) berechnet — bei einem gemeinsamen Grad-Stride
 * wären Nord-Süd-Abstände systematisch ~1/cos(Breite) größer als Ost-West
 * (0,02° Länge sind bei 48°N nur ~1,5 km, 0,02° Breite ~2,2 km), was bei
 * Testmessungen zu deutlich asymmetrischen Abständen führte (N-S ca. doppelt
 * so groß wie O-W). Da eine nicht rotierte Web-Mercator-Karte konform ist
 * (px/km an einem Punkt richtungsunabhängig gleich), wird eine einzige
 * Zielweite in km aus einem festen Basis-Pixelabstand abgeleitet und dann je
 * Achse in die passende Anzahl Modellgitter-Schritte umgerechnet (siehe
 * `buildBaseGrid`/`strideForAxis`). Dieses Basisgitter ist das dichteste,
 * budgetbegrenzte Gitter; die nutzerwählbare Dichte (1×/2×/3×) ist ein
 * ganzzahliges Vielfaches DIESES Basisstride (`buildGrid`). Das Vielfache
 * wird bewusst NACH der Budgetbegrenzung angewendet: so sind die Dichtestufen
 * mathematisch garantiert immer unterscheidbar (1×<2×<3×) — anders als bei
 * einem pixelbasierten Ziel, das auf Zweierpotenz-Strides rundet und
 * benachbarte Stufen aufs selbe Gitter kollabieren ließe.
 *
 * Rendering wie in METOCViewer (windbarb_viewer.html): Fiedern als
 * L.divIcon-Marker mit Inline-SVG, Farbfläche als eigenes <canvas> im
 * `wxOverlays`-Pane (kein L.ImageOverlay — spart PNG-Enkodierung/Geo-Bounds,
 * das Canvas wird direkt in Bildschirmpixeln unter den Viewport gelegt).
 */

import {
  API_BASE, MODELS,
  WIND_OVERLAY_MIN_ZOOM, WIND_OVERLAY_MAX_POINTS, WIND_OVERLAY_POINTS_PER_REQUEST,
  WIND_OVERLAY_DENSITY_OPTIONS, WIND_OVERLAY_BASE_TARGET_PX,
} from "./config.js";
import { settings, updateSetting } from "./settings.js";
import { nearestFutureIndex } from "./weather.js";
import { windToDisplay, windUnit } from "./units.js";

/* global L */

const el = (id) => document.getElementById(id);

const KMH_TO_MS = 1 / 3.6;
const KT_PER_MS = 1.94384;
const BARB_SIZE = 44; // px
// Fiedern einfarbig, kontrastreich (dunkel + weißer Halo) — die Geschwindigkeit
// zeigen die Fiedern (Fahnen/Wimpel) und die Farbfläche bereits; eine zusätzliche
// Einfärbung nach Geschwindigkeit verschlechterte nur die Lesbarkeit über OSM.
const BARB_COLOR = "#0b1220";
const REFRESH_DEBOUNCE_MS = 500;
const CACHE_TTL_MS = 60 * 60 * 1000; // Modellläufe kommen ~stündlich neu
const CACHE_MAX = 4000; // LRU-Deckel (Punkte × Level × Modell)
const FILL_ZINDEX = 30; // im wxOverlays-Pane: über Radar(20)/Sat(10), unter den Fiedern
const PX_STEP = 2; // Canvas-Raster: je 2×2-px-Block einmal berechnet
const AUTO_CHECK_MS = 10 * 60 * 1000;
const KM_PER_DEG = 111.32; // Erdradius-Näherung für Breite; Länge: KM_PER_DEG·cos(Breite)

// Farbklassen der Fläche (und, konsistent, der Fiedern) — intern m/s, an
// typischen Drohnen-Limits orientiert (vgl. droneProfiles.js: windSurface
// max. 10 m/s, windBandMax 12 m/s, gustSurface 15 m/s). Bewusst statisch
// statt ans gewählte Profil gekoppelt (Profile sind austauschbare Platzhalter).
const FILL_STOPS = [
  { maxMs: 2, rgb: [110, 170, 235] },
  { maxMs: 4, rgb: [120, 200, 160] },
  { maxMs: 6, rgb: [160, 210, 100] },
  { maxMs: 8, rgb: [235, 210, 80] },
  { maxMs: 10, rgb: [240, 150, 60] }, // typ. Bodenwind-Limit
  { maxMs: 12, rgb: [225, 70, 60] }, // typ. Bandmax-Limit
  { maxMs: Infinity, rgb: [150, 40, 160] },
];

function classFor(speedMs) {
  for (const s of FILL_STOPS) if (speedMs <= s.maxMs) return s;
  return FILL_STOPS[FILL_STOPS.length - 1];
}
function hex(rgb) {
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

export function initWindOverlay(map) {
  if (!map.getPane("wxOverlays")) {
    // Sollte durch initMapLayers(map) bereits existieren; defensiv falls
    // die Aufrufreihenfolge in app.js sich einmal ändert.
    const pane = map.createPane("wxOverlays");
    pane.style.zIndex = 350;
    pane.style.pointerEvents = "none";
  }
  const pane = map.getPane("wxOverlays");

  const barbGroup = L.layerGroup().addTo(map);
  const canvas = L.DomUtil.create("canvas", "wind-overlay-canvas", pane);
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.zIndex = String(FILL_ZINDEX);
  canvas.style.pointerEvents = "none";
  const ctx = canvas.getContext("2d");

  const cache = new Map(); // key "iLat,iLon,level,model" -> {u: Float32Array, v: Float32Array} (m/s)
  let times = null; // Unix-Sekunden (stündlich), gemeinsam für alle Cache-Einträge
  let timeIdx = 0;
  let cacheTs = 0;
  let currentModel = null;
  let currentLevel = null;
  let lastNodes = null; // [[iLat,iLon], …] des letzten Grids
  let lastLatStride = 1;
  let lastLonStride = 1;
  let abortCtrl = null;
  let fetchGen = 0;

  // -- Grid-Geometrie ---------------------------------------------------------
  function densityMult() {
    const opt = WIND_OVERLAY_DENSITY_OPTIONS.find((d) => d.id === settings.windLayerDensity);
    return (opt || WIND_OVERLAY_DENSITY_OPTIONS[0]).mult;
  }

  // Kleinste Zweierpotenz, mit der `gridDeg` mal Stride mal km/Grad die
  // Zielweite (km) erreicht oder überschreitet.
  function strideForAxis(gridDeg, kmPerDeg, targetKm) {
    let s = 1;
    while (gridDeg * s * kmPerDeg < targetKm && s < 128) s *= 2;
    return s;
  }

  function bboxDeg(bounds, model) {
    const latPad = (bounds.getNorth() - bounds.getSouth()) * 0.15;
    const lonPad = (bounds.getEast() - bounds.getWest()) * 0.15;
    return {
      latMin: Math.max(model.bbox.latMin, bounds.getSouth() - latPad),
      latMax: Math.min(model.bbox.latMax, bounds.getNorth() + latPad),
      lonMin: Math.max(model.bbox.lonMin, bounds.getWest() - lonPad),
      lonMax: Math.min(model.bbox.lonMax, bounds.getEast() + lonPad),
    };
  }

  function nodeCount(box, g, latStride, lonStride) {
    const iLatLo = Math.ceil(box.latMin / g / latStride) * latStride;
    const iLatHi = Math.floor(box.latMax / g / latStride) * latStride;
    const iLonLo = Math.ceil(box.lonMin / g / lonStride) * lonStride;
    const iLonHi = Math.floor(box.lonMax / g / lonStride) * lonStride;
    const nLat = Math.max(0, Math.floor((iLatHi - iLatLo) / latStride) + 1);
    const nLon = Math.max(0, Math.floor((iLonHi - iLonLo) / lonStride) + 1);
    return nLat * nLon;
  }

  // Dichtestes Gitter, das noch ins Punktebudget passt (Basis für die
  // 1×/2×/3×-Dichtewahl). Zoom-adaptiv und km-basiert je Achse (Anisotropie,
  // siehe Kopfkommentar).
  function buildBaseGrid(bounds, zoom, model) {
    const g = model.grid;
    const centerLat = (bounds.getNorth() + bounds.getSouth()) / 2;
    const kmPerDegLat = KM_PER_DEG;
    const kmPerDegLon = KM_PER_DEG * Math.cos((centerLat * Math.PI) / 180);
    const pxPerDegLon = (256 * Math.pow(2, zoom)) / 360;
    const pxPerKm = pxPerDegLon / kmPerDegLon;
    const targetKm = WIND_OVERLAY_BASE_TARGET_PX / pxPerKm;

    let latStride = strideForAxis(g, kmPerDegLat, targetKm);
    let lonStride = strideForAxis(g, kmPerDegLon, targetKm);
    const box = bboxDeg(bounds, model);

    for (let guard = 0; guard < 20; guard++) {
      if (nodeCount(box, g, latStride, lonStride) <= WIND_OVERLAY_MAX_POINTS ||
          (latStride >= 128 && lonStride >= 128)) {
        break;
      }
      // Nur die (in km!) jeweils feinere Achse verdoppeln — km/Grad
      // unterscheidet sich zwischen Breite und Länge, gleicher Stride ist also
      // nicht gleiche physische Zellgröße; einzelnes Verdoppeln nähert sich
      // der Budgetgrenze in kleinen Schritten und hält das Seitenverhältnis.
      if (latStride * kmPerDegLat <= lonStride * kmPerDegLon) {
        latStride = Math.min(latStride * 2, 128);
      } else {
        lonStride = Math.min(lonStride * 2, 128);
      }
    }
    return { latStride, lonStride, box };
  }

  // Gitter für die gewählte Dichte: das budgetbegrenzte Basisgitter mit dem
  // Dichte-Vielfachen (1×/2×/3×) je Achse ausgedünnt. Weil das Vielfache erst
  // NACH der Budgetbegrenzung greift, sind die Stufen immer echt verschieden
  // (1×<2×<3×) und liegen — als Vielfaches eines schon passenden Basisgitters —
  // stets unter dem Budget.
  function buildGrid(bounds, zoom, model, mult) {
    const g = model.grid;
    const { latStride: baseLat, lonStride: baseLon, box } = buildBaseGrid(bounds, zoom, model);
    const latStride = baseLat * mult;
    const lonStride = baseLon * mult;
    const iLatLo = Math.ceil(box.latMin / g / latStride) * latStride;
    const iLatHi = Math.floor(box.latMax / g / latStride) * latStride;
    const iLonLo = Math.ceil(box.lonMin / g / lonStride) * lonStride;
    const iLonHi = Math.floor(box.lonMax / g / lonStride) * lonStride;
    const nodes = [];
    for (let a = iLatLo; a <= iLatHi; a += latStride) {
      for (let b = iLonLo; b <= iLonHi; b += lonStride) nodes.push([a, b]);
    }
    return { nodes, latStride, lonStride };
  }

  // -- Cache (LRU) --------------------------------------------------------------
  function cacheKey(iLat, iLon, lvl, modelKey) {
    return `${iLat},${iLon},${lvl},${modelKey}`;
  }
  function cacheGet(key) {
    const v = cache.get(key);
    if (v) { cache.delete(key); cache.set(key, v); } // an den frischen Rand
    return v;
  }
  function cacheSet(key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // -- Fetch --------------------------------------------------------------------
  function round5(x) {
    return Math.round(x * 1e5) / 1e5;
  }

  async function fetchChunk(chunk, modelKey, model, lvl, signal) {
    // Wie column.js/weather.js: `forecast_days` statt start_date/end_date —
    // letzteres würde bei kalendertag-basierter Rundung leicht über den
    // gewünschten Horizont hinausgreifen (unnötig viele Datenlücken-Stunden
    // am Ende des Sliders, sobald der Modelllauf dort nicht mehr reicht).
    const params = new URLSearchParams({
      latitude: chunk.map(([a]) => round5(a * model.grid)).join(","),
      longitude: chunk.map(([, b]) => round5(b * model.grid)).join(","),
      hourly: `wind_u_component_level${lvl},wind_v_component_level${lvl}`,
      models: model.apiModel,
      timeformat: "unixtime",
      forecast_days: String(settings.forecastDays),
      cell_selection: "nearest",
    });
    const resp = await fetch(`${API_BASE}/v1/forecast?${params}`, { signal });
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
      const uSrc = h[`wind_u_component_level${lvl}`] || [];
      const vSrc = h[`wind_v_component_level${lvl}`] || [];
      const u = new Float32Array(T);
      const v = new Float32Array(T);
      for (let t = 0; t < T; t++) {
        u[t] = uSrc[t] == null ? NaN : uSrc[t] * KMH_TO_MS;
        v[t] = vSrc[t] == null ? NaN : vSrc[t] * KMH_TO_MS;
      }
      cacheSet(cacheKey(iLat, iLon, lvl, modelKey), { u, v });
    });
  }

  async function fetchMissing(nodes, modelKey, model, lvl, signal) {
    const chunks = [];
    for (let i = 0; i < nodes.length; i += WIND_OVERLAY_POINTS_PER_REQUEST) {
      chunks.push(nodes.slice(i, i + WIND_OVERLAY_POINTS_PER_REQUEST));
    }
    await Promise.all(chunks.map((c) => fetchChunk(c, modelKey, model, lvl, signal)));
  }

  // -- Refresh (Zoom-/Bounds-/Modellwechsel) -------------------------------------
  function currentLevelFor(modelKey) {
    // Einziger Ort, der "unterstes Level" festlegt — ein späterer Höhen-
    // Slider (Ausbaustufe 2/3) ersetzt nur diese Funktion.
    return MODELS[modelKey].nLevels;
  }

  // Grid für den aktuellen Kartenausschnitt neu berechnen und SOFORT (ohne
  // Debounce) aus dem Cache zeichnen — Fläche UND Fiedern. Wichtig fürs
  // Pannen: vorher wurde nur die Fläche sofort neu gezeichnet (eigenes
  // canvas-Reposition), die Fiedern aber erst mit der (debounced) Netzabfrage
  // neu aufgebaut — dadurch blieben im frisch aufgedeckten Kartenbereich bis
  // zu 500 ms lang gar keine Fiedern sichtbar (die alten sitzen ja an ihren
  // ursprünglichen Geokoordinaten und wandern nicht "mit"). Das hier läuft
  // bei jeder Bewegung sofort, nur der eigentliche Netzabruf bleibt debounced
  // (siehe `refreshOnViewChange`), um beim Pannen keine Anfragen zu spammen.
  function computeGridForCurrentView() {
    if (!settings.windLayerOn) return null;
    const zoom = map.getZoom();
    if (zoom < WIND_OVERLAY_MIN_ZOOM) {
      el("ml-wind-hint").hidden = false;
      lastNodes = null;
      barbGroup.clearLayers();
      clearCanvas();
      setStatus("");
      return null;
    }
    el("ml-wind-hint").hidden = true;

    const modelKey = settings.model;
    const model = MODELS[modelKey];
    if (!model) return null;
    const lvl = currentLevelFor(modelKey);

    if (cacheTs && Date.now() - cacheTs > CACHE_TTL_MS) {
      cache.clear();
      times = null;
    }
    if (currentModel !== modelKey || currentLevel !== lvl) {
      cache.clear();
      times = null;
      currentModel = modelKey;
      currentLevel = lvl;
    }

    const bounds = map.getBounds();
    const { nodes, latStride, lonStride } = buildGrid(bounds, zoom, model, densityMult());
    lastNodes = nodes;
    lastLatStride = latStride;
    lastLonStride = lonStride;
    renderAll(); // sofort aus Cache — Fläche UND Fiedern

    return { nodes, modelKey, model, lvl };
  }

  async function fetchAndRender(nodes, modelKey, model, lvl) {
    const missing = nodes.filter(([a, b]) => !cache.has(cacheKey(a, b, lvl, modelKey)));
    if (!missing.length) {
      setStatus(`${nodes.length} Punkte (alle aus Cache)`);
      return;
    }

    abortCtrl?.abort();
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    const myGen = ++fetchGen;

    setStatus(`Lade ${missing.length} von ${nodes.length} Punkten …`);
    try {
      await fetchMissing(missing, modelKey, model, lvl, ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setStatus(`Fehler: ${e.message || e}`);
      return;
    }
    if (myGen !== fetchGen) return; // durch neueren Refresh überholt
    cacheTs = Date.now();
    if (times?.length) {
      const slider = el("mf-time-slider");
      slider.max = String(times.length - 1);
      if (timeIdx === 0) timeIdx = nearestFutureIndex(times, Date.now());
      slider.value = String(clampIdx(timeIdx));
    }
    setStatus(`${nodes.length} Punkte geladen`);
    renderAll();
  }

  const debouncedFetchAndRender = debounce(fetchAndRender, REFRESH_DEBOUNCE_MS);

  // Für gezielte Nutzeraktionen (Checkbox, Dichte, Modell-/Horizontwechsel,
  // Init): Grid sofort neu berechnen UND sofort nachladen (kein künstlicher
  // Zusatzverzug).
  function refresh() {
    const view = computeGridForCurrentView();
    if (!view) return;
    debouncedFetchAndRender.now(view.nodes, view.modelKey, view.model, view.lvl);
  }

  // Fürs Pannen/Zoomen: Grid sofort neu berechnen und aus dem Cache zeichnen
  // (s. o.), aber den eigentlichen Netzabruf debouncen, damit kontinuierliches
  // Pannen nicht bei jedem Zwischenschritt Requests auslöst.
  function refreshOnViewChange() {
    const view = computeGridForCurrentView();
    if (!view) return;
    debouncedFetchAndRender(view.nodes, view.modelKey, view.model, view.lvl);
  }

  // -- Rendering: Fiedern -------------------------------------------------------
  function collectNodeUV() {
    const map_ = new Map();
    if (!lastNodes || !times?.length) return map_;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, currentLevel, currentModel));
      if (!e) continue;
      const u = e.u[timeIdx], v = e.v[timeIdx];
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      map_.set(`${iLat},${iLon}`, [u, v]);
    }
    return map_;
  }

  function renderBarbs() {
    barbGroup.clearLayers();
    if (!settings.windLayerOn || !settings.windLayerBarbs || !lastNodes || !times?.length) return;
    const g = MODELS[currentModel].grid;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, currentLevel, currentModel));
      if (!e) continue;
      const u = e.u[timeIdx], v = e.v[timeIdx];
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const lat = iLat * g, lon = iLon * g;
      const spdMs = Math.hypot(u, v);
      const dirFrom = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
      const html = makeBarbSVG(spdMs * KT_PER_MS, dirFrom, lat, BARB_SIZE, BARB_COLOR);
      const icon = L.divIcon({
        className: "", // wichtig: sonst setzt Leaflet einen weißen Icon-Hintergrund
        html,
        iconSize: [BARB_SIZE, BARB_SIZE],
        iconAnchor: [BARB_SIZE / 2, BARB_SIZE / 2],
      });
      L.marker([lat, lon], { icon, interactive: false, pane: "wxOverlays", keyboard: false }).addTo(barbGroup);
    }
  }

  // -- Rendering: Farbfläche ------------------------------------------------------
  // Nur Größe/Position — das Zeichnen übernimmt computeGridForCurrentView()
  // via renderAll(), damit Fläche und Fiedern beim Pannen/Zoomen synchron
  // aus demselben (sofort neu berechneten) Grid gezeichnet werden.
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
    if (!settings.windLayerOn) { clearCanvas(); return; }
    const nodeUV = collectNodeUV();
    if (!nodeUV.size) { clearCanvas(); return; }

    const cellDegLat = MODELS[currentModel].grid * lastLatStride;
    const cellDegLon = MODELS[currentModel].grid * lastLonStride;
    const size = map.getSize();
    if (canvas.width !== size.x || canvas.height !== size.y) return; // resize läuft, resetCanvas übernimmt

    // Web-Mercator (unrotierte Karte) ist separabel: Länge hängt nur von x,
    // Breite nur von y ab — je Spalte/Zeile einmal statt pro Pixel berechnen.
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
        const c00 = nodeUV.get(`${uv00row},${lon0}`);
        const c10 = nodeUV.get(`${uv10row},${lon0}`);
        const c01 = nodeUV.get(`${uv00row},${lon1}`);
        const c11 = nodeUV.get(`${uv10row},${lon1}`);
        if (!c00 || !c10 || !c01 || !c11) continue; // Alpha bleibt 0 (Datenlücke)

        const u = bilin(c00[0], c10[0], c01[0], c11[0], fy, fx);
        const v = bilin(c00[1], c10[1], c01[1], c11[1], fy, fx);
        const rgb = classFor(Math.hypot(u, v)).rgb;
        fillBlock(data, size.x, size.y, px, py, PX_STEP, rgb);
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function bilin(v00, v10, v01, v11, fy, fx) {
    return v00 * (1 - fy) * (1 - fx) + v10 * fy * (1 - fx) + v01 * (1 - fy) * fx + v11 * fy * fx;
  }

  function fillBlock(data, width, height, px, py, step, rgb) {
    const maxY = Math.min(py + step, height);
    const maxX = Math.min(px + step, width);
    for (let y = py; y < maxY; y++) {
      let idx = (y * width + px) * 4;
      for (let x = px; x < maxX; x++, idx += 4) {
        data[idx] = rgb[0]; data[idx + 1] = rgb[1]; data[idx + 2] = rgb[2]; data[idx + 3] = 255;
      }
    }
  }

  function renderAll() {
    renderFill();
    renderBarbs();
    updateTimeLabel();
  }

  // -- Zeitslider -----------------------------------------------------------------
  function clampIdx(i) {
    if (!times?.length) return 0;
    return Math.min(times.length - 1, Math.max(0, i));
  }

  function setTimeIdx(i) {
    timeIdx = clampIdx(i);
    el("mf-time-slider").value = String(timeIdx);
    renderAll(); // kein Fetch — alle Stunden liegen je Punkt bereits im Cache
  }

  function updateTimeLabel() {
    if (!times?.length) { el("mf-time-display").textContent = "–"; return; }
    const d = new Date(times[timeIdx] * 1000);
    el("mf-time-display").textContent = `Gültig: ${d.toLocaleString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    })}`;
  }

  function renderDensityRadios() {
    el("ml-wind-density").innerHTML = WIND_OVERLAY_DENSITY_OPTIONS.map((d) => `
      <label>
        <input type="radio" name="ml-wind-density" value="${d.id}" />
        ${d.label}
      </label>
    `).join("");
  }

  // -- Legende / Status --------------------------------------------------------------
  function renderLegend() {
    let lastMs = 0;
    const chips = FILL_STOPS.map((s) => {
      const label = s.maxMs === Infinity
        ? `> ${Math.round(windToDisplay(lastMs))}`
        : `${Math.round(windToDisplay(lastMs))}–${Math.round(windToDisplay(s.maxMs))}`;
      lastMs = s.maxMs;
      return `<span><span class="chip" style="background:${hex(s.rgb)}"></span>${label}</span>`;
    });
    el("ml-wind-legend").innerHTML = chips.join("") + ` <span class="hint">${windUnit()}</span>`;
  }

  function setStatus(msg) {
    el("ml-wind-status").textContent = msg;
  }

  // -- UI-Verdrahtung -----------------------------------------------------------------
  // "Wind 10 m" ist der Master-Schalter (Abruf + Rendering überhaupt);
  // "Windfiedern" darunter ist nur eine Rendering-Option davon (Fiedern
  // an/aus, die Fläche bleibt unabhängig davon sichtbar). Das Untermenü mit
  // dieser und den weiteren Optionen wird nur angezeigt, solange der Master
  // an ist — sonst sähe "Windfiedern" wie ein zweiter, unabhängiger Schalter
  // aus (der ohne aktiven Master auch nichts bewirkt).
  function setWindBodyVisible(visible) {
    el("ml-wind-body").hidden = !visible;
  }

  function wireUI() {
    el("ml-wind-on").addEventListener("change", (e) => {
      updateSetting("windLayerOn", e.target.checked);
      setWindBodyVisible(e.target.checked);
      if (e.target.checked) refresh(); else removeAll();
    });
    el("ml-wind-barbs").addEventListener("change", (e) => {
      updateSetting("windLayerBarbs", e.target.checked);
      renderBarbs();
    });
    const opacity = el("ml-wind-opacity");
    opacity.addEventListener("input", (e) => {
      el("ml-wind-opacity-val").textContent = `${e.target.value}%`;
      canvas.style.opacity = String(Number(e.target.value) / 100);
    });
    opacity.addEventListener("change", (e) => updateSetting("windLayerOpacity", Number(e.target.value) / 100));

    el("mf-time-slider").addEventListener("input", (e) => setTimeIdx(Number(e.target.value)));
    el("mf-time-back").addEventListener("click", () => setTimeIdx(timeIdx - 1));
    el("mf-time-fwd").addEventListener("click", () => setTimeIdx(timeIdx + 1));

    // Dichteänderung braucht kein Cache-Clear (Level/Modell bleiben gleich —
    // nur welche Knoten angefragt/gerendert werden ändert sich), nur einen
    // erneuten refresh() mit dem neuen Grid.
    el("ml-wind-density").addEventListener("change", (e) => {
      if (e.target.name !== "ml-wind-density") return;
      updateSetting("windLayerDensity", e.target.value);
      refresh();
    });

    map.on("moveend zoomend resize", () => { resetCanvas(); refreshOnViewChange(); });
    map.on("zoomstart", clearCanvas);

    // Modell-/Horizontwechsel invalidieren den Cache. initWindOverlay läuft
    // vor initSettings() (siehe app.js), unsere Listener werden also VOR
    // app.js' eigenem updateSetting("model", …) registriert und würden bei
    // synchroner Ausführung noch das alte settings.model lesen — daher hier
    // bewusst einen Tick später (queueMicrotask) neu laden.
    el("set-model")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null; currentModel = null; currentLevel = null;
      refresh();
    }));
    el("set-days")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null;
      refresh();
    }));
    el("set-unitwind")?.addEventListener("change", () => queueMicrotask(renderLegend));
  }

  function removeAll() {
    lastNodes = null;
    barbGroup.clearLayers();
    clearCanvas();
    setStatus("");
    el("ml-wind-hint").hidden = true;
  }

  function restoreFromSettings() {
    el("ml-wind-on").checked = settings.windLayerOn;
    setWindBodyVisible(settings.windLayerOn);
    el("ml-wind-barbs").checked = settings.windLayerBarbs;
    el("ml-wind-opacity").value = String(Math.round(settings.windLayerOpacity * 100));
    el("ml-wind-opacity-val").textContent = `${Math.round(settings.windLayerOpacity * 100)}%`;
    canvas.style.opacity = String(settings.windLayerOpacity);
    const densityRadio = el("ml-wind-density").querySelector(`input[value="${settings.windLayerDensity}"]`);
    if (densityRadio) densityRadio.checked = true;
    if (settings.windLayerOn) refresh();
  }

  renderLegend();
  renderDensityRadios();
  resetCanvas(); // Canvas erst auf Kartengröße bringen, bevor restoreFromSettings ggf. lädt
  wireUI();
  restoreFromSettings();

  // Modellläufe kommen nur ~stündlich — kein 5-Min-Intervall wie Radar/Sat;
  // stattdessen prüft ein 10-Min-Tick nur, ob die TTL bereits abgelaufen ist.
  setInterval(() => {
    if (settings.windLayerOn && Date.now() - cacheTs > CACHE_TTL_MS) refresh();
  }, AUTO_CHECK_MS);
}

// -- WMO-Windfieder als Inline-SVG (portiert aus METOCViewer/windbarb_viewer.html) --
// Einfarbig dunkel mit kräftigem weißem Halo (Umriss) statt Einfärbung nach
// Geschwindigkeit: der weiße Halo liefert Kontrast über der dunklen Esri-
// Satellitenkarte, der dunkle Kern über der hellen, unruhigen OSM-Karte. Der
// Halo ist bewusst breiter als in der Ursprungsportierung, weil die
// geschwindigkeitsabhängige (teils helle) Färbung — die vorher etwas Kontrast
// mitbrachte — nun wegfällt.
function makeBarbSVG(spdKt, dirFrom, lat, size, color) {
  const side = lat < 0 ? -1 : 1; // Südhalbkugel: Fiedern spiegeln
  const halo = "#ffffff";
  const h = size / 2;
  const SHAFT = 18, BW = 10, BS = 4.5, SW = 2.0, HALO = SW + 3.5;

  if (spdKt < 2.5) {
    const c = `<circle cx="${h}" cy="${h}" r="4" fill="none" stroke="${color}" stroke-width="${SW}"/>`
      + `<circle cx="${h}" cy="${h}" r="8" fill="none" stroke="${color}" stroke-width="${SW}"/>`;
    const hc = `<circle cx="${h}" cy="${h}" r="4" fill="none" stroke="${halo}" stroke-width="${HALO}"/>`
      + `<circle cx="${h}" cy="${h}" r="8" fill="none" stroke="${halo}" stroke-width="${HALO}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${hc}${c}</svg>`;
  }

  let rem = Math.round(spdKt / 5) * 5;
  const penn = Math.floor(rem / 50); rem -= penn * 50;
  const full = Math.floor(rem / 10); rem -= full * 10;
  const half = rem >= 5 ? 1 : 0;

  function buildMarks(sc, sw) {
    let out = "", y = -SHAFT;
    for (let i = 0; i < penn; i++) {
      const y0 = y, y1 = y + BS * 2;
      out += `<polygon points="0,${y0} 0,${y1} ${side * BW},${(y0 + y1) / 2}" fill="${sc}" stroke="none"/>`;
      y += BS * 2 + 1;
    }
    for (let i = 0; i < full; i++) {
      out += `<line x1="0" y1="${y}" x2="${side * BW}" y2="${y}" stroke="${sc}" stroke-width="${sw}" stroke-linecap="round"/>`;
      y += BS;
    }
    if (half) out += `<line x1="0" y1="${y}" x2="${side * BW * 0.5}" y2="${y}" stroke="${sc}" stroke-width="${sw}" stroke-linecap="round"/>`;
    return out;
  }

  const haloG = `<circle cx="0" cy="0" r="2.5" fill="${halo}"/>`
    + `<line x1="0" y1="0" x2="0" y2="${-SHAFT}" stroke="${halo}" stroke-width="${HALO}" stroke-linecap="round"/>`
    + buildMarks(halo, HALO);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<g transform="translate(${h},${h}) rotate(${dirFrom})">`
    + haloG
    + `<circle cx="0" cy="0" r="2" fill="${color}"/>`
    + `<line x1="0" y1="0" x2="0" y2="${-SHAFT}" stroke="${color}" stroke-width="${SW}" stroke-linecap="round"/>`
    + buildMarks(color, SW)
    + `</g></svg>`;
}

// `.now(...)` feuert sofort UND storniert einen ggf. noch ausstehenden
// verzögerten Aufruf — nötig, weil gezielte Nutzeraktionen (Checkbox,
// Dichte, Modellwechsel) und das debounced Pannen/Zoomen denselben Fetch
// auslösen: ohne gemeinsamen Timer könnte ein alter, noch ausstehender
// Pan-Request nach einem sofortigen Aufruf verspätet feuern und dessen
// (aktuelleres) Ergebnis mit veralteten Daten überschreiben.
function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.now = (...args) => {
    clearTimeout(t);
    t = null;
    fn(...args);
  };
  return wrapped;
}
