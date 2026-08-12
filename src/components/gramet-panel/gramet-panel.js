/**
 * `<gramet-panel>` -- eigenständige Web Component für das GRAMET-Meteogramm.
 * Erster Baustein einer geplanten komponentenübergreifenden Bibliothek (s.
 * Gespräch beim Umbau): volle Shadow-DOM-Kapselung, keine Abhängigkeit von
 * einer Host-App-globalen `settings`-Instanz oder festen DOM-IDs -- nur
 * Properties/Events.
 *
 * Eingabe: `.grid` (Ergebnis von `gramet/grid.js` `gridFromColumn()` bzw.
 * `gridFromWaypoints()` -- reine Daten, kein Netzwerk-Fetch hier). Die
 * Ableitung von `view` (`gramet/derive.js` `deriveView()`) sowie das
 * eigentliche Zeichnen (`gramet/render.js` `renderGramet()`) übernimmt die
 * Komponente selbst.
 *
 * Darstellungs-Zustand (Höhenbereich, Ebenen-Sichtbarkeit, Flughöhe) lebt
 * ausschließlich in der Komponente; Persistenz (z. B. in
 * `localStorage`) ist Sache der Host-App -- dafür das `settingschange`-Event
 * beobachten und beim nächsten Öffnen die zuletzt gespeicherten Werte wieder
 * über `.update()`/die einzelnen Property-Setter hereinreichen.
 *
 * Events: `settingschange` (detail: `{ range, layers }`, bei Klick auf
 * Höhenbereich-Umschalter oder Ebenen-Checkbox), `close` (Klick auf ×,
 * Host entscheidet, ob/wie das Panel verschwindet -- z. B. `hidden`).
 */

import css from "./gramet-panel.css?inline";
import { deriveView } from "../../gramet/derive.js";
import { renderGramet, exportPng as exportGrametPng } from "../../gramet/render.js";

// Höhenbereich "bis Flughöhe": etwas Luft über der eingestellten Flughöhe,
// damit die Ceiling-Linie nicht exakt am oberen Rand klebt (wie zuvor
// `XS_ZOOM_HEADROOM` in app.js).
const ZOOM_HEADROOM = 1.15;

const LAYER_KEYS = ["isotherms", "isotachs", "hazards", "windbarbs"];

export class GrametPanelElement extends HTMLElement {
  static observedAttributes = ["subtitle", "range", "max-height"];

