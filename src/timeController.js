/**
 * Masterzeit — die einzige Zeitquelle der App. Ein absoluter Zeitpunkt (ms),
 * aus dem alle Bereiche ihren jeweils nächsten verfügbaren Datenstand ableiten:
 *
 *   - Bedingungen am Punkt (stündliche Oberflächen-/Höhenwinde)
 *   - Numerische Felder (stündliches Windoverlay)
 *   - Nowcasting (Radar/Satellit, ~15-min-Frames)
 *
 * Die Bereiche haben unterschiedliche native Auflösungen; die Masterzeit läuft
 * bewusst auf einem einheitlichen 15-min-Raster (so liegen die Radar-/Sat-Bilder
 * vor), und jeder Konsument rastet daraus auf seine eigene Auflösung und
 * beschriftet, was er real zeigt. So können nie Daten verschiedener Zeitpunkte
 * unbemerkt vermischt werden — der häufigste Fehler bei Fehlvorhersagen.
 *
 * Untergrenze der Zeitleiste ist 00Z des aktuellen Tages (ab dort werden auch
 * die numerischen Daten gehostet), Obergrenze das Ende des Vorhersagehorizonts.
 * Die Masterzeit wird NICHT persistiert — jede Sitzung startet auf „Jetzt".
 */

const el = (id) => document.getElementById(id);

export const MASTER_STEP_MS = 15 * 60 * 1000; // 15-min-Raster, konsistent überall
const HOUR_MS = 60 * 60 * 1000;

let masterMs = snap(Date.now());
let minMs = null;
let maxMs = null;
const subscribers = new Set();

function snap(ms) {
  return Math.round(ms / MASTER_STEP_MS) * MASTER_STEP_MS;
}

function clamp(ms) {
  if (minMs != null) ms = Math.max(minMs, ms);
  if (maxMs != null) ms = Math.min(maxMs, ms);
  return ms;
}

/** Liegt die Masterzeit (auf 15 min genau) auf „jetzt"? */
export function isNow() {
  return masterMs === snap(Date.now());
}

export function getMasterMs() {
  return masterMs;
}

/**
 * Setzt die Masterzeit und benachrichtigt alle Konsumenten.
 * @param {number} ms  Zielzeitpunkt (wird auf 15 min gerastet und geklemmt)
 * @param {boolean} committed  true = Endzustand (z. B. Slider losgelassen,
 *        Button), false = laufendes Ziehen. Teure Konsumenten (Kachel-Layer,
 *        Netz) dürfen bei false drosseln; billige rendern immer live.
 */
export function setMasterMs(ms, committed = true) {
  const next = clamp(snap(ms));
  const changed = next !== masterMs;
  masterMs = next;
  syncSliderValue();
  renderLabel();
  if (changed || committed) notify(committed);
}

/** Alles auf „Jetzt" zurücksetzen. */
export function resetToNow() {
  setMasterMs(Date.now(), true);
}

/**
 * Zeitfenster festlegen (beim App-Start und nach jedem Laden). Hält die
 * aktuelle Masterzeit, solange sie noch im Fenster liegt, sonst „Jetzt".
 */
export function setRange(minMsIn, maxMsIn) {
  minMs = snap(minMsIn);
  maxMs = snap(maxMsIn);
  if (maxMs < minMs) maxMs = minMs;
  masterMs = (masterMs < minMs || masterMs > maxMs) ? clamp(snap(Date.now())) : clamp(masterMs);
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
// Der Slider zählt in 15-min-Schritten ab minMs (0 = Untergrenze).
function syncSliderRange() {
  const s = el("master-time-slider");
  if (!s || minMs == null) return;
  s.min = "0";
  s.max = String(Math.round((maxMs - minMs) / MASTER_STEP_MS));
  s.step = "1";
}

function syncSliderValue() {
  const s = el("master-time-slider");
  if (!s || minMs == null) return;
  s.value = String(Math.round((masterMs - minMs) / MASTER_STEP_MS));
}

function renderLabel() {
  const lab = el("master-time-label");
  if (lab) {
    lab.textContent = new Date(masterMs).toLocaleString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  }
  const now = el("master-time-now");
  if (now) now.classList.toggle("active", isNow());
}

// -- Verdrahtung ------------------------------------------------------------
export function initTimeControls() {
  const s = el("master-time-slider");
  if (s) {
    s.addEventListener("input", (e) => setMasterMs(minMs + Number(e.target.value) * MASTER_STEP_MS, false));
    s.addEventListener("change", (e) => setMasterMs(minMs + Number(e.target.value) * MASTER_STEP_MS, true));
  }
  el("master-time-back")?.addEventListener("click", () => setMasterMs(masterMs - HOUR_MS, true));
  el("master-time-fwd")?.addEventListener("click", () => setMasterMs(masterMs + HOUR_MS, true));
  el("master-time-now")?.addEventListener("click", resetToNow);
  renderLabel();
}
