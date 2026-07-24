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
  MAPLAYERS_TIME_STEP_MIN,
} from "./config.js";
import { settings, updateSetting } from "./settings.js";

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
  let targetOffsetMin = 0; // Minuten relativ zu "jetzt" — nicht persistiert

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
  async function refreshRadar() {
    if (!settings.radarLayerOn) return;
    let meta;
    try {
      meta = await getRVMeta();
    } catch {
      el("ml-radar-time").textContent = "Radar: Metadaten nicht erreichbar";
      return;
    }
    const targetSec = Math.round((Date.now() + targetOffsetMin * 60000) / 1000);
    const allFrames = [...(meta.radar.past || []), ...(meta.radar.nowcast || [])];
    const frame = rvClosest(allFrames, targetSec);
    if (!frame) return;

    // Nur neu erzeugen, wenn sich der Frame tatsächlich geändert hat (spart
    // Kachel-Requests bei ungenutzten Auto-Refresh-Ticks).
    if (radarLayer && radarLayer._frameTime === frame.time) {
      radarLayer.setOpacity(settings.radarLayerOpacity);
      return;
    }

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

    const isNowcast = (meta.radar.nowcast || []).some((f) => f.time === frame.time);
    const frameTxt = fmtLocalTimestamp(new Date(frame.time * 1000));
    el("ml-radar-time").textContent = `Angezeigt: ${frameTxt}${isNowcast ? " ▶ Nowcast" : ""}`;
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
  function resolveSatTime(extents, productId, offsetMin) {
    const ext = extents[productId];
    if (!ext) return null;
    const targetMs = Date.now() + offsetMin * 60000;
    const clamped = Math.min(ext.endMs, Math.max(ext.startMs, targetMs));
    const steps = Math.round((clamped - ext.startMs) / ext.stepMs);
    return ext.startMs + steps * ext.stepMs;
  }

  async function refreshSat() {
    if (!settings.satLayerOn) return;
    const product = settings.satLayerProduct;
    let resolvedMs = null;
    try {
      resolvedMs = resolveSatTime(await getSatExtents(), product, targetOffsetMin);
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

  // -- Zeitsteuerung (gilt für Radar UND Satellit) ---------------------------
  function offsetLabel() {
    if (targetOffsetMin === 0) return "▶ Aktuell";
    const sign = targetOffsetMin > 0 ? "+" : "−";
    return `${sign}${Math.abs(targetOffsetMin)} min`;
  }

  function setOffset(min) {
    const slider = el("ml-time-slider");
    const lo = Number(slider.min), hi = Number(slider.max);
    targetOffsetMin = Math.min(hi, Math.max(lo, min));
    slider.value = String(targetOffsetMin);
    el("ml-time-display").textContent = offsetLabel();
    refreshRadar();
    refreshSat();
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
    el("ml-time-back").addEventListener("click", () => setOffset(targetOffsetMin - MAPLAYERS_TIME_STEP_MIN));
    el("ml-time-fwd").addEventListener("click", () => setOffset(targetOffsetMin + MAPLAYERS_TIME_STEP_MIN));
    el("ml-time-slider").addEventListener("input", (e) => setOffset(Number(e.target.value)));

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
  el("ml-time-display").textContent = offsetLabel();

  // Solange auf "Aktuell" gepinnt, alle paar Minuten nachziehen, damit neu
  // veröffentlichte Radar-/Satellitenbilder automatisch nachgeladen werden.
  setInterval(() => {
    if (targetOffsetMin !== 0) return;
    if (settings.radarLayerOn) refreshRadar();
    if (settings.satLayerOn) refreshSat();
  }, AUTO_REFRESH_MS);
}
