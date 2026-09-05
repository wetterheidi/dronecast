/**
 * Masterzeit — die einzige Zeitquelle der App. Ein absoluter Zeitpunkt (ms),
 * aus dem alle Bereiche ihren jeweils nächsten verfügbaren Datenstand ableiten:
 *
 *   - Bedingungen am Punkt (stündliche Oberflächen-/Höhenwinde)
 *   - Numerische Felder (stündliches Windoverlay)
 *   - Nowcasting (Radar/Satellit, eigene Frame-Zeitachsen)
 *
 * Die Masterzeit selbst ist BEWUSST ungerastert: jeder Konsument sucht sich
 * ohnehin den nächstliegenden eigenen Zeitpunkt (`nearestIndex` bei den
 * numerischen Feldern, `rvClosest`/`resolveSatTime` bei Radar/Satellit) und
 * beschriftet, was er real zeigt. So können nie Daten verschiedener Zeitpunkte
 * unbemerkt vermischt werden — der häufigste Fehler bei Fehlvorhersagen.
 * Ein Raster auf dem Zustand würde daran nichts verbessern, aber die Anzeige
 * eine Genauigkeit vortäuschen lassen, die kein Produkt hat.
 *
 * Gerastert wird stattdessen an der EINGABE, und zwar dort jeweils passend:
 *   - Zeitregler: `gridMs` (s. `setSliderGrid`) — 1 h, mit Nowcast 15 min
 *   - ±1 h und GRAMET-Klick: volle Stunde (beides zeigt stündliche Modelldaten)
 *   - „Jetzt": gar nicht — Radar/Satellit sollen den frischesten Frame bekommen
 *
 * Untergrenze der Zeitleiste ist 00Z des aktuellen Tages (ab dort werden auch
 * die numerischen Daten gehostet), Obergrenze das Ende des Vorhersagehorizonts.
 * Die Masterzeit wird NICHT persistiert — jede Sitzung startet auf „Jetzt".
 */

import { fmtClock, zoneTag } from "meteokit/timefmt";

const el = (id) => document.getElementById(id);

export const HOUR_MS = 60 * 60 * 1000;
export const QUARTER_MS = 15 * 60 * 1000;

let masterMs = Date.now();
let followNow = true;   // „Jetzt" ist ein Zustand, kein Zeitvergleich (s. isNow)
let gridMs = HOUR_MS;   // Rasterweite des Zeitreglers
let minMs = null;
let maxMs = null;
const subscribers = new Set();