  #grid = null;
  #view = null;
  #canvas = null;
  #loading = null;
  #maxHeightM = 300;
  #range = "full";
  #exportNameParts = ["gramet"];

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${css}</style>
      <div class="head">
        <span class="title">GRAMET</span>
        <span class="subtitle"></span>
        <div class="layers">
          <label><input type="checkbox" data-layer="isotherms" checked> Isothermen</label>
          <label><input type="checkbox" data-layer="isotachs" checked> Isotachen</label>
          <label><input type="checkbox" data-layer="hazards" checked> Hazards</label>
          <label><input type="checkbox" data-layer="windbarbs"> Windfiedern</label>
        </div>
        <div class="range-toggle">
          <button type="button" data-range="full">Gesamthöhe</button>
          <button type="button" data-range="zoom">bis Flughöhe</button>
        </div>
        <button type="button" class="export-btn" title="Als PNG speichern">⭳ PNG</button>
        <button type="button" class="close-btn" title="Schließen">×</button>
      </div>
      <div class="body"></div>
    `;

    this._subtitleEl = root.querySelector(".subtitle");
    this._bodyEl = root.querySelector(".body");

    root.querySelector(".layers").addEventListener("change", (e) => {
      if (!e.target.closest("input[data-layer]")) return;
      this._render();
      this._emitChange();
    });
    root.querySelector(".range-toggle").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      this.range = btn.dataset.range;
      this._emitChange();
    });
    root.querySelector(".export-btn").addEventListener("click", () => this.exportPng());
    root.querySelector(".close-btn").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    });

    this._syncRangeButtons();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (name === "subtitle") this.subtitle = newVal ?? "";
    else if (name === "range") this.range = newVal;
    else if (name === "max-height") this.maxHeight = Number(newVal);
  }

  get grid() { return this.#grid; }
  set grid(g) {
    this.#grid = g ?? null;
    this.#view = this.#grid ? deriveView(this.#grid) : null;
    this.#loading = null;
    this._render();
  }

  get range() { return this.#range; }
  set range(v) {
    this.#range = v === "zoom" ? "zoom" : "full";
    this._syncRangeButtons();
    this._render();
  }

  get maxHeight() { return this.#maxHeightM; }
  set maxHeight(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) this.#maxHeightM = n;
    this._render();
  }

  get subtitle() { return this._subtitleEl.textContent; }
  set subtitle(v) { this._subtitleEl.textContent = v ?? ""; }

  /** Meldetext statt Chart -- z. B. während die Host-App noch Daten lädt. */
  get loading() { return this.#loading; }
  set loading(v) {
    this.#loading = v || null;
    this._render();
  }

  get layers() {
    const out = {};
    for (const key of LAYER_KEYS) out[key] = this._layerCheckbox(key).checked;
    return out;
  }
  set layers(v = {}) {
    for (const key of LAYER_KEYS) {
      if (key in v) this._layerCheckbox(key).checked = !!v[key];
    }
    this._render();
  }

  /** Dateiname-Bausteine für den PNG-Export, s. `render.js` `exportPng()`. */
  get exportNameParts() { return this.#exportNameParts; }
  set exportNameParts(parts) { this.#exportNameParts = Array.isArray(parts) ? parts : ["gramet"]; }

  exportPng() {
    if (this.#canvas) exportGrametPng(this.#canvas, this.#exportNameParts);
  }

  /** Mehrere Properties in einem Rutsch setzen -- ein einziger Redraw statt
   *  einem pro Einzel-Setter (relevant beim Öffnen/bei Datenwechsel, wo
   *  Grid, Flughöhe, Höhenbereich und Ebenen zusammen aktualisiert werden). */
  update({ grid, maxHeight, range, layers, subtitle, exportNameParts } = {}) {
    this.#loading = null;
    if (grid !== undefined) {
      this.#grid = grid ?? null;
      this.#view = this.#grid ? deriveView(this.#grid) : null;
    }
    if (maxHeight !== undefined) {
      const n = Number(maxHeight);
      if (Number.isFinite(n) && n > 0) this.#maxHeightM = n;
    }
    if (range !== undefined) {
      this.#range = range === "zoom" ? "zoom" : "full";
      this._syncRangeButtons();
    }
    if (layers) {
      for (const key of LAYER_KEYS) {
        if (key in layers) this._layerCheckbox(key).checked = !!layers[key];
      }
    }
    if (subtitle !== undefined) this.subtitle = subtitle;
    if (exportNameParts !== undefined) this.#exportNameParts = exportNameParts;
    this._render();
  }

  _layerCheckbox(key) {
    return this.shadowRoot.querySelector(`input[data-layer="${key}"]`);
  }

  _syncRangeButtons() {
    this.shadowRoot.querySelectorAll(".range-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.range === this.#range);
    });
  }

  _emitChange() {
    this.dispatchEvent(new CustomEvent("settingschange", {
      bubbles: true,
      composed: true,
      detail: { range: this.#range, layers: this.layers },
    }));
  }

  _render() {
    if (this.#loading) {
      this._bodyEl.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "body-message";
      msg.textContent = this.#loading;
      this._bodyEl.append(msg);
      this.#canvas = null;
      return;
    }
    if (!this.#grid || !this.#view) {
      this._bodyEl.innerHTML = "";
      this.#canvas = null;
      return;
    }
    let zMin, zMax;
    if (this.#range === "zoom") {
      zMax = Math.round(this.#maxHeightM * ZOOM_HEADROOM);
      zMin = Math.max(10, this.#grid.z[0] || 10);
    }
    this.#canvas = renderGramet(this._bodyEl, this.#grid, this.#view, {
      axis: this.#range === "zoom" ? "lin" : "log",
      zMin,
      zMax,
      maxHeightM: this.#maxHeightM,
      layerToggles: this.layers,
      onRedraw: (canvas) => { this.#canvas = canvas; },
    });
  }
}

customElements.define("gramet-panel", GrametPanelElement);
