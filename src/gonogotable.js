/**
 * Go/No-Go-Tabelle: reines HTML (kein SVG) — Ampel-Zellen pro Stunde,
 * gruppiert nach Tag, mit fett hervorgehobener Bewertungszeile unten.
 * Erwartet das Modell aus gonogo.js: evaluate(surface, windAtHeight, profile, opHeightM).
 */

import { fmtWind, fmtHeight, fmtTemp } from "./units.js";

const STATUS_LABEL = { green: "Go", yellow: "Bedingt", red: "No-Go", na: "Prüfen" };

export function renderGoNoGoTable(host, model) {
  host.innerHTML = "";
  const { time, rows, conclusion } = model;
  if (!time || time.length === 0) { host.textContent = "Keine Zeitreihe."; return; }

  const labelById = Object.fromEntries(rows.map((r) => [r.id, r.label]));
  const groups = dayGroups(time);

  const table = document.createElement("table");
  table.className = "gng-table";

  const thead = document.createElement("thead");
  thead.append(dateRow(groups), hourRow(time));
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) tbody.append(dataRow(row.label, row.cells.map((c) => cellContent(row.kind, c))));
  tbody.append(conclusionRow(conclusion, labelById));
  table.append(tbody);

  const wrap = document.createElement("div");
  wrap.className = "gng-scroll";
  wrap.append(table);
  host.append(wrap);
}

// --- Kopfzeilen --------------------------------------------------------------

function dateRow(groups) {
  const tr = document.createElement("tr");
  tr.className = "gng-daterow";
  tr.append(th("", "gng-corner"));
  for (const g of groups) tr.append(th(g.label, "gng-date", g.count));
  return tr;
}

function hourRow(time) {
  const tr = document.createElement("tr");
  tr.className = "gng-hourrow";
  tr.append(th("Zeit (loc)", "gng-corner"));
  for (const t of time) {
    const h = new Date(t * 1000).getHours();
    tr.append(th(String(h).padStart(2, "0"), "gng-hour"));
  }
  return tr;
}

// --- Datenzeilen ---------------------------------------------------------------

function dataRow(label, cells) {
  const tr = document.createElement("tr");
  const rowLabel = document.createElement("th");
  rowLabel.className = "gng-rowlabel";
  rowLabel.textContent = label;
  tr.append(rowLabel);
  for (const c of cells) tr.append(c);
  return tr;
}

function conclusionRow(conclusion, labelById) {
  const tr = document.createElement("tr");
  tr.className = "gng-conclusion";
  const rowLabel = document.createElement("th");
  rowLabel.className = "gng-rowlabel";
  rowLabel.textContent = "Bewertung";
  tr.append(rowLabel);
  for (const c of conclusion) {
    const td = document.createElement("td");
    td.className = `gng-cell go-${c.status}`;
    td.textContent = STATUS_LABEL[c.status];
    if (c.limitingId) td.title = `Begrenzender Faktor: ${labelById[c.limitingId] || c.limitingId}`;
    tr.append(td);
  }
  return tr;
}

function cellContent(kind, cell) {
  const td = document.createElement("td");
  td.className = `gng-cell go-${cell.status}`;
  td.textContent = formatCell(kind, cell);
  return td;
}

function formatCell(kind, cell) {
  if (kind === "text") return cell.text ?? "–";
  const v = cell.value;
  if (v == null || !Number.isFinite(v)) return "–";
  switch (kind) {
    case "wind": return fmtWind(v);
    case "height": return fmtHeight(v);
    case "temp": return fmtTemp(v);
    case "vis": return `${(v / 1000).toFixed(1)} km`;
    case "precip": return `${v.toFixed(1)} mm/h`;
    case "index": return `${Math.round(v * 100)} %`;
    default: return String(v);
  }
}

// --- Helfer --------------------------------------------------------------------

function th(text, cls, colspan) {
  const e = document.createElement("th");
  e.className = cls;
  e.textContent = text;
  if (colspan && colspan > 1) e.colSpan = colspan;
  return e;
}

// Fasst aufeinanderfolgende Stunden desselben Kalendertags zusammen (colspan).
function dayGroups(time) {
  const groups = [];
  for (const t of time) {
    const d = new Date(t * 1000);
    const key = d.toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.count++;
    } else {
      const label = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
      groups.push({ key, label, count: 1 });
    }
  }
  return groups;
}
