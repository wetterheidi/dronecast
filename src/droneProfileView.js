/**
 * Read-only-Detailansicht eines Drohnenprofils (Stufe 1 der Datenbank-UI):
 * zeigt Herkunft, Metadaten und alle Grenzwerte eines Profils an — ohne
 * Bearbeitung. Reines DOM-Rendering wie gonogotable.js.
 *
 * Die HERKUNFT (origin) wird bewusst prominent dargestellt: Werksdaten
 * (herstellerbasiert, mit Quelllink) müssen von nutzergenerierten oder
 * importierten Profilen unterscheidbar sein — sonst könnte ein selbst
 * getippter Wert wie eine geprüfte Herstellerangabe wirken.
 */

import { LIMIT_META, GROUP_LABEL } from "./droneProfileStore.js";

// Herkunftskennzeichen. Unbekannt/fehlend gilt bewusst NICHT als "factory".
const ORIGIN_META = {
  factory: { label: "Werksdaten", cls: "orig-factory", hint: "aus Herstellerdatenblatt recherchiert" },
  user: { label: "Eigenes Profil", cls: "orig-user", hint: "vom Nutzer angelegt/bearbeitet" },
  imported: { label: "Importiert", cls: "orig-imported", hint: "aus einer Datei geladen – ungeprüfte Quelle" },
  unknown: { label: "Unbekannte Herkunft", cls: "orig-unknown", hint: "keine Herkunftsangabe" },
};

const CATEGORY_LABEL = {
  multicopter: "Multicopter",
  "vtol-fixedwing": "VTOL / Starrflügler",
};

const DIR_LABEL = { max: "max", min: "min" };

export function renderProfileDetails(host, profile) {
  host.innerHTML = "";
  if (!profile) { host.textContent = "Kein Profil gewählt."; return; }

  const card = document.createElement("div");
  card.className = "dp-card";
  card.append(header(profile), originLine(profile));
  if (profile.notes) card.append(note(profile.notes));
  card.append(limitsTable(profile), disclaimer());
  host.append(card);
}

// --- Kopf & Metadaten --------------------------------------------------------

function header(p) {
  const h = document.createElement("div");
  h.className = "dp-head";
  const title = document.createElement("strong");
  title.textContent = p.label;
  h.append(title);

  const meta = [p.manufacturer, CATEGORY_LABEL[p.category] || p.category, p.ipRating ? `Schutzart ${p.ipRating}` : "keine IP-Zertifizierung"]
    .filter(Boolean).join(" · ");
  const sub = document.createElement("span");
  sub.className = "dp-sub";
  sub.textContent = meta;
  h.append(sub);
  return h;
}

function originLine(p) {
  const o = ORIGIN_META[p.origin] || ORIGIN_META.unknown;
  const line = document.createElement("div");
  line.className = "dp-origin";

  const badge = document.createElement("span");
  badge.className = `dp-badge ${o.cls}`;
  badge.textContent = o.label;
  line.append(badge);

  const detail = document.createElement("span");
  detail.className = "dp-origin-detail";
  detail.textContent = o.hint;
  line.append(detail);

  // Werksdaten: Quelllink. Nutzer/Import: Herkunftsdetails (Basis, Zeitstempel).
  if (p.origin === "factory" && p.source) {
    line.append(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = p.source; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "Quelle";
    line.append(a);
  } else {
    const extra = [];
    if (p.basedOn) extra.push(`abgeleitet von ${p.basedOn}`);
    if (p.modifiedAt) extra.push(`geändert ${fmtDate(p.modifiedAt)}`);
    else if (p.createdAt) extra.push(`angelegt ${fmtDate(p.createdAt)}`);
    if (extra.length) {
      const s = document.createElement("span");
      s.className = "dp-origin-detail";
      s.textContent = " · " + extra.join(" · ");
      line.append(s);
    }
  }
  return line;
}

function note(text) {
  const n = document.createElement("p");
  n.className = "dp-note";
  n.textContent = text;
  return n;
}

// --- Grenzwert-Tabelle -------------------------------------------------------

function limitsTable(p) {
  const table = document.createElement("table");
  table.className = "dp-table";

  const thead = document.createElement("thead");
  thead.append(rowOf("th", ["Parameter", "Grenze", "Wert", "Gelb-Puffer"], "dp-colhead"));
  table.append(thead);

  const tbody = document.createElement("tbody");
  let lastGroup = null;
  for (const { key, label, group } of LIMIT_META) {
    const lim = p.limits[key];
    if (!lim) continue;
    if (group !== lastGroup) {
      tbody.append(groupHeader(group));
      lastGroup = group;
    }
    const marginPct = lim.marginPct ?? p.marginPct;
    tbody.append(rowOf("td", [
      label,
      DIR_LABEL[lim.direction] || lim.direction,
      `${fmtNum(lim.value)} ${lim.unit}`,
      marginPct != null ? `±${Math.round(marginPct * 100)} %` : "–",
    ]));
  }
  table.append(tbody);
  return table;
}

function groupHeader(group) {
  const tr = document.createElement("tr");
  tr.className = "dp-group";
  const td = document.createElement("td");
  td.colSpan = 4;
  td.textContent = GROUP_LABEL[group] || group;
  tr.append(td);
  return tr;
}

function disclaimer() {
  const d = document.createElement("p");
  d.className = "dp-disclaimer";
  d.textContent = "Recherchierte Richtwerte, keine rechtsverbindlichen Freigaben. "
    + "Vor operationellem Einsatz gegen Gerätehandbuch und Betriebsgenehmigung verifizieren.";
  return d;
}

// --- Helfer ------------------------------------------------------------------

function rowOf(cellTag, values, cls) {
  const tr = document.createElement("tr");
  if (cls) tr.className = cls;
  for (const v of values) {
    const c = document.createElement(cellTag);
    c.textContent = v;
    tr.append(c);
  }
  return tr;
}

function fmtNum(v) {
  return Number.isInteger(v) ? String(v) : String(v).replace(".", ",");
}

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("de-DE");
}
