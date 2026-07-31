/**
 * Profil-Store: verwaltet die effektive Drohnen-Datenbank als Zusammenzug aus
 * den eingebauten Werksmodellen (droneProfiles.js, origin "factory") und den
 * nutzergenerierten Profilen (localStorage, origin "user"; Import folgt in
 * Stufe 3 mit origin "imported"). Persistenz wie settings.js — kein Backend.
 *
 * INVARIANTEN (Vertrauens-/Sicherheitsgrenze):
 *   • Werksmodelle sind unveränderlich und werden NIE aus dem Speicher
 *     überschrieben — sie kommen immer frisch aus dem Code.
 *   • Nutzerprofile tragen IMMER origin "user" (bzw. "imported") und eine ID
 *     mit "user:"-Präfix; sie können eine Werks-ID damit nie verdecken.
 *   • Beim Duplizieren eines Werksmodells wird die Hersteller-`source`
 *     entfernt (sie gilt für editierte Werte nicht mehr) und `basedOn`
 *     gesetzt, damit die Abstammung sichtbar bleibt.
 */

import { DRONE_PROFILES } from "./droneProfiles.js";

const STORAGE_KEY = "droneforecast.profiles.v1";

// Grenzwert-Metadaten: Reihenfolge, Anzeigelabel und Herkunftsgruppe je
// Parameter — einzige Quelle für Ansicht (droneProfileView) UND Editor.
// group: "man" = herstellerbasiert · "op" = operationell/regulatorisch (VLOS).
// Richtung/Einheit stehen fest im Limit-Objekt (droneProfiles.js); der Editor
// ändert nur die Zahlenwerte, damit keine malformten Limits entstehen.
export const LIMIT_META = [
  { key: "windSurface", label: "Wind 10 m (Boden)", group: "man" },
  { key: "windBandMax", label: "Wind Höhenband (10 m–Flughöhe)", group: "man" },
  { key: "gustSurface", label: "Böen 10 m", group: "man" },
  { key: "precipitation", label: "Niederschlag", group: "man" },
  { key: "tempMin", label: "Temperatur (Minimum)", group: "man" },
  { key: "tempMax", label: "Temperatur (Maximum)", group: "man" },
  { key: "cloudBase", label: "Wolkenbasis", group: "op" },
  { key: "visibility", label: "Sicht", group: "op" },
];

export const LIMIT_KEYS = LIMIT_META.map((m) => m.key);

export const GROUP_LABEL = {
  man: "Aus Herstellerangaben",
  op: "Betrieb / VLOS (für alle Modelle gleich, nicht modellspezifisch)",
};

let userProfiles = load();

// --- Öffentliche Abfragen ----------------------------------------------------

/** Effektive Liste: Werksmodelle zuerst, dann Nutzerprofile. */
export function listProfiles() {
  return [...DRONE_PROFILES, ...userProfiles];
}

/** Profil per ID aus der effektiven Liste; Fallback = erstes Werksmodell. */
export function getProfile(id) {
  return listProfiles().find((p) => p.id === id) || DRONE_PROFILES[0];
}

/** Bearbeitbar/löschbar sind nur Nicht-Werksprofile. */
export function isEditable(id) {
  const p = getProfile(id);
  return !!p && p.origin !== "factory";
}

// --- Mutationen (persistiert) ------------------------------------------------

/**
 * Kopiert ein beliebiges Profil in ein neues, bearbeitbares Nutzerprofil.
 * Aus einem Werksmodell wird so ohne Änderung an den Werksdaten ein eigenes.
 */
export function duplicateProfile(sourceId) {
  const src = getProfile(sourceId);
  const now = new Date().toISOString();
  const prof = {
    id: newId(src.label + " Kopie"),
    label: `${src.label} (Kopie)`,
    origin: "user",
    manufacturer: src.manufacturer || "",
    category: src.category || "multicopter",
    ipRating: src.ipRating ?? null,
    marginPct: src.marginPct ?? 0.2,
    basedOn: src.id,
    createdAt: now,
    modifiedAt: now,
    limits: cloneLimits(src.limits),
  };
  userProfiles.push(prof);
  save();
  return prof;
}

