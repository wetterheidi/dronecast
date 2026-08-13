/**
 * `<windspinne-panel>` -- eigenständige Web Component für die Windspinne
 * (Polardarstellung Windrichtung/-geschwindigkeit über der Höhe, ein
 * Zeitpunkt). Gleiches Muster wie `<gramet-panel>` (s. dort): volle
 * Shadow-DOM-Kapselung, keine Abhängigkeit von einer Host-App-globalen
 * `settings`-Instanz oder festen DOM-IDs -- nur Properties/Events.
 *
 * Eingabe: `.profile` ({z,u,v}, s. `column.js` `sliceColumnAtTime()` --
 * reine Daten, kein Netzwerk-Fetch hier). Das eigentliche Zeichnen
 * übernimmt `../../windspinne.js` `renderWindspinne()`.
 *
 * `.colorStops`: OPTIONAL, Format `{max, rgb:[r,g,b]}[]` (s. Doc-Kommentar
 * in windspinne.js) -- der Host bestimmt, welche Windgeschwindigkeit als
 * "kritisch" gilt (Drohne, Fallschirmspringer, ...). Ohne Angabe zeichnet
 * windspinne.js mit einem aktivitätsneutralen Default.
 *
 * Anders als GRAMET (Zeitverlauf) zeigt die Windspinne genau EINEN Zeitpunkt
 * -- die Host-App reicht dafür bei jedem Masterzeit-Wechsel ein neues
 * `.profile` herein (kein eigener Zeit-Picker in der Komponente).
 *
 * Events: `close` (Klick auf ×, Host entscheidet, ob/wie das Panel
 * verschwindet -- z. B. `hidden`).
 */

import css from "./windspinne-panel.css?inline";
import { renderWindspinne, exportPng as exportWindspinnePng } from "../../windspinne.js";

export class WindspinnePanelElement extends HTMLElement {
  static observedAttributes = ["subtitle", "max-height"];

  #profile = null;
  #maxHeightM = 300;
  #colorStops = null;
  #loading = null;
  #svg = null;
  #exportNameParts = ["windspinne"];

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${css}</style>
      <div class="head">
        <span class="title">Windspinne</span>
        <span class="subtitle"></span>
        <button type="button" class="export-btn" title="Als PNG speichern">⭳ PNG</button>
        <button type="button" class="close-btn" title="Schließen">×</button>
      </div>
      <div class="body"></div>
    `;

    this._subtitleEl = root.querySelector(".subtitle");
    this._bodyEl = root.querySelector(".body");

    root.querySelector(".export-btn").addEventListener("click", () => this.exportPng());
    root.querySelector(".close-btn").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    });
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (name === "subtitle") this.subtitle = newVal ?? "";
    else if (name === "max-height") this.maxHeight = Number(newVal);
  }

  get profile() { return this.#profile; }
  set profile(p) {
    this.#profile = p ?? null;
    this.#loading = null;
    this._render();
  }

  get maxHeight() { return this.#maxHeightM; }
  set maxHeight(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) this.#maxHeightM = n;
    this._render();
  }

  get colorStops() { return this.#colorStops; }
  set colorStops(v) {
    this.#colorStops = Array.isArray(v) && v.length ? v : null;
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

  /** Dateiname-Bausteine für den PNG-Export, s. `windspinne.js` `exportPng()`. */
  get exportNameParts() { return this.#exportNameParts; }
  set exportNameParts(parts) { this.#exportNameParts = Array.isArray(parts) ? parts : ["windspinne"]; }

  exportPng() {
    if (this.#svg) exportWindspinnePng(this.#svg, this.#exportNameParts);
  }

  /** Mehrere Properties in einem Rutsch setzen -- ein einziger Redraw statt
   *  einem pro Einzel-Setter (relevant bei jedem Masterzeit-Wechsel). */
  update({ profile, maxHeight, colorStops, subtitle, exportNameParts } = {}) {
    this.#loading = null;
    if (profile !== undefined) this.#profile = profile ?? null;
    if (maxHeight !== undefined) {
      const n = Number(maxHeight);
      if (Number.isFinite(n) && n > 0) this.#maxHeightM = n;
    }
    if (colorStops !== undefined) this.#colorStops = Array.isArray(colorStops) && colorStops.length ? colorStops : null;
    if (subtitle !== undefined) this.subtitle = subtitle;
    if (exportNameParts !== undefined) this.#exportNameParts = exportNameParts;
    this._render();
  }

  _render() {
    if (this.#loading) {
      this._bodyEl.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "body-message";
      msg.textContent = this.#loading;
      this._bodyEl.append(msg);
      this.#svg = null;
      return;
    }
    if (!this.#profile) {
      this._bodyEl.innerHTML = "";
      this.#svg = null;
      return;
    }
    this.#svg = renderWindspinne(this._bodyEl, this.#profile, {
      maxHeightM: this.#maxHeightM,
      colorStops: this.#colorStops,
    });
  }
}

customElements.define("windspinne-panel", WindspinnePanelElement);