// Alle Raster hängen an der lokalen Mitternacht, nicht an der Epoche: nur so
// liegen die Rasterpunkte auf vollen LOKALEN Stunden (Zeitzonen mit :30/:45-
// Versatz) — und genau das ist die Zeit, die der Benutzer im Label liest.
function localMidnight(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function snapTo(ms, grid, mode = "round") {
  const base = localMidnight(ms);
  const n = (ms - base) / grid;
  const k = mode === "floor" ? Math.floor(n) : mode === "ceil" ? Math.ceil(n) : Math.round(n);
  return base + k * grid;
}

function clamp(ms) {
  if (minMs != null) ms = Math.max(minMs, ms);
  if (maxMs != null) ms = Math.min(maxMs, ms);
  return ms;
}

/**
 * Folgt die Masterzeit dem „Jetzt"? Bewusst ein Zustandsflag und kein
 * Vergleich mit `Date.now()`: ein Vergleich wird schon durch das bloße
 * Verstreichen der Zeit falsch, ohne dass der Benutzer etwas getan hat.
 */
export function isNow() {
  return followNow;
}

export function getMasterMs() {
  return masterMs;
}

export function getGridMs() {
  return gridMs;
}

/**
 * Setzt die Masterzeit und benachrichtigt alle Konsumenten.
 * @param {number} ms  Zielzeitpunkt (wird geklemmt)
 * @param {object} [opts]
 * @param {boolean} [opts.committed=true]  true = Endzustand (z. B. Slider
 *        losgelassen, Button), false = laufendes Ziehen. Teure Konsumenten
 *        (Kachel-Layer, Netz) dürfen bei false drosseln; billige rendern immer.
 * @param {number} [opts.grid]  Rasterweite, auf die die Eingabe einrastet.
 *        Ohne Angabe wird der Zeitpunkt exakt übernommen.
 * @param {boolean} [opts.follow=false]  true nur für „Jetzt" (s. isNow).
 */
export function setMasterMs(ms, { committed = true, grid = null, follow = false } = {}) {
  const next = clamp(grid ? snapTo(ms, grid) : ms);
  const changed = next !== masterMs || follow !== followNow;
  masterMs = next;
  followNow = follow;
  syncSliderValue();
  renderLabel();
  if (changed || committed) notify(committed);
}

/** Alles auf „Jetzt" zurücksetzen — ungerastert, s. Kopfkommentar. */
export function resetToNow() {
  setMasterMs(Date.now(), { committed: true, follow: true });
}

/**
 * Rasterweite des Zeitreglers. Hauptraster ist 1 h — alle numerischen Produkte
 * sind stündlich, also ist dort jede erreichbare Reglerposition auch eine
 * gültige Modellstunde. Auf 15 min wird nur umgeschaltet, solange Radar oder
 * Satellit aktiv sind: nur dort gibt es überhaupt Daten zwischen den vollen
 * Stunden. Eine vom Benutzer gesetzte Zeit rastet dabei auf das neue Raster
 * ein, damit der Reglerknopf nicht zwischen zwei Rasterpunkten steht; „Jetzt"
 * bleibt exakt.
 */
export function setSliderGrid(nextGridMs) {
  if (nextGridMs === gridMs) return;
  gridMs = nextGridMs;
  const prev = masterMs;
  if (!followNow) masterMs = clamp(snapTo(masterMs, gridMs));
  syncSliderRange();
  syncSliderValue();
  renderLabel();
  if (masterMs !== prev) notify(true);
}

/**
 * Zeitfenster festlegen (beim App-Start und nach jedem Laden). Hält die
 * aktuelle Masterzeit, solange sie noch im Fenster liegt, sonst „Jetzt".
 */
export function setRange(minMsIn, maxMsIn) {
  minMs = snapTo(minMsIn, HOUR_MS, "floor");
  maxMs = snapTo(maxMsIn, HOUR_MS, "floor");
  if (maxMs < minMs) maxMs = minMs;
  if (followNow || masterMs < minMs || masterMs > maxMs) {
    masterMs = clamp(Date.now());
    followNow = true;
  } else {
    masterMs = clamp(masterMs);
  }
  syncSliderRange();
  syncSliderValue();
  renderLabel();
  notify(true);
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify(committed) {
  for (const fn of subscribers) {
    try { fn(masterMs, committed); } catch (e) { console.error("timeController subscriber:", e); }
  }
}

// -- Slider/Labels ----------------------------------------------------------
// Der Slider zählt in `gridMs`-Schritten ab minMs (0 = Untergrenze). minMs
// liegt auf lokaler Mitternacht, damit jede Rastposition auf einer vollen
// (Viertel-)Stunde liegt.
function sliderMs(value) {
  return minMs + Number(value) * gridMs;
}

function syncSliderRange() {
  const s = el("master-time-slider");
  if (!s || minMs == null) return;
  s.min = "0";
  s.max = String(Math.max(0, Math.round((maxMs - minMs) / gridMs)));
  s.step = "1";
}

function syncSliderValue() {
  const s = el("master-time-slider");
  if (!s || minMs == null) return;
  s.value = String(Math.round((masterMs - minMs) / gridMs));
}

function renderLabel() {
  const lab = el("master-time-label");
  if (lab) {
    lab.textContent = fmtClock(new Date(masterMs), {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    }) + ` ${zoneTag()}`;
  }
  // Das Reglerraster wechselt mit dem Nowcasting — sichtbar machen, sonst
  // ändert sich das Verhalten des Reglers unerklärt unter der Hand. Bewusst mit
  // „Regler:" beschriftet: die ±1-h-Knöpfe daneben rasten IMMER auf die volle
  // Stunde ein, unabhängig vom Reglerraster (s. `stepHour`).
  const grid = el("master-time-grid");
  if (grid) grid.textContent = `Regler: ${gridMs === HOUR_MS ? "1 h" : `${Math.round(gridMs / 60000)} min`}`;
  const now = el("master-time-now");
  if (now) now.classList.toggle("active", followNow);
}

// -- Verdrahtung ------------------------------------------------------------
// Erst auf die volle Stunde einrasten, dann weiterschalten: aus 13:07 wird
// „zurück" 13:00 und nicht 12:07. Damit gibt es aus jedem Zwischenzeitpunkt
// („Jetzt", GRAMET-Klick, 15-min-Raster) einen Ein-Klick-Weg auf die volle
// Stunde — also auf den Zeitpunkt, den die numerischen Produkte wirklich haben.
function stepHour(dir) {
  const edge = snapTo(masterMs, HOUR_MS, dir < 0 ? "floor" : "ceil");
  setMasterMs(edge === masterMs ? edge + dir * HOUR_MS : edge, { committed: true });
}

export function initTimeControls() {
  const s = el("master-time-slider");
  if (s) {
    s.addEventListener("input", (e) => setMasterMs(sliderMs(e.target.value), { committed: false }));
    s.addEventListener("change", (e) => setMasterMs(sliderMs(e.target.value), { committed: true }));
  }
  el("master-time-back")?.addEventListener("click", () => stepHour(-1));
  el("master-time-fwd")?.addEventListener("click", () => stepHour(+1));
  el("master-time-now")?.addEventListener("click", resetToNow);
  renderLabel();
}
