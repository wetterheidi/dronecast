/**
 * Kartenlayer: Wind auf nativen Modelleveln (Boden ~10 m AGL bis maxHeight,
 * per Höhenschieber wählbar) als flächige Darstellung — WMO-Windfiedern an
 * Gitterpunkten plus interpolierte, halbtransparente Farbfläche der
 * Windgeschwindigkeit. Datenquelle wie windfield.js/column.js:
 * Michaels Instanz(en) (Modell-Level-Daten, siehe config.js `model.apiBase`),
 * hier aber gitterweise statt punktweise abgefragt — es gibt keinen eigenen
 * Gitter-/Tile-Endpunkt, nur die normale Multi-Punkt-`/v1/forecast`-API
 * (komma-getrennte lat/lon-Listen).
 *
 * Höhenschieber: Statt nur des untersten Levels wird beim Netzabruf das ganze
 * vertikale „Level-Band" vom Boden (~10 m) bis knapp über die eingestellte
 * maxHeight in EINEM Request je Gitterpunkt mitgeladen (alle Comps aller
 * Bandlevel als `hourly`-Variablen). Der Schieber wechselt danach nur den
 * gerenderten Levelindex — reines Neuzeichnen aus dem Cache, ohne neue
 * Requests (genau wie der Zeitslider). Das Band selbst (welche Level, welche
 * Höhen) wird einmal je Modell an einem Sondierpunkt bestimmt (`ensureBand`),
 * weil native ICON-Level keine feste Meterhöhe haben.
 *
 * Parameter-Deskriptor (`PARAMS`/`ACTIVE_PARAM`): Welche API-Variablen geladen
 * und wie sie eingefärbt/als Fiedern gezeichnet werden, ist in einem Deskriptor
 * gekapselt — Fetch, Cache, Rendering und Legende sind deskriptorgetrieben.
 * Höhenband, Gitter, Sondierung und Opacity sind parameter-UNABHÄNGIG. Ein
 * späterer Zusatzparameter (Temperatur, Feuchte, …) ist damit „Deskriptor +
 * `fillStops` ergänzen (+ UI-Auswahl)", ohne die Pipeline umzubauen. Vektor-
 * parameter (`barb` gesetzt) zeigen zusätzlich Fiedern; Skalarparameter nur die
 * Farbfläche. Der Cache-Key trägt die Parameter-ID, damit später mehrere
 * Parameter nebeneinander im Cache liegen können. Bislang gibt es nur `wind`
 * und noch keine UI-Auswahl — `ACTIVE_PARAM` ist konstant.
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
  MODELS,
  WIND_OVERLAY_MIN_ZOOM, WIND_OVERLAY_POINTS_PER_REQUEST,
  WIND_OVERLAY_DENSITY_OPTIONS, WIND_OVERLAY_PROBE_LEVELS,
  WIND_OVERLAY_MAX_CONCURRENCY, WIND_OVERLAY_CHUNK_RETRIES,
} from "./config.js";
import { settings, updateSetting } from "./settings.js";
import { nearestIndex } from "./weather.js";
import { subscribe as subscribeTime, getMasterMs } from "./timeController.js";
import { windToDisplay, windUnit, heightToDisplay, heightUnit } from "./units.js";
import { windBarbMarkup } from "./windbarb.js";
import {
  clampNum, firstFinite, round5, classFor, hex, bilin, fillBlock,
  buildGrid, debounce, throttle, sleep,
} from "./overlayshared.js";

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
const WIND_OVERLAY_MAX_RETRIES = 4; // Deckel für Auto-Nachladeversuche nach Teilfehlern
const CACHE_TTL_MS = 60 * 60 * 1000; // Modellläufe kommen ~stündlich neu
// LRU-Deckel: seit dem Höhenschieber liegt je Punkt das GANZE Level-Band im
// Cache (ein Eintrag pro Punkt × Level × Parameter). Der Deckel MUSS größer
// sein als das, was ein einzelner Kartenausschnitt braucht — sonst verdrängt
// das Laden der oberen Level die unteren (oder umgekehrt), und ein Höhenwechsel
// zeigt Lücken, die nie nachgeladen werden (Höhenwechsel löst bewusst keinen
// Fetch aus). Worst Case: Punktebudget (WIND_OVERLAY_MAX_POINTS) × maximale
// Bandtiefe (~WIND_OVERLAY_PROBE_LEVELS) ≈ 1500 × 30 = 45 000; plus Reserve,
// damit Pannen nicht sofort die anderen Level des aktuellen Ausschnitts räumt.
const CACHE_MAX = 60000;
const FILL_ZINDEX = 30; // im wxOverlays-Pane: über Radar(20)/Sat(10), unter den Fiedern
const PX_STEP = 2; // Canvas-Raster: je 2×2-px-Block einmal berechnet
const AUTO_CHECK_MS = 10 * 60 * 1000;

// Farbklassen der Fläche (und, konsistent, der Fiedern) — intern m/s, an
// typischen Drohnen-Limits orientiert (vgl. droneProfiles.js: windSurface
// max. 10 m/s, windBandMax 12 m/s, gustSurface 15 m/s). Bewusst statisch
// statt ans gewählte Profil gekoppelt (Profile sind austauschbare Platzhalter).
// Exportiert: von windspinne.js für dieselbe Windfarbcodierung wiederverwendet
// (konsistente Windfarbe app-weit statt einer zweiten, abweichenden Skala).
export const WIND_FILL_STOPS = [
  { max: 2, rgb: [110, 170, 235] },
  { max: 4, rgb: [120, 200, 160] },
  { max: 6, rgb: [160, 210, 100] },
  { max: 8, rgb: [235, 210, 80] },
  { max: 10, rgb: [240, 150, 60] }, // typ. Bodenwind-Limit
  { max: 12, rgb: [225, 70, 60] }, // typ. Bandmax-Limit
  { max: Infinity, rgb: [150, 40, 160] },
];

// -- Parameter-Deskriptoren ---------------------------------------------------
// Ein Eintrag beschreibt einen flächig darstellbaren Modellparameter vollständig:
//   comps         Komponenten, die je Level geladen werden (API-Variable +
//                 Umrechnung roh→native Einheit: factor, optional offset).
//   scalar(c)     Wert der Farbfläche aus einem Sample c = {compName: Wert}.
//   barb(c)|null  Fiederndaten {spdKt, dirFrom} für Vektorparameter; null = keine
//                 Fiedern (Skalarparameter zeigen nur die Farbfläche).
//   fillStops     Farbklassen (native Einheit), legendDisplay/legendUnit für die
//                 Legende (native Einheit → Anzeige).
// Höhenband, Gitter, Sondierung und Opacity sind hiervon unabhängig.
const PARAMS = {
  wind: {
    id: "wind",
    label: "Wind",
    kind: "vector",
    comps: [
      { name: "u", varFor: (l) => `wind_u_component_level${l}`, factor: KMH_TO_MS },
      { name: "v", varFor: (l) => `wind_v_component_level${l}`, factor: KMH_TO_MS },
    ],
    scalar: (c) => Math.hypot(c.u, c.v),
    barb: (c) => ({
      spdKt: Math.hypot(c.u, c.v) * KT_PER_MS,
      dirFrom: (Math.atan2(-c.u, -c.v) * 180 / Math.PI + 360) % 360,
    }),
    fillStops: WIND_FILL_STOPS,
    legendDisplay: windToDisplay,
    legendUnit: windUnit,
  },
  // Später z. B. (nur zur Illustration der Erweiterung — noch nicht aktiv):
  // temperature: {
  //   id: "temperature", label: "Temperatur", kind: "scalar",
  //   comps: [{ name: "t", varFor: (l) => `temperature_level${l}`, factor: 1 }],
  //   scalar: (c) => c.t, barb: null,
  //   fillStops: TEMP_STOPS, legendDisplay: tempToDisplay, legendUnit: tempUnit,
  // },
};
// Aktiver Parameter — noch ohne UI-Auswahl konstant „Wind". Später aus einem
// Setting (z. B. settings.windLayerParam) gewählt.
const ACTIVE_PARAM = PARAMS.wind;

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

  const cache = new Map(); // key "iLat,iLon,level,param,model" -> {comps: {name: Float32Array}} (native Einheit)
  let times = null; // Unix-Sekunden (stündlich), gemeinsam für alle Cache-Einträge
  let timeIdx = 0;
  let heightIdx = clampNum(settings.windLayerHeightIdx | 0, 0, 999); // Index ins Level-Band (0 = Boden)
  let cacheTs = 0;
  let currentModel = null;
  let currentBand = null; // { levels: [nLevels, …], heights: [~m AGL, …] }, levels[0] = Boden
  let bandKey = null; // "modelKey,maxHeight" — für welche Kombination currentBand gilt
  let lastNodes = null; // [[iLat,iLon], …] des letzten Grids
  let lastLatStride = 1;
  let lastLonStride = 1;
  let abortCtrl = null;
  let fetchGen = 0;

  const bandKeyFor = (modelKey) => `${modelKey},${settings.maxHeight}`;

  // -- Grid-Geometrie ---------------------------------------------------------
  function densityMult() {
    const opt = WIND_OVERLAY_DENSITY_OPTIONS.find((d) => d.id === settings.windLayerDensity);
    return (opt || WIND_OVERLAY_DENSITY_OPTIONS[0]).mult;
  }

  // Gittergeometrie (km-basiert, budgetbegrenzt, Dichte-Vielfaches) in
  // overlayshared.js — geteilt mit dem Böen-Layer.

  // -- Cache (LRU) --------------------------------------------------------------
  function cacheKey(iLat, iLon, lvl, paramId, modelKey) {
    return `${iLat},${iLon},${lvl},${paramId},${modelKey}`;
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
  // Lädt je Punkt das GESAMTE Level-Band des aktiven Parameters in einem
  // Request (alle Comps × alle Bandlevel als `hourly`-Variablen). Danach ist
  // das Verschieben des Höhenschiebers reines Neuzeichnen aus dem Cache.
  async function fetchChunk(chunk, modelKey, model, band, param, signal) {
    // Wie column.js/weather.js: `forecast_days` statt start_date/end_date —
    // letzteres würde bei kalendertag-basierter Rundung leicht über den
    // gewünschten Horizont hinausgreifen (unnötig viele Datenlücken-Stunden
    // am Ende des Sliders, sobald der Modelllauf dort nicht mehr reicht).
    const hourlyVars = [];
    for (const lvl of band.levels) {
      for (const c of param.comps) hourlyVars.push(c.varFor(lvl));
    }
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
        for (const c of param.comps) {
          const src = h[c.varFor(lvl)] || [];
          const off = c.offset || 0;
          const a = new Float32Array(T);
          for (let t = 0; t < T; t++) a[t] = src[t] == null ? NaN : src[t] * c.factor + off;
          comps[c.name] = a;
        }
        cacheSet(cacheKey(iLat, iLon, lvl, param.id, modelKey), { comps });
      }
    });
  }

  async function fetchChunkWithRetry(chunk, modelKey, model, band, param, signal) {
    let lastErr;
    for (let attempt = 0; attempt <= WIND_OVERLAY_CHUNK_RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      try {
        await fetchChunk(chunk, modelKey, model, band, param, signal);
        return;
      } catch (e) {
        if (signal.aborted) throw e;
        lastErr = e;
        if (attempt < WIND_OVERLAY_CHUNK_RETRIES) await sleep(250 * (attempt + 1), signal);
      }
    }
    throw lastErr;
  }

  // Lädt die fehlenden Knoten in Chunks über einen Worker-Pool mit begrenzter
  // Parallelität. Jeder fertige Chunk ruft onChunk() (progressives Rendern +
  // Fortschritt). Fehlgeschlagene Chunks werden gezählt statt den ganzen
  // Refresh abzubrechen — so bleiben erfolgreiche Chunks sichtbar, und ein
  // Auto-Retry (fetchAndRender) holt nur die noch fehlenden nach.
  async function fetchMissing(nodes, modelKey, model, band, param, signal, onChunk) {
    const chunks = [];
    for (let i = 0; i < nodes.length; i += WIND_OVERLAY_POINTS_PER_REQUEST) {
      chunks.push(nodes.slice(i, i + WIND_OVERLAY_POINTS_PER_REQUEST));
    }
    let next = 0;
    let done = 0;
    let failed = 0;
    async function worker() {
      while (!signal.aborted) {
        const i = next++;
        if (i >= chunks.length) return;
        try {
          await fetchChunkWithRetry(chunks[i], modelKey, model, band, param, signal);
          done++;
        } catch (e) {
          if (signal.aborted) return;
          failed++;
        }
        onChunk?.(done, failed, chunks.length);
      }
    }
    const n = Math.min(WIND_OVERLAY_MAX_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: n }, worker));
    return { done, failed, total: chunks.length };
  }

  // Ein Knoten „fehlt", solange nicht ALLE Bandlevel des aktiven Parameters im
  // Cache liegen (nach einer maxHeight-Erhöhung kann ein Teil schon da sein).
  function missingNodes(nodes, band, param, modelKey) {
    return nodes.filter(([a, b]) =>
      !band.levels.every((l) => cache.has(cacheKey(a, b, l, param.id, modelKey))));
  }

  // -- Level-Band --------------------------------------------------------------
  // Bestimmt einmal je Modell+maxHeight das vertikale Band nativer Level vom
  // Boden (~10 m) bis knapp über maxHeight, samt zugehöriger ~Höhen (für die
  // Slider-Beschriftung). Native ICON-Level haben keine feste Meterhöhe, daher
  // eine Sondierabfrage von `height_agl_level{l}` an der Kartenmitte (wie
  // windfield.js). Ergebnis in currentBand/bandKey gecacht.
  async function ensureBand(modelKey, model, signal) {
    const key = bandKeyFor(modelKey);
    if (bandKey === key && currentBand) return currentBand;
    const c = map.getCenter();
    const lat = clampNum(c.lat, model.bbox.latMin, model.bbox.latMax);
    const lon = clampNum(c.lng, model.bbox.lonMin, model.bbox.lonMax);
    const n = model.nLevels;
    const probeLevels = [];
    for (let l = n; l > Math.max(1, n - WIND_OVERLAY_PROBE_LEVELS); l--) probeLevels.push(l);
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
      // Erstes Level, das maxHeight erreicht/überschreitet, ist die Bandgrenze
      // (inklusiv — so reicht der Schieber genau bis über die eingestellte Höhe).
      if (hl != null && hl >= settings.maxHeight) break;
    }
    currentBand = { levels, heights };
    bandKey = key;
    return currentBand;
  }

  // -- Refresh (Zoom-/Bounds-/Modellwechsel) -------------------------------------
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

    if (cacheTs && Date.now() - cacheTs > CACHE_TTL_MS) {
      cache.clear();
      times = null;
      currentBand = null;
      bandKey = null;
    }
    if (currentModel !== modelKey) {
      cache.clear();
      times = null;
      currentBand = null;
      bandKey = null;
      currentModel = modelKey;
    }

    const bounds = map.getBounds();
    const { nodes, latStride, lonStride } = buildGrid(bounds, zoom, model, densityMult());
    lastNodes = nodes;
    lastLatStride = latStride;
    lastLonStride = lonStride;
    renderAll(); // sofort aus Cache — Fläche UND Fiedern

    return { nodes, modelKey, model };
  }

  async function fetchAndRender(nodes, modelKey, model) {
    const param = ACTIVE_PARAM;
    // Schnellpfad: Band schon bekannt und alle Knoten im Cache → nur zeichnen,
    // ohne einen ggf. laufenden Fetch abzubrechen (wie zuvor beim reinen
    // Cache-Treffer). Der Höhenschieber selbst löst hierüber nie einen Fetch aus.
    let band = (bandKey === bandKeyFor(modelKey) && currentBand) ? currentBand : null;
    if (band && !missingNodes(nodes, band, param, modelKey).length) {
      syncHeightSlider();
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
      if (myGen !== fetchGen) return; // durch neueren Refresh überholt
      syncHeightSlider();
      renderAll(); // Band bekannt → aus Cache zeichnen (falls schon Daten da)
    }

    const missing = missingNodes(nodes, band, param, modelKey);
    if (!missing.length) {
      setStatus(`${nodes.length} Punkte (alle aus Cache)`);
      renderAll();
      return;
    }

    // Progressiv rendern: jeder fertige Chunk zeichnet (throttled) den Cache neu,
    // damit sich die Fläche/Fiedern sichtbar auffüllen statt erst am Ende.
    const throttledRender = throttle(renderAll, 150);
    setStatus(`Lade 0/${missing.length} Punkte …`, true);
    let result;
    try {
      result = await fetchMissing(missing, modelKey, model, band, param, ctrl.signal, (done, failed, total) => {
        if (myGen !== fetchGen) return;
        const loaded = Math.min(done * WIND_OVERLAY_POINTS_PER_REQUEST, missing.length);
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
    if (times?.length) {
      // An die Masterzeit koppeln: nächste verfügbare Modellstunde.
      timeIdx = nearestIndex(times, getMasterMs());
    }
    renderAll();
    if (result.failed) {
      // Ein Teil fehlt trotz Retry — Lücken bleiben, automatisch nachladen.
      setStatus(`${result.failed} von ${result.total} Blöcken fehlgeschlagen – erneuter Versuch …`, true);
      scheduleRetry();
    } else {
      retryCount = 0;
      setStatus(`${nodes.length} Punkte geladen`);
    }
  }

  // Nach Teilfehlern automatisch nachladen (nur die noch fehlenden Knoten, da
  // fetchAndRender über missingNodes filtert). Begrenzte Anzahl mit Backoff,
  // damit ein dauerhaft nicht erreichbarer Server keine Endlosschleife erzeugt.
  // Der Zähler wird bei vollem Erfolg und bei jedem echten View-Wechsel (neues
  // Grid) zurückgesetzt.
  let retryCount = 0;
  let retryTimer = null;
  function scheduleRetry() {
    if (!settings.windLayerOn || retryCount >= WIND_OVERLAY_MAX_RETRIES) return;
    clearTimeout(retryTimer);
    retryCount++;
    retryTimer = setTimeout(() => {
      if (settings.windLayerOn) refresh();
    }, 1500 * retryCount);
  }

  const debouncedFetchAndRender = debounce(fetchAndRender, REFRESH_DEBOUNCE_MS);

  // Für gezielte Nutzeraktionen (Checkbox, Dichte, Modell-/Horizontwechsel,
  // Init): Grid sofort neu berechnen UND sofort nachladen (kein künstlicher
  // Zusatzverzug).
  function refresh() {
    const view = computeGridForCurrentView();
    if (!view) return;
    debouncedFetchAndRender.now(view.nodes, view.modelKey, view.model);
  }

  // Fürs Pannen/Zoomen: Grid sofort neu berechnen und aus dem Cache zeichnen
  // (s. o.), aber den eigentlichen Netzabruf debouncen, damit kontinuierliches
  // Pannen nicht bei jedem Zwischenschritt Requests auslöst.
  function refreshOnViewChange() {
    const view = computeGridForCurrentView();
    if (!view) return;
    // Neue Nutzerabsicht (Pannen/Zoomen) → frisches Retry-Budget. Die Retries
    // selbst laufen über refresh() und setzen den Zähler NICHT zurück, sonst
    // gäbe es bei dauerhaftem Serverfehler eine Endlosschleife.
    retryCount = 0;
    debouncedFetchAndRender(view.nodes, view.modelKey, view.model);
  }

  // -- Rendering: Sampling ------------------------------------------------------
  // Aktuell gewähltes Level (aus Höhenschieber-Index ins Band).
  function activeLevel() {
    if (!currentBand || !currentBand.levels.length) return null;
    return currentBand.levels[clampNum(heightIdx, 0, currentBand.levels.length - 1)];
  }

  // Sample aller Comps des Parameters an der aktuellen Stunde; null bei Lücke.
  function sampleComps(entry, param) {
    const c = {};
    for (const comp of param.comps) {
      const v = entry.comps[comp.name]?.[timeIdx];
      if (!Number.isFinite(v)) return null;
      c[comp.name] = v;
    }
    return c;
  }

  function collectSamples() {
    const out = new Map();
    const lvl = activeLevel();
    if (!lastNodes || !times?.length || lvl == null) return out;
    const param = ACTIVE_PARAM;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, lvl, param.id, currentModel));
      if (!e) continue;
      const c = sampleComps(e, param);
      if (c) out.set(`${iLat},${iLon}`, c);
    }
    return out;
  }

  // -- Rendering: Fiedern -------------------------------------------------------
  // Nur für Vektorparameter (param.barb gesetzt); Skalarparameter überspringen.
  function renderBarbs() {
    barbGroup.clearLayers();
    const param = ACTIVE_PARAM;
    const lvl = activeLevel();
    if (!settings.windLayerOn || !settings.windLayerBarbs || !param.barb
        || !lastNodes || !times?.length || lvl == null) return;
    const g = MODELS[currentModel].grid;
    for (const [iLat, iLon] of lastNodes) {
      const e = cacheGet(cacheKey(iLat, iLon, lvl, param.id, currentModel));
      if (!e) continue;
      const c = sampleComps(e, param);
      if (!c) continue;
      const lat = iLat * g, lon = iLon * g;
      const { spdKt, dirFrom } = param.barb(c);
      const html = makeBarbSVG(spdKt, dirFrom, lat, BARB_SIZE, BARB_COLOR);
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
    const param = ACTIVE_PARAM;
    const nodeSamples = collectSamples();
    if (!nodeSamples.size) { clearCanvas(); return; }

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
        const c00 = nodeSamples.get(`${uv00row},${lon0}`);
        const c10 = nodeSamples.get(`${uv10row},${lon0}`);
        const c01 = nodeSamples.get(`${uv00row},${lon1}`);
        const c11 = nodeSamples.get(`${uv10row},${lon1}`);
        if (!c00 || !c10 || !c01 || !c11) continue; // Alpha bleibt 0 (Datenlücke)

        // Jede Comp einzeln bilinear interpolieren, dann parameterspezifisch
        // zum Skalarwert der Farbfläche verrechnen (Wind: Betrag aus u,v).
        const interp = {};
        for (const comp of param.comps) {
          interp[comp.name] = bilin(c00[comp.name], c10[comp.name], c01[comp.name], c11[comp.name], fy, fx);
        }
        const rgb = classFor(param.scalar(interp), param.fillStops).rgb;
        fillBlock(data, size.x, size.y, px, py, PX_STEP, rgb);
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function renderAll() {
    renderFill();
    renderBarbs();
    updateTimeLabel();
    updateHeightLabel();
  }

  // -- Höhenschieber ---------------------------------------------------------------
  // Slider-Bereich/Beschriftung an das aktuelle Level-Band angleichen und
  // heightIdx auf gültigen Bereich klemmen (Band kann durch Modell-/maxHeight-
  // Wechsel kürzer werden).
  function syncHeightSlider() {
    const slider = el("ml-wind-height");
    if (!currentBand || !currentBand.levels.length) { slider.max = "0"; return; }
    heightIdx = clampNum(heightIdx, 0, currentBand.levels.length - 1);
    slider.max = String(currentBand.levels.length - 1);
    slider.value = String(heightIdx);
    updateHeightLabel();
  }

  function updateHeightLabel() {
    const disp = el("ml-wind-height-display");
    if (!currentBand || !currentBand.levels.length) { disp.textContent = "–"; return; }
    const h = currentBand.heights[clampNum(heightIdx, 0, currentBand.heights.length - 1)];
    disp.textContent = h == null ? "–" : `~${Math.round(heightToDisplay(h))} ${heightUnit()} AGL`;
  }

  // Zeichnen beim Ziehen drosseln: Label/Slider-Wert laufen sofort mit (billig),
  // aber renderAll (Vollbild-Canvas + Neuaufbau aller Fieder-Marker) höchstens
  // alle 100 ms, sonst ruckelt kontinuierliches Ziehen bei vielen Fiedern.
  const throttledHeightRender = throttle(renderAll, 100);

  // Kein Fetch — das gesamte Band liegt je Punkt bereits im Cache, also nur neu
  // zeichnen. `persist` (diskrete Aktion) speichert die Höhe; `immediate` false
  // beim Ziehen (input) drosselt das Zeichnen.
  function setHeightIdx(i, { persist = false, immediate = true } = {}) {
    if (!currentBand || !currentBand.levels.length) return;
    heightIdx = clampNum(i, 0, currentBand.levels.length - 1);
    el("ml-wind-height").value = String(heightIdx);
    updateHeightLabel();
    if (persist) updateSetting("windLayerHeightIdx", heightIdx);
    if (immediate) renderAll(); else throttledHeightRender();
  }

  // -- Zeit (an die Masterzeit gekoppelt) -----------------------------------------
  // Nächste verfügbare Modellstunde zur Masterzeit wählen und neu zeichnen. Kein
  // Fetch — alle Stunden liegen je Punkt bereits im Cache. Beim kontinuierlichen
  // Ziehen des Zeitreglers (committed=false) wird der Vollbild-Canvas gedrosselt,
  // beim Loslassen/Buttons (committed=true) sofort gezeichnet.
  const throttledTimeRender = throttle(renderAll, 100);
  function syncToMasterTime(committed = true) {
    if (!times?.length) { updateTimeLabel(); return; }
    timeIdx = nearestIndex(times, getMasterMs());
    if (!settings.windLayerOn) { updateTimeLabel(); return; }
    if (committed) renderAll(); else throttledTimeRender();
  }

  function updateTimeLabel() {
    if (!times?.length) { el("mf-time-display").textContent = "–"; return; }
    const d = new Date(times[timeIdx] * 1000);
    el("mf-time-display").textContent = `Gültig: ${d.toLocaleString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    })} loc`;
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
  // Deskriptorgetrieben: Farbklassen und Einheiten kommen aus dem aktiven
  // Parameter (fillStops in nativer Einheit → legendDisplay/legendUnit).
  function renderLegend() {
    const param = ACTIVE_PARAM;
    let last = 0;
    const chips = param.fillStops.map((s) => {
      const label = s.max === Infinity
        ? `> ${Math.round(param.legendDisplay(last))}`
        : `${Math.round(param.legendDisplay(last))}–${Math.round(param.legendDisplay(s.max))}`;
      last = s.max;
      return `<span><span class="chip" style="background:${hex(s.rgb)}"></span>${label}</span>`;
    });
    el("ml-wind-legend").innerHTML = chips.join("") + ` <span class="hint">${param.legendUnit()}</span>`;
  }

  function setStatus(msg, busy) {
    const s = el("ml-wind-status");
    s.textContent = msg;
    s.classList.toggle("busy", !!busy);
  }

  // -- UI-Verdrahtung -----------------------------------------------------------------
  // "Wind (Modelllevel)" ist der Master-Schalter (Abruf + Rendering überhaupt);
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

    // Zeit kommt zentral von der Masterzeit — kein eigener Slider mehr.
    subscribeTime((ms, committed) => syncToMasterTime(committed));

    // Höhenschieber: flüssiges Neuzeichnen beim Ziehen (input, ohne persist),
    // Speichern bei diskreten Aktionen (change, Buttons). Löst nie einen Fetch
    // aus — das ganze Band liegt bereits im Cache.
    el("ml-wind-height").addEventListener("input", (e) => setHeightIdx(Number(e.target.value), { immediate: false }));
    el("ml-wind-height").addEventListener("change", () => setHeightIdx(heightIdx, { persist: true }));
    el("ml-wind-height-down").addEventListener("click", () => setHeightIdx(heightIdx - 1, { persist: true }));
    el("ml-wind-height-up").addEventListener("click", () => setHeightIdx(heightIdx + 1, { persist: true }));

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
      cache.clear(); times = null; currentModel = null; currentBand = null; bandKey = null;
      refresh();
    }));
    el("set-days")?.addEventListener("change", () => queueMicrotask(() => {
      cache.clear(); times = null;
      refresh();
    }));
    // maxHeight bestimmt die Bandtiefe. Kein Cache-Clear nötig (Level/Parameter
    // je Punkt bleiben gültig, Cache-Key trägt das Level) — nur das Band neu
    // bestimmen (bandKey enthält maxHeight, ensureBand baut es dann neu) und die
    // ggf. neuen (tieferen) Level nachladen. refresh() erledigt beides.
    el("set-maxheight")?.addEventListener("change", () => queueMicrotask(() => {
      bandKey = null;
      refresh();
    }));
    el("set-unitwind")?.addEventListener("change", () => queueMicrotask(renderLegend));
    // Höhen-Einheit (m/ft) betrifft nur die Slider-Beschriftung.
    el("set-unitheight")?.addEventListener("change", () => queueMicrotask(updateHeightLabel));
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
    // Höhenschieber-Anfangszustand: Bereich/Beschriftung setzt syncHeightSlider,
    // sobald das Band nach dem ersten Fetch bekannt ist; bis dahin nur der Wert.
    el("ml-wind-height").value = String(heightIdx);
    updateHeightLabel();
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

  // Punktabfrage für die Cursor-Statuszeile (app.js): dieselbe bilineare
  // Interpolation wie renderFill(), aber für eine einzelne Koordinate statt
  // fürs ganze Canvas-Raster — direkte Cache-Lookups der 4 umschließenden
  // Knoten statt des vollen nodeSamples-Map-Aufbaus aus collectSamples().
  function valueAt(lat, lon) {
    if (!settings.windLayerOn || !lastNodes || !times?.length) return null;
    const model = MODELS[currentModel];
    const lvl = activeLevel();
    if (!model || lvl == null) return null;
    const param = ACTIVE_PARAM;
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
    const e00 = cacheGet(cacheKey(uv00row, lon0, lvl, param.id, currentModel));
    const e10 = cacheGet(cacheKey(uv10row, lon0, lvl, param.id, currentModel));
    const e01 = cacheGet(cacheKey(uv00row, lon1, lvl, param.id, currentModel));
    const e11 = cacheGet(cacheKey(uv10row, lon1, lvl, param.id, currentModel));
    if (!e00 || !e10 || !e01 || !e11) return null;
    const c00 = sampleComps(e00, param), c10 = sampleComps(e10, param);
    const c01 = sampleComps(e01, param), c11 = sampleComps(e11, param);
    if (!c00 || !c10 || !c01 || !c11) return null;
    const interp = {};
    for (const comp of param.comps) {
      interp[comp.name] = bilin(c00[comp.name], c10[comp.name], c01[comp.name], c11[comp.name], fy, fx);
    }
    return { speedMs: param.scalar(interp), dirDeg: param.barb ? param.barb(interp).dirFrom : null };
  }

  return { valueAt };
}

// -- WMO-Windfieder als Inline-SVG (Geometrie aus windbarb.js, gemeinsam mit
// Meteogramm/Cross-Section) --
// Einfarbig dunkel mit kräftigem weißem Halo (Umriss) statt Einfärbung nach
// Geschwindigkeit: der weiße Halo liefert Kontrast über der dunklen Esri-
// Satellitenkarte, der dunkle Kern über der hellen, unruhigen OSM-Karte.
function makeBarbSVG(spdKt, dirFrom, lat, size, color) {
  const side = lat < 0 ? -1 : 1; // Südhalbkugel: Fiedern spiegeln
  const h = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<g transform="translate(${h},${h})">${windBarbMarkup(spdKt, dirFrom, { size, side, color })}</g>`
    + `</svg>`;
}
