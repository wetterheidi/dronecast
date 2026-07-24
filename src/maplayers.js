/**
 * Kartenlayer: Niederschlagsradar (RainViewer) + Satellit (DWD-WMS).
 * Beide Quellen sind CORS-offen, kein eigener Proxy nötig. Portiert aus
 * METEOMAP (meteomap_52.html), an DroneForecast angepasst: unabhängige
 * Deckkraft-Regler statt einem gemeinsamen, eigene ±15-Min-Zeitsteuerung
 * (DroneForecast hat noch keinen globalen Zeit-Slider) statt Kopplung an
 * einen vorhandenen. Die Zeitsteuerung wirkt nur auf das Radar (RainViewer
 * hat echte Historie/Nowcast) — das Satellitenbild bleibt immer die
 * aktuellste DWD-Aufnahme (WMS ohne Zeitdimension, Refresh alle ~3 Std.).
 *
 * Eigener Leaflet-Pane ("wxOverlays", zIndex 350) zwischen tilePane (200,
 * Basiskarten) und overlayPane (400, u. a. die Esri-Hybrid-Grenzlinien
 * sowie Geomans Zeichnungen) — Wetter-Layer liegen so über allen
 * Basiskarten, aber unter Beschriftungen/gezeichneten Objekten. Zugleich
 * der Andockpunkt für künftige NWP-Layer (siehe IDEEN.md).
 */

import {
  RAINVIEWER_API, RAINVIEWER_META_TTL_MS, RAINVIEWER_COLOR_SCHEME,
  DWD_WMS_BASE, DWD_SAT_PRODUCTS, DWD_SAT_UPDATE_INTERVAL_H, MAPLAYERS_TIME_STEP_MIN,
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
  let radarLayer = null;
  let satLayer = null;
  let targetOffsetMin = 0; // Minuten relativ zu "jetzt" — nicht persistiert

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

  function rvFmtTime(unixSec) {
    const d = new Date(unixSec * 1000);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm} UTC`;
  }

  // -- Radar (RainViewer) ---------------------------------------------------
  async function refreshRadar() {
    if (!settings.radarLayerOn) return;
    let meta;
    try {
      meta = await getRVMeta();
    } catch {
      el("ml-time-display").textContent = "Radar: Metadaten nicht erreichbar";
      return;
    }
    const targetSec = Math.round((Date.now() + targetOffsetMin * 60000) / 1000);
    const allFrames = [...(meta.radar.past || []), ...(meta.radar.nowcast || [])];
    const frame = rvClosest(allFrames, targetSec);
    if (!frame) return;

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
    radarLayer.addTo(map);

    const isNowcast = (meta.radar.nowcast || []).some((f) => f.time === frame.time);
    updateTimeDisplay(rvFmtTime(frame.time), isNowcast);
  }

  function removeRadar() {
    if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; }
    updateTimeDisplay(null, false);
  }

  // -- Satellit (DWD-WMS) ----------------------------------------------------
  function refreshSat(force) {
    if (!settings.satLayerOn) return;
    const product = settings.satLayerProduct;
    if (!force && satLayer && satLayer._dwdProduct === product) {
      satLayer.setOpacity(settings.satLayerOpacity);
      return;
    }
    if (satLayer) { map.removeLayer(satLayer); satLayer = null; }
    satLayer = L.tileLayer.wms(DWD_WMS_BASE, {
      layers: product,
      format: "image/png",
      transparent: true,
      opacity: settings.satLayerOpacity,
      version: "1.3.0",
      uppercase: false,
      pane: "wxOverlays",
      zIndex: 10,
      attribution: 'Satellit: <a href="https://www.dwd.de" target="_blank">DWD</a> / EUMETSAT',
    });
    satLayer._dwdProduct = product;
    satLayer.addTo(map);
  }

  function removeSat() {
    if (satLayer) { map.removeLayer(satLayer); satLayer = null; }
  }

  // Kein WMS-Zeitparameter -> kein echter Aufnahmezeitpunkt abfragbar. Genähert
  // über den zuletzt planmäßig fälligen Veröffentlichungstermin (s. config.js).
  function latestSatSlot() {
    const now = new Date();
    const slotHour = Math.floor(now.getUTCHours() / DWD_SAT_UPDATE_INTERVAL_H) * DWD_SAT_UPDATE_INTERVAL_H;
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slotHour, 0, 0));
  }

  function fmtLocalTimestamp(d) {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}.${mm}.${yy} ${hh}:${mi}`;
  }

  function updateSatHint() {
    el("ml-sat-hint").textContent =
      `Zeit gilt für das Radar. Das Satellitenbild zeigt immer die Aufnahme ` +
      `von ${fmtLocalTimestamp(latestSatSlot())} loc (Aktualisierung alle ~3 Std., nicht navigierbar).`;
  }

  // -- Zeitsteuerung (nur Radar) ---------------------------------------------
  function updateTimeDisplay(radarTimeTxt, isNowcast) {
    const disp = el("ml-time-display");
    if (!settings.radarLayerOn) {
      disp.textContent = targetOffsetMin === 0 ? "▶ Aktuell" : offsetLabel();
      return;
    }
    if (!radarTimeTxt) { disp.textContent = offsetLabel(); return; }
    disp.textContent = `${radarTimeTxt}${isNowcast ? " ▶ Nowcast" : ""}`;
  }

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
    updateTimeDisplay(null, false);
    refreshRadar();
  }

  // -- UI-Verdrahtung ---------------------------------------------------------
  function renderSatProductRadios() {
    el("ml-sat-products").innerHTML = DWD_SAT_PRODUCTS.map((p) => `
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
      if (e.target.checked) refreshSat(true); else removeSat();
    });
    el("ml-sat-products").addEventListener("change", (e) => {
      if (e.target.name !== "ml-sat-product") return;
      updateSetting("satLayerProduct", e.target.value);
      refreshSat(true);
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
    el("ml-sat-on").checked = settings.satLayerOn;
    el("ml-sat-opacity").value = String(Math.round(settings.satLayerOpacity * 100));
    el("ml-sat-opacity-val").textContent = `${Math.round(settings.satLayerOpacity * 100)}%`;
    const productRadio = el("ml-sat-products").querySelector(`input[value="${settings.satLayerProduct}"]`);
    if (productRadio) productRadio.checked = true;

    el("ml-radar-on").checked = settings.radarLayerOn;
    el("ml-radar-opacity").value = String(Math.round(settings.radarLayerOpacity * 100));
    el("ml-radar-opacity-val").textContent = `${Math.round(settings.radarLayerOpacity * 100)}%`;

    if (settings.satLayerOn) refreshSat(true);
    if (settings.radarLayerOn) refreshRadar();
  }

  renderSatProductRadios();
  wireUI();
  restoreFromSettings();
  updateSatHint();

  // Radar folgt "jetzt" weiter, solange auf "Aktuell" gepinnt; Satellit wird
  // periodisch neu erzeugt, da die WMS-URL ohne Zeitparameter sonst über den
  // 3-Std.-Rhythmus hinweg dasselbe (gecachte) Bild liefern könnte.
  setInterval(() => {
    if (settings.radarLayerOn && targetOffsetMin === 0) refreshRadar();
    if (settings.satLayerOn) refreshSat(true);
    updateSatHint();
  }, AUTO_REFRESH_MS);
}
