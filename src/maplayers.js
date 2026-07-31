/**
 * Kartenlayer: Niederschlagsradar (RainViewer) + Satellit (EUMETSAT/
 * EUMETView-WMS). Beide Quellen sind CORS-offen, kein eigener Proxy nötig.
 * Ursprünglich aus METEOMAP (meteomap_52.html) portiert (DWD-WMS für
 * Satellit), dann auf EUMETSAT umgestellt: DWD aktualisiert nur alle 3 Std.
 * und hat keine WMS-Zeitdimension, EUMETSAT liefert alle 10–15 Min. mit nur
 * ca. 20–30 Min. Verzug und eine echte Zeitdimension — dadurch steuert die
 * gemeinsame ±15-Min-Zeitleiste jetzt BEIDE Layer (nicht nur das Radar).
 *
 * Für Satellit gibt es keinen Weg, den tatsächlichen Aufnahmezeitpunkt aus
 * der Bild-Response selbst auszulesen: GeoServer meldet ihn zwar im
 * `Warning`-Header ("99 Nearest value used: time=…"), aber der Browser
 * blockiert den Zugriff darauf per CORS (Server setzt kein
 * `Access-Control-Expose-Headers: Warning`, geprüft). Stattdessen wird
 * einmalig (gecacht) GetCapabilities geladen und daraus je Produkt
 * Start/Ende/Rasterschritt der Zeitdimension gelesen (`getSatExtents`) —
 * damit lässt sich der tatsächlich angezeigte Zeitpunkt clientseitig
 * exakt vorausberechnen, inkl. korrekter Anzeige.
 *
 * Eigener Leaflet-Pane ("wxOverlays", zIndex 350) zwischen tilePane (200,
 * Basiskarten) und overlayPane (400, u. a. die Esri-Hybrid-Grenzlinien
 * sowie Geomans Zeichnungen) — Wetter-Layer liegen so über allen
 * Basiskarten, aber unter Beschriftungen/gezeichneten Objekten. Zugleich
 * der Andockpunkt für künftige NWP-Layer (siehe IDEEN.md).
 */

import {
  RAINVIEWER_API, RAINVIEWER_META_TTL_MS, RAINVIEWER_COLOR_SCHEME,
  EUMETSAT_WMS_BASE, EUMETSAT_CAPS_URL, EUMETSAT_CAPS_TTL_MS, SAT_PRODUCTS,
} from "./config.js";
import { settings, updateSetting } from "./settings.js";
import { subscribe as subscribeTime, getMasterMs, isNow } from "./timeController.js";

/* global L */

const el = (id) => document.getElementById(id);

const AUTO_REFRESH_MS = 5 * 60 * 1000;

