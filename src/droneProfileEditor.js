/**
 * Formular zum Anlegen/Bearbeiten eines Nutzerprofils (Stufe 2). Reines
 * DOM-Rendering; die Persistenz erledigt der Store über die Callbacks.
 *
 * Bewusst eingeschränkt: editierbar sind Bezeichnung, Kategorie, IP-Schutzart,
 * Gelb-Puffer und die Zahlenwerte der Grenzwerte. Richtung (max/min) und
 * Einheit je Parameter bleiben fix (aus dem Profil übernommen) — so kann kein
 * strukturell defektes Limit entstehen, das die Auswertung (gonogo.js) bricht.
 */

import { LIMIT_META, GROUP_LABEL } from "./droneProfileStore.js";

const CATEGORY_OPTIONS = [
  ["multicopter", "Multicopter"],
  ["vtol-fixedwing", "VTOL / Starrflügler"],
];

/**
 * @param handlers { onSave(patch), onCancel(), onDelete? }
 *   patch = { label, category, ipRating, marginPct, limits: {key:{value}} }
 */
export function renderProfileEditor(host, profile, { onSave, onCancel, onDelete }) {
  host.innerHTML = "";
  const form = document.createElement("form");
  form.className = "dp-form";
  form.setAttribute("autocomplete", "off");

  const label = textField("Bezeichnung", profile.label);
  const category = selectField("Kategorie", CATEGORY_OPTIONS, profile.category);
  const ip = textField("IP-Schutzart (optional)", profile.ipRating || "");
  const margin = numField("Gelb-Puffer %", Math.round((profile.marginPct ?? 0.2) * 100), { min: 0, max: 100, step: 1 });
  form.append(grid([label.wrap, category.wrap, ip.wrap, margin.wrap]));

  const limitInputs = {};
  let lastGroup = null;
  for (const { key, label: lbl, group } of LIMIT_META) {
    const lim = profile.limits[key];
    if (!lim) continue;
    if (group !== lastGroup) { form.append(groupTitle(GROUP_LABEL[group] || group)); lastGroup = group; }
    const f = limitField(lbl, lim);
    limitInputs[key] = f.input;
    form.append(f.wrap);
  }

  const err = document.createElement("p");
  err.className = "dp-err";
  err.hidden = true;
  form.append(err);

  const bar = document.createElement("div");
  bar.className = "dp-actions";
  const save = button("Speichern", "dp-primary", "submit");
  const cancel = button("Abbrechen", "", "button");
  bar.append(save, cancel);
  if (onDelete) {
    const del = button("Löschen", "dp-danger", "button");
    del.addEventListener("click", () => onDelete());
    bar.append(del);
  }
  form.append(bar);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const patch = collect(label, category, ip, margin, limitInputs);
    const problem = validate(patch);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    onSave(patch);
  });
  cancel.addEventListener("click", () => onCancel());

  host.append(form);
  label.input.focus();
}

// --- Sammeln & Validieren ----------------------------------------------------

function collect(label, category, ip, margin, limitInputs) {
  const limits = {};
  for (const key of Object.keys(limitInputs)) {
    limits[key] = { value: limitInputs[key].value };
  }
  return {
    label: label.input.value,
    category: category.input.value,
    ipRating: ip.input.value.trim(),
    marginPct: Number(margin.input.value) / 100,
    limits,
  };
}

function validate(patch) {
  if (!patch.label.trim()) return "Bitte eine Bezeichnung eingeben.";
  if (!Number.isFinite(patch.marginPct) || patch.marginPct < 0 || patch.marginPct > 1) {
    return "Gelb-Puffer muss zwischen 0 und 100 % liegen.";
  }
  for (const { key, label } of LIMIT_META) {
    const v = patch.limits[key]?.value;
    if (v === "" || v == null || !Number.isFinite(Number(v))) {
      return `„${label}" ist kein gültiger Zahlenwert.`;
    }
  }
  const tMin = Number(patch.limits.tempMin?.value);
  const tMax = Number(patch.limits.tempMax?.value);
  if (Number.isFinite(tMin) && Number.isFinite(tMax) && tMin >= tMax) {
    return "Temperatur-Minimum muss kleiner als das Maximum sein.";
  }
  return null;
}

// --- Feld-Bausteine ----------------------------------------------------------

function textField(labelText, value) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  return { wrap: labeled(labelText, input), input };
}

function numField(labelText, value, { min, max, step } = {}) {
  const input = document.createElement("input");
  input.type = "number";
  if (min != null) input.min = String(min);
  if (max != null) input.max = String(max);
  input.step = step != null ? String(step) : "any";
  input.value = String(value);
  return { wrap: labeled(labelText, input), input };
}

function selectField(labelText, options, value) {
  const input = document.createElement("select");
  for (const [val, text] of options) {
    const o = document.createElement("option");
    o.value = val; o.textContent = text;
    input.append(o);
  }
  input.value = value;
  return { wrap: labeled(labelText, input), input };
}

// Grenzwertfeld: Zahleneingabe mit fixer Richtung + Einheit als Kontext.
function limitField(labelText, lim) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = String(lim.value);
  input.setAttribute("inputmode", "decimal");

  const wrap = document.createElement("label");
  wrap.className = "dp-field dp-limit";
  const cap = document.createElement("span");
  cap.className = "dp-field-label";
  cap.textContent = `${labelText} (${lim.direction})`;
  const box = document.createElement("span");
  box.className = "dp-inputbox";
  const unit = document.createElement("span");
  unit.className = "dp-unit";
  unit.textContent = lim.unit;
  box.append(input, unit);
  wrap.append(cap, box);
  return { wrap, input };
}

function labeled(labelText, input) {
  const wrap = document.createElement("label");
  wrap.className = "dp-field";
  const cap = document.createElement("span");
  cap.className = "dp-field-label";
  cap.textContent = labelText;
  wrap.append(cap, input);
  return wrap;
}

function grid(fields) {
  const g = document.createElement("div");
  g.className = "dp-grid";
  g.append(...fields);
  return g;
}

function groupTitle(text) {
  const h = document.createElement("div");
  h.className = "dp-form-group";
  h.textContent = text;
  return h;
}

function button(text, cls, type) {
  const b = document.createElement("button");
  b.type = type || "button";
  if (cls) b.className = cls;
  b.textContent = text;
  return b;
}