/** Neues, leeres Nutzerprofil aus einem Werks-Template (Struktur/Einheiten). */
export function createBlankProfile() {
  const tpl = DRONE_PROFILES[0];
  const now = new Date().toISOString();
  const prof = {
    id: newId("Neues Profil"),
    label: "Neues Profil",
    origin: "user",
    manufacturer: "",
    category: "multicopter",
    ipRating: null,
    marginPct: 0.2,
    basedOn: null,
    createdAt: now,
    modifiedAt: now,
    limits: cloneLimits(tpl.limits),
  };
  userProfiles.push(prof);
  save();
  return prof;
}

/**
 * Aktualisiert ein Nutzerprofil. patch darf label, category, ipRating,
 * marginPct und limits[key].value enthalten; Werksprofile sind tabu.
 * Gibt das aktualisierte Profil zurück (oder null bei ungültigem Ziel).
 */
export function updateProfile(id, patch) {
  const prof = userProfiles.find((p) => p.id === id);
  if (!prof) return null;

  if (patch.label != null) prof.label = String(patch.label).trim() || prof.label;
  if (patch.category != null) prof.category = patch.category;
  if ("ipRating" in patch) prof.ipRating = patch.ipRating || null;
  if (patch.marginPct != null && Number.isFinite(patch.marginPct)) {
    prof.marginPct = clamp(patch.marginPct, 0, 1);
  }
  if (patch.limits) {
    for (const key of LIMIT_KEYS) {
      const v = patch.limits[key]?.value;
      if (v != null && Number.isFinite(Number(v)) && prof.limits[key]) {
        prof.limits[key] = { ...prof.limits[key], value: Number(v) };
      }
    }
  }
  prof.modifiedAt = new Date().toISOString();
  save();
  return prof;
}

/** Löscht ein Nutzerprofil. true, wenn etwas entfernt wurde. */
export function deleteProfile(id) {
  const n = userProfiles.length;
  userProfiles = userProfiles.filter((p) => p.id !== id);
  if (userProfiles.length === n) return false;
  save();
  return true;
}

// --- Persistenz --------------------------------------------------------------

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Defensiv normalisieren: Nicht-Werksherkunft erzwingen, "user:"-Präfix
    // sichern, Grenzwert-Struktur gegen das Werks-Template auffüllen.
    return arr.map(normalizeStored).filter(Boolean);
  } catch { return []; }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userProfiles));
  } catch { /* Speicher voll/gesperrt – nicht kritisch */ }
}

function normalizeStored(p) {
  if (!p || typeof p !== "object" || !p.limits) return null;
  const origin = p.origin === "imported" ? "imported" : "user"; // nie "factory"
  const id = String(p.id || "").startsWith("user:") ? p.id : newId(p.label || "profil");
  const tpl = DRONE_PROFILES[0];
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const stored = p.limits[key];
    // Richtung/Einheit aus dem Template führen, nur den Wert übernehmen.
    limits[key] = { ...tpl.limits[key], ...(stored || {}) };
  }
  return {
    id, label: String(p.label || "Profil"), origin,
    manufacturer: p.manufacturer || "", category: p.category || "multicopter",
    ipRating: p.ipRating ?? null, marginPct: Number.isFinite(p.marginPct) ? p.marginPct : 0.2,
    basedOn: p.basedOn ?? null, createdAt: p.createdAt || null, modifiedAt: p.modifiedAt || null,
    limits,
  };
}

// --- Helfer ------------------------------------------------------------------

function cloneLimits(limits) {
  const out = {};
  for (const key of LIMIT_KEYS) if (limits[key]) out[key] = { ...limits[key] };
  return out;
}

function newId(fromLabel) {
  const slug = String(fromLabel).toLowerCase().normalize("NFKD")
    .replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "profil";
  return `user:${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