export function initMapLayers(map) {
  const pane = map.createPane("wxOverlays");
  pane.style.zIndex = 350;
  pane.style.pointerEvents = "none";

  let rvMeta = null;
  let rvMetaTs = 0;
  let satExtents = null;
  let satExtentsTs = 0;
  let radarLayer = null;
  let satLayer = null;

  // Abspielen-Schleife (Nowcasting): läuft unabhängig von der Masterzeit über
  // die letzten Radar-Frames und stellt beim Stoppen wieder den Masterzeit-Frame
  // her. Verstellt die Masterzeit bewusst NICHT.
  let playing = false;
  let playTimer = null;
  let playMeta = null;
  let playFrames = null;
  let playPos = 0;

  function fmtLocalTimestamp(d) {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}.${mm}.${yy} ${hh}:${mi}`;
  }

  // -- RainViewer-Metadaten (gecacht) --------------------------------------
  async function getRVMeta() {
    if (rvMeta && Date.now() - rvMetaTs < RAINVIEWER_META_TTL_MS) return rvMeta;
    const r = await fetch(RAINVIEWER_API, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    rvMeta = await r.json();
    rvMetaTs = Date.now();
    return rvMeta;
  }

  function rvClosest(frames, targetSec) {
    if (!frames || frames.length === 0) return null;
    return frames.reduce((best, f) =>
      Math.abs(f.time - targetSec) < Math.abs(best.time - targetSec) ? f : best);
  }

  // -- Radar (RainViewer) ---------------------------------------------------
  // Einen konkreten Frame anzeigen (gemeinsam von Masterzeit-Refresh und der
  // Abspielen-Schleife genutzt). Nur neu erzeugen, wenn sich der Frame wirklich
  // geändert hat (spart Kachel-Requests bei ungenutzten Ticks).
  function setRadarFrame(meta, frame) {
    if (radarLayer && radarLayer._frameTime === frame.time) {
      radarLayer.setOpacity(settings.radarLayerOpacity);
    } else {
      if (radarLayer) map.removeLayer(radarLayer);
      const tileUrl = `${meta.host}${frame.path}/256/{z}/{x}/{y}/${RAINVIEWER_COLOR_SCHEME}/1_1.png`;
      radarLayer = L.tileLayer(tileUrl, {
        opacity: settings.radarLayerOpacity,
        attribution: 'Radar: <a href="https://rainviewer.com" target="_blank">RainViewer</a>',
        pane: "wxOverlays",
        zIndex: 20,
        tileSize: 256,
        maxNativeZoom: 7,
        maxZoom: 19,
        transparent: true,
      });
      radarLayer._frameTime = frame.time;
      radarLayer.addTo(map);
    }
    const isNowcast = (meta.radar.nowcast || []).some((f) => f.time === frame.time);
    const frameTxt = fmtLocalTimestamp(new Date(frame.time * 1000));
    el("ml-radar-time").textContent = `Angezeigt: ${frameTxt}${isNowcast ? " ▶ Nowcast" : ""}`;
  }

  async function refreshRadar() {
    if (!settings.radarLayerOn || playing) return; // während des Abspielens steuert die Schleife
    let meta;
    try {
      meta = await getRVMeta();
    } catch {
      el("ml-radar-time").textContent = "Radar: Metadaten nicht erreichbar";
      return;
    }
    const targetSec = Math.round(getMasterMs() / 1000);
    const allFrames = [...(meta.radar.past || []), ...(meta.radar.nowcast || [])];
    const frame = rvClosest(allFrames, targetSec);
    if (!frame) return;
    setRadarFrame(meta, frame);
  }

  // -- Abspielen-Schleife (Nowcasting) --------------------------------------
  const PLAY_STEP_MS = 450;   // Zeit je Frame
  const PLAY_LOOP_PAUSE_MS = 1100; // längere Pause am aktuellsten Frame

  async function startPlay() {
    let meta;
    try {
      meta = await getRVMeta();
    } catch {
      el("ml-play-status").textContent = "Radar nicht erreichbar";
      return;
    }
    const frames = [...(meta.radar.past || []), ...(meta.radar.nowcast || [])];
    if (!frames.length) { el("ml-play-status").textContent = "keine Frames"; return; }

    // Radar sichtbar machen, falls aus — sonst liefe die Schleife unsichtbar.
    if (!settings.radarLayerOn) {
      updateSetting("radarLayerOn", true);
      el("ml-radar-on").checked = true;
    }

    playMeta = meta;
    playFrames = frames;
    playPos = 0;
    playing = true;
    el("ml-play").classList.add("playing");
    el("ml-play").textContent = "⏸ Stopp";
    playStep();
  }

  function playStep() {
    if (!playing || !playFrames) return;
    const frame = playFrames[playPos];
    setRadarFrame(playMeta, frame);
    const isNowcast = (playMeta.radar.nowcast || []).some((f) => f.time === frame.time);
    el("ml-play-status").textContent =
      `${fmtLocalTimestamp(new Date(frame.time * 1000))}${isNowcast ? " ▶" : ""}`;
    const atEnd = playPos === playFrames.length - 1;
    playPos = atEnd ? 0 : playPos + 1;
    playTimer = setTimeout(playStep, atEnd ? PLAY_LOOP_PAUSE_MS : PLAY_STEP_MS);
  }

  function stopPlay() {
    playing = false;
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    el("ml-play").classList.remove("playing");
    el("ml-play").textContent = "▶ Abspielen";
    el("ml-play-status").textContent = "";
    refreshRadar(); // zurück zum Masterzeit-Frame
  }

  function togglePlay() {
    if (playing) stopPlay(); else startPlay();
  }

  function removeRadar() {
    if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; }
    el("ml-radar-time").textContent = "";
  }

  // -- Satellit (EUMETSAT-WMS) ------------------------------------------------
  function parseISODuration(s) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s || "");
    if (!m) return null;
    const h = Number(m[1] || 0), mi = Number(m[2] || 0), se = Number(m[3] || 0);
    return ((h * 60 + mi) * 60 + se) * 1000;
  }

  function directChild(node, tagName) {
    for (const child of node.children) {
      if (child.tagName === tagName) return child;
    }
    return null;
  }

  // Nur die uns interessierenden Produkte aus der (recht großen) Capabilities-
  // Antwort herauslesen: Start/Ende/Rasterschritt der Zeitdimension je Layer.
  function parseSatExtents(xmlText, productIds) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const extents = {};
    for (const layer of doc.getElementsByTagName("Layer")) {
      const nameEl = directChild(layer, "Name");
      if (!nameEl || !productIds.includes(nameEl.textContent)) continue;
      const dims = Array.from(layer.children).filter((c) => c.tagName === "Dimension");
      const dimEl = dims.find((d) => d.getAttribute("name") === "time");
      if (!dimEl) continue;
      const [startStr, endStr, stepStr] = dimEl.textContent.trim().split("/");
      const startMs = Date.parse(startStr), endMs = Date.parse(endStr), stepMs = parseISODuration(stepStr);
      if (!startMs || !endMs || !stepMs) continue;
      extents[nameEl.textContent] = { startMs, endMs, stepMs };
    }
    return extents;
  }

  async function getSatExtents() {
    if (satExtents && Date.now() - satExtentsTs < EUMETSAT_CAPS_TTL_MS) return satExtents;
    const r = await fetch(EUMETSAT_CAPS_URL, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    satExtents = parseSatExtents(await r.text(), SAT_PRODUCTS.map((p) => p.id));
    satExtentsTs = Date.now();
    return satExtents;
  }

  // Zielzeitpunkt auf das reguläre Zeitraster des Produkts runden und in den
  // verfügbaren Bereich klemmen (die WMS-eigene nearestValue-Snapping-Logik
  // greift serverseitig ohnehin, das hier nur für eine korrekte Anzeige).
  function resolveSatTime(extents, productId, targetMs) {
    const ext = extents[productId];
    if (!ext) return null;
    const clamped = Math.min(ext.endMs, Math.max(ext.startMs, targetMs));
    const steps = Math.round((clamped - ext.startMs) / ext.stepMs);
    return ext.startMs + steps * ext.stepMs;
  }

  async function refreshSat() {
    if (!settings.satLayerOn) return;
    const product = settings.satLayerProduct;
    let resolvedMs = null;
    try {
      resolvedMs = resolveSatTime(await getSatExtents(), product, getMasterMs());
    } catch {
      el("ml-sat-time").textContent = "Zeitinfo nicht erreichbar (zeigt Standard-Zeitpunkt)";
    }

    // Nur neu erzeugen, wenn sich Produkt oder aufgelöste Zeit geändert haben.
    if (satLayer && satLayer._product === product && satLayer._resolvedMs === resolvedMs) {
      satLayer.setOpacity(settings.satLayerOpacity);
      return;
    }

    if (satLayer) { map.removeLayer(satLayer); satLayer = null; }
    const wmsOptions = {
      layers: product,
      format: "image/png",
      transparent: true,
      opacity: settings.satLayerOpacity,
      version: "1.3.0",
      uppercase: false,
      pane: "wxOverlays",
      zIndex: 10,
      attribution: '&copy; <a href="https://www.eumetsat.int" target="_blank">EUMETSAT</a>',
    };
    if (resolvedMs != null) wmsOptions.time = new Date(resolvedMs).toISOString();
    satLayer = L.tileLayer.wms(EUMETSAT_WMS_BASE, wmsOptions);
    satLayer._product = product;
    satLayer._resolvedMs = resolvedMs;
    satLayer.addTo(map);

    if (resolvedMs != null) {
      el("ml-sat-time").textContent = `Angezeigt: ${fmtLocalTimestamp(new Date(resolvedMs))}`;
    }
  }

  function removeSat() {
    if (satLayer) { map.removeLayer(satLayer); satLayer = null; }
    el("ml-sat-time").textContent = "";
  }

  // -- UI-Verdrahtung ---------------------------------------------------------
  function renderSatProductRadios() {
    el("ml-sat-products").innerHTML = SAT_PRODUCTS.map((p) => `
      <label>
        <input type="radio" name="ml-sat-product" value="${p.id}" />
        ${p.label}
      </label>
    `).join("");
  }

  function wireUI() {
    // Zeit kommt zentral von der Masterzeit — Radar/Sat lösen daraus die
    // nächstliegende verfügbare Aufnahme auf. Nur bei "committed" (Regler
    // losgelassen, Buttons, Jetzt) neu laden — sonst löst kontinuierliches
    // Ziehen über Stunden dutzende Kachel-Requests aus. Während des Abspielens
    // ignoriert refreshRadar die Masterzeit (Schleife hat Vorrang).
    subscribeTime((ms, committed) => { if (committed) { refreshRadar(); refreshSat(); } });
    el("ml-play").addEventListener("click", togglePlay);

    el("ml-sat-on").addEventListener("change", (e) => {
      updateSetting("satLayerOn", e.target.checked);
      if (e.target.checked) refreshSat(); else removeSat();
    });
    el("ml-sat-products").addEventListener("change", (e) => {
      if (e.target.name !== "ml-sat-product") return;
      updateSetting("satLayerProduct", e.target.value);
      refreshSat();
    });
    const satOpacity = el("ml-sat-opacity");
    satOpacity.addEventListener("input", (e) => {
      const v = Number(e.target.value) / 100;
      el("ml-sat-opacity-val").textContent = `${e.target.value}%`;
      if (satLayer) satLayer.setOpacity(v);
    });
    satOpacity.addEventListener("change", (e) => updateSetting("satLayerOpacity", Number(e.target.value) / 100));

    el("ml-radar-on").addEventListener("change", (e) => {
      updateSetting("radarLayerOn", e.target.checked);
      if (e.target.checked) refreshRadar(); else removeRadar();
    });
    const radarOpacity = el("ml-radar-opacity");
    radarOpacity.addEventListener("input", (e) => {
      const v = Number(e.target.value) / 100;
      el("ml-radar-opacity-val").textContent = `${e.target.value}%`;
      if (radarLayer) radarLayer.setOpacity(v);
    });
    radarOpacity.addEventListener("change", (e) => updateSetting("radarLayerOpacity", Number(e.target.value) / 100));
  }

  function restoreFromSettings() {
    // Migrations-/Robustheitsnetz: falls ein persistiertes Produkt (z. B. aus
    // der früheren DWD-Version) nicht mehr existiert, auf das erste zurückfallen.
    if (!SAT_PRODUCTS.some((p) => p.id === settings.satLayerProduct)) {
      updateSetting("satLayerProduct", SAT_PRODUCTS[0].id);
    }

    el("ml-sat-on").checked = settings.satLayerOn;
    el("ml-sat-opacity").value = String(Math.round(settings.satLayerOpacity * 100));
    el("ml-sat-opacity-val").textContent = `${Math.round(settings.satLayerOpacity * 100)}%`;
    const productRadio = el("ml-sat-products").querySelector(`input[value="${settings.satLayerProduct}"]`);
    if (productRadio) productRadio.checked = true;

    el("ml-radar-on").checked = settings.radarLayerOn;
    el("ml-radar-opacity").value = String(Math.round(settings.radarLayerOpacity * 100));
    el("ml-radar-opacity-val").textContent = `${Math.round(settings.radarLayerOpacity * 100)}%`;

    if (settings.satLayerOn) refreshSat();
    if (settings.radarLayerOn) refreshRadar();
  }

  renderSatProductRadios();
  wireUI();
  restoreFromSettings();

  // Solange die Masterzeit auf "jetzt" steht (und nicht abgespielt wird), alle
  // paar Minuten nachziehen, damit neu veröffentlichte Radar-/Satellitenbilder
  // automatisch nachgeladen werden.
  setInterval(() => {
    if (!isNow() || playing) return;
    if (settings.radarLayerOn) refreshRadar();
    if (settings.satLayerOn) refreshSat();
  }, AUTO_REFRESH_MS);
}
