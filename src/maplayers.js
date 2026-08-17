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
import { subscribe as subscribeTime, getMasterMs, isNow, resetToNow } from "./timeController.js";

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
  // die letzten 2 h und stellt beim Stoppen wieder die Masterzeit-Layer her.
  // Verstellt die Masterzeit bewusst NICHT.
  let playing = false;
  let playTimer = null;
  let playPos = 0;

  function fmtLocalTimestamp(d) {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}.${mm}.${yy} ${hh}:${mi}`;
  }

  // Statuszeile unter Radar/Satellit. Normal = unauffälliger Hinweistext;
  // warn = rot hervorgehoben (v. a. "kein Bild für diesen Zeitpunkt" — das
  // ist der Fall, den Nutzer sonst leicht übersehen und dann fälschlich für
  // einen Ausfall halten). Bei Zeiten außerhalb des Nowcasting-Fensters gibt
  // es zusätzlich einen direkten Sprung zurück auf "Jetzt".
  function setHint(target, text, { warn = false } = {}) {
    target.classList.toggle("warn", warn);
    target.textContent = text;
  }

  function setHintWithJumpNow(target, text) {
    target.classList.add("warn");
    target.textContent = "";
    target.append(document.createTextNode(text + " — "));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "jump-now";
    btn.textContent = "zu „Jetzt“ springen";
    btn.addEventListener("click", () => resetToNow());
    target.append(btn);
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
    setHint(el("ml-radar-time"), `Angezeigt: ${frameTxt} loc${isNowcast ? " ▶ Nowcast" : ""}`);
  }

  // Jenseits dieser Toleranz gibt es kein passendes Radarbild (Radar reicht nur
  // ~2 h zurück und per Nowcast ~30 min voraus) — dann ausblenden statt ein
  // veraltetes Bild an einem Zukunftszeitpunkt zu zeigen.
  const RADAR_AVAIL_TOLERANCE_S = 20 * 60;

  async function refreshRadar() {
    if (!settings.radarLayerOn || playing) return; // während des Abspielens steuert die Schleife
    let meta;
    try {
      meta = await getRVMeta();
    } catch {
      setHint(el("ml-radar-time"), "Radar: Metadaten nicht erreichbar", { warn: true });
      return;
    }
    const targetSec = Math.round(getMasterMs() / 1000);
    const allFrames = [...(meta.radar.past || []), ...(meta.radar.nowcast || [])];
    const frame = rvClosest(allFrames, targetSec);
    if (!frame || Math.abs(frame.time - targetSec) > RADAR_AVAIL_TOLERANCE_S) {
      if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; }
      const target = el("ml-radar-time");
      const first = allFrames[0], last = allFrames[allFrames.length - 1];
      const rangeTxt = first && last
        ? ` (verfügbar: ${fmtLocalTimestamp(new Date(first.time * 1000))} – ${fmtLocalTimestamp(new Date(last.time * 1000))} loc)`
        : "";
      const msg = `Kein Radarbild für diesen Zeitpunkt${rangeTxt}`;
      if (isNow()) setHint(target, msg, { warn: true });
      else setHintWithJumpNow(target, msg);
      return;
    }
    setRadarFrame(meta, frame);
  }

  // -- Abspielen-Schleife (Nowcasting) --------------------------------------
  // Spielt die letzten 2 h als Schleife ab, ohne die Masterzeit zu verstellen.
  // Es wird NICHTS automatisch eingeschaltet: gelooped wird genau das, was aktiv
  // ist — nur Radar → Radar-Loop, nur Satellit → Sat-Loop, beide → beide auf
  // einer gemeinsamen Zeitachse synchron. Alle Frame-Layer werden gecacht und je
  // Frame nur EINMAL geladen; die Schleife blendet danach nur noch per Deckkraft
  // um. Ohne das rennt man beim wiederholten Neuaufbau sofort in HTTP 429.
  const PLAY_STEP_MS = 500;                    // Anzeigedauer je Frame
  const PLAY_LOOP_PAUSE_MS = 1100;             // längere Pause am aktuellsten Frame
  const PLAY_WINDOW_MS = 2 * 60 * 60 * 1000;   // Schleifenlänge: letzte 2 h
  const PLAY_GRID_MS = 15 * 60 * 1000;         // gemeinsames Loop-Raster (wie Masterzeit)

  let playRadar = null;    // Map<frameTime(s), L.tileLayer>
  let playSat = null;      // Map<isoTime, L.tileLayer.wms>
  let playTimeline = null; // number[] (ms), gemeinsame Loop-Zeitachse
  let playCtx = null;      // { rvMeta, allFrames, satExt, product }

  function radarPlayLayer(meta, frame) {
    if (!playRadar) playRadar = new Map();
    let layer = playRadar.get(frame.time);
    if (!layer) {
      const tileUrl = `${meta.host}${frame.path}/256/{z}/{x}/{y}/${RAINVIEWER_COLOR_SCHEME}/1_1.png`;
      layer = L.tileLayer(tileUrl, {
        opacity: 0,
        attribution: 'Radar: <a href="https://rainviewer.com" target="_blank">RainViewer</a>',
        pane: "wxOverlays", zIndex: 20, tileSize: 256, maxNativeZoom: 7, maxZoom: 19, transparent: true,
      });
      playRadar.set(frame.time, layer);
      layer.addTo(map);
    }
    return layer;
  }

  function satPlayLayer(product, resolvedMs) {
    if (!playSat) playSat = new Map();
    const iso = new Date(resolvedMs).toISOString();
    let layer = playSat.get(iso);
    if (!layer) {
      layer = L.tileLayer.wms(EUMETSAT_WMS_BASE, {
        layers: product, format: "image/png", transparent: true, opacity: 0,
        version: "1.3.0", uppercase: false, pane: "wxOverlays", zIndex: 10,
        attribution: '&copy; <a href="https://www.eumetsat.int" target="_blank">EUMETSAT</a>',
        time: iso,
      });
      playSat.set(iso, layer);
      layer.addTo(map);
    }
    return layer;
  }

  function clearPlayLayers() {
    for (const m of [playRadar, playSat]) {
      if (m) for (const layer of m.values()) map.removeLayer(layer);
    }
    playRadar = null; playSat = null;
  }

  async function startPlay() {
    const wantRadar = settings.radarLayerOn;
    const wantSat = settings.satLayerOn;
    if (!wantRadar && !wantSat) {
      el("ml-play-status").textContent = "Erst Radar oder Satellit aktivieren";
      return;
    }

    const ctx = { rvMeta: null, allFrames: null, satExt: null, product: settings.satLayerProduct };
    if (wantRadar) {
      try {
        ctx.rvMeta = await getRVMeta();
        ctx.allFrames = [...(ctx.rvMeta.radar.past || []), ...(ctx.rvMeta.radar.nowcast || [])];
      } catch { el("ml-play-status").textContent = "Radar nicht erreichbar"; return; }
    }
    if (wantSat) {
      try {
        const extents = await getSatExtents();
        ctx.satExt = extents[ctx.product] || null;
      } catch { ctx.satExt = null; } // Sat ohne Zeitdimension → im Loop übersprungen
    }

    // Gemeinsame Loop-Zeitachse: 15-min-Raster über die letzten 2 h, plus
    // +30 min Radar-Nowcast, falls Radar aktiv ist.
    const endGrid = Math.round(Date.now() / PLAY_GRID_MS) * PLAY_GRID_MS;
    const upperGrid = wantRadar ? endGrid + 30 * 60000 : endGrid;
    const timeline = [];
    for (let t = endGrid - PLAY_WINDOW_MS; t <= upperGrid; t += PLAY_GRID_MS) timeline.push(t);

    // Statische Masterzeit-Layer ausblenden, solange die Schleife läuft.
    if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; }
    if (satLayer) { map.removeLayer(satLayer); satLayer = null; }

    playCtx = ctx;
    playTimeline = timeline;
    playPos = 0;
    playing = true;
    el("ml-play").classList.add("playing");
    el("ml-play").textContent = "⏸ Stopp";
    playStep();
  }

  function playStep() {
    if (!playing || !playTimeline) return;
    const t = playTimeline[playPos];
    const parts = [`${fmtLocalTimestamp(new Date(t))} loc`];

    // Radar: nächsten Frame zum Loop-Zeitpunkt zeigen (falls im Bereich).
    if (playCtx.allFrames) {
      const frame = rvClosest(playCtx.allFrames, Math.round(t / 1000));
      const inRange = frame && Math.abs(frame.time - t / 1000) <= RADAR_AVAIL_TOLERANCE_S;
      const current = inRange ? radarPlayLayer(playCtx.rvMeta, frame) : null;
      if (playRadar) for (const layer of playRadar.values()) {
        layer.setOpacity(layer === current ? settings.radarLayerOpacity : 0);
      }
      if (inRange) {
        const isNowcast = (playCtx.rvMeta.radar.nowcast || []).some((f) => f.time === frame.time);
        parts.push(isNowcast ? "Radar▶" : "Radar");
      }
    }

    // Satellit: nächsten verfügbaren Zeitschritt zeigen (falls im Bereich).
    if (playCtx.satExt) {
      const ext = playCtx.satExt;
      const inRange = t >= ext.startMs - ext.stepMs && t <= ext.endMs + ext.stepMs;
      const resolvedMs = inRange ? resolveSatTime({ [playCtx.product]: ext }, playCtx.product, t) : null;
      const current = resolvedMs != null ? satPlayLayer(playCtx.product, resolvedMs) : null;
      if (playSat) for (const layer of playSat.values()) {
        layer.setOpacity(layer === current ? settings.satLayerOpacity : 0);
      }
      if (current) parts.push("Sat");
    }

    el("ml-play-status").textContent = parts.join(" · ");
    const atEnd = playPos === playTimeline.length - 1;
    playPos = atEnd ? 0 : playPos + 1;
    playTimer = setTimeout(playStep, atEnd ? PLAY_LOOP_PAUSE_MS : PLAY_STEP_MS);
  }

  function stopPlay() {
    playing = false;
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    clearPlayLayers();
    playCtx = null; playTimeline = null;
    el("ml-play").classList.remove("playing");
    el("ml-play").textContent = "▶ Abspielen";
    el("ml-play-status").textContent = "";
    refreshRadar(); // zurück zu den Masterzeit-Layern
    refreshSat();
  }

  function togglePlay() {
    if (playing) stopPlay(); else startPlay();
  }

  function removeRadar() {
    if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; }
    setHint(el("ml-radar-time"), "");
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
    if (!settings.satLayerOn || playing) return; // während des Abspielens steuert die Schleife
    const product = settings.satLayerProduct;
    const targetMs = getMasterMs();
    let ext = null, resolvedMs = null;
    try {
      const extents = await getSatExtents();
      ext = extents[product];
      resolvedMs = resolveSatTime(extents, product, targetMs);
    } catch {
      setHint(el("ml-sat-time"), "Zeitinfo nicht erreichbar (zeigt Standard-Zeitpunkt)", { warn: true });
    }

    // Zukunft/außerhalb der verfügbaren Zeitreihe → ausblenden statt ein
    // veraltetes Bild (z. B. das letzte, an einem Zeitpunkt „morgen") zu zeigen.
    if (ext && (targetMs > ext.endMs + ext.stepMs || targetMs < ext.startMs - ext.stepMs)) {
      if (satLayer) { map.removeLayer(satLayer); satLayer = null; }
      const target = el("ml-sat-time");
      const rangeTxt = ` (verfügbar: ${fmtLocalTimestamp(new Date(ext.startMs))} – ${fmtLocalTimestamp(new Date(ext.endMs))} loc)`;
      const msg = `Kein Satellitenbild für diesen Zeitpunkt${rangeTxt}`;
      if (isNow()) setHint(target, msg, { warn: true });
      else setHintWithJumpNow(target, msg);
      return;
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
      setHint(el("ml-sat-time"), `Angezeigt: ${fmtLocalTimestamp(new Date(resolvedMs))} loc`);
    }
  }

  function removeSat() {
    if (satLayer) { map.removeLayer(satLayer); satLayer = null; }
    setHint(el("ml-sat-time"), "");
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
