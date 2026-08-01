/**
 * Drohnen-Datenbank für die Go/No-Go-Tabelle: pro Modell ein Satz Grenzwerte,
 * gegen die die Vorhersage bewertet wird. Ein Profil ist ein reines
 * Datenobjekt in DRONE_PROFILES — ein weiteres Modell wird einfach als neuer
 * Eintrag ergänzt, ohne dass Auswerte- (gonogo.js) oder Render-Code
 * (gonogotable.js) sich ändert.
 *
 * limits[key] = { direction: "max"|"min", value, unit, marginPct? }
 *   max:  Rot ab value; Gelb ab value·(1 − marginPct)
 *   min:  Rot ab value; Gelb ab value·(1 + marginPct)
 *   marginPct fehlt -> Profil-Default (profile.marginPct) greift.
 *
 * HERKUNFT DER WERTE — zwei Klassen, bewusst getrennt:
 *   • Herstellerbasiert (Wind, Temperatur, Regen): aus den unter `source`
 *     verlinkten Datenblättern abgeleitet. Hersteller nennen i. d. R. EINE
 *     „max wind speed resistance"-Zahl (W); mangels getrennter Angaben für
 *     Boden-/Höhen-/Böenwind wird W auf windSurface, windBandMax und
 *     gustSurface gelegt (Ausnahme: Wingtra nennt Dauer- UND Böenwind
 *     getrennt). Regen ist aus der IP-Schutzart grob abgeleitet, KEINE
 *     Herstellerfreigabe für Flug bei Niederschlag.
 *   • Operationell/regulatorisch (cloudBase, visibility): NICHT
 *     modellspezifisch — VLOS-/Betriebs-Platzhalter, für alle Profile gleich.
 *     Vor operationellem Einsatz an die geltende Betriebsgenehmigung anpassen.
 *
 * ACHTUNG: Recherchierte Richtwerte (Stand 2026-07), keine rechtsverbindlichen
 * Freigaben. Vor dem operationellen Einsatz gegen das aktuelle Handbuch des
 * konkreten Geräts und die Betriebsgenehmigung verifizieren.
 *
 * Metadatenfelder (manufacturer, category, ipRating, source, notes) werden vom
 * Auswerte-/Render-Code ignoriert — sie dokumentieren die Datenherkunft und
 * stehen für spätere UI (Tooltip/Quelle) bereit.
 */

// VLOS-/Betriebs-Platzhalter, für alle Modelle identisch (siehe Kopf).
const OPERATIONAL_LIMITS = {
  cloudBase: { direction: "min", value: 150, unit: "m" },
  visibility: { direction: "min", value: 5000, unit: "m" },
};

// Eingebaute („Werks"-)Modelle. Die Herkunft (`origin`) wird zentral gestempelt,
// damit ein Werksmodell im UI und beim Export nie mit einem nutzergenerierten
// oder importierten Profil verwechselt werden kann. Nutzer-/Importprofile
// (Stufe 2/3) bekommen origin: "user" bzw. "imported" an anderer Stelle.
const BUILTIN_PROFILES = [
  {
    id: "dji-m350-rtk",
    label: "DJI Matrice 350 RTK",
    manufacturer: "DJI",
    category: "multicopter",
    ipRating: "IP55",
    marginPct: 0.2,
    source: "https://enterprise.dji.com/matrice-350-rtk/specs",
    notes: "Max. Windwiderstand 12 m/s; Betrieb −20…50 °C; IP55 (leichter Regen tolerierbar).",
    limits: {
      windSurface: { direction: "max", value: 12, unit: "m/s" },
      windBandMax: { direction: "max", value: 12, unit: "m/s" },
      gustSurface: { direction: "max", value: 12, unit: "m/s" },
      precipitation: { direction: "max", value: 2, unit: "mm/h" }, // IP55, grob geschätzt
      tempMin: { direction: "min", value: -20, unit: "°C" },
      tempMax: { direction: "max", value: 50, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "dji-m30t",
    label: "DJI Matrice 30T",
    manufacturer: "DJI",
    category: "multicopter",
    ipRating: "IP55",
    marginPct: 0.2,
    source: "https://enterprise.dji.com/matrice-30/specs",
    notes: "Max. Windwiderstand 15 m/s; Betrieb −20…50 °C; IP55 (leichter Regen tolerierbar).",
    limits: {
      windSurface: { direction: "max", value: 15, unit: "m/s" },
      windBandMax: { direction: "max", value: 15, unit: "m/s" },
      gustSurface: { direction: "max", value: 15, unit: "m/s" },
      precipitation: { direction: "max", value: 2, unit: "mm/h" }, // IP55, grob geschätzt
      tempMin: { direction: "min", value: -20, unit: "°C" },
      tempMax: { direction: "max", value: 50, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "dji-mavic3-enterprise",
    label: "DJI Mavic 3 Enterprise",
    manufacturer: "DJI",
    category: "multicopter",
    ipRating: null, // keine IP-Zertifizierung -> Flug bei Niederschlag vermeiden
    marginPct: 0.2,
    source: "https://enterprise.dji.com/mavic-3-enterprise/specs",
    notes: "Max. Windwiderstand 12 m/s; Betrieb −10…40 °C; keine IP-Zertifizierung.",
    limits: {
      windSurface: { direction: "max", value: 12, unit: "m/s" },
      windBandMax: { direction: "max", value: 12, unit: "m/s" },
      gustSurface: { direction: "max", value: 12, unit: "m/s" },
      precipitation: { direction: "max", value: 0.2, unit: "mm/h" }, // nicht IP-zertifiziert
      tempMin: { direction: "min", value: -10, unit: "°C" },
      tempMax: { direction: "max", value: 40, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "dji-mini4-pro",
    label: "DJI Mini 4 Pro",
    manufacturer: "DJI",
    category: "multicopter",
    ipRating: null,
    marginPct: 0.2,
    source: "https://www.dji.com/mini-4-pro/specs",
    notes: "Max. Windwiderstand 10,7 m/s (Level 5); Betrieb 0…40 °C; keine IP-Zertifizierung.",
    limits: {
      windSurface: { direction: "max", value: 10.7, unit: "m/s" },
      windBandMax: { direction: "max", value: 10.7, unit: "m/s" },
      gustSurface: { direction: "max", value: 10.7, unit: "m/s" },
      precipitation: { direction: "max", value: 0.2, unit: "mm/h" }, // nicht IP-zertifiziert
      tempMin: { direction: "min", value: 0, unit: "°C" },
      tempMax: { direction: "max", value: 40, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "wingtra-one-gen2",
    label: "WingtraOne GEN II (VTOL Fixed-Wing)",
    manufacturer: "Wingtra",
    category: "vtol-fixedwing",
    ipRating: null,
    marginPct: 0.2,
    source: "https://wingtra.com/mapping-drone-wingtraone/technical-specifications/",
    notes: "Dauerwind bis 12 m/s, Böen bis 18 m/s (Hersteller nennt beide getrennt); Betrieb −10…40 °C.",
    limits: {
      windSurface: { direction: "max", value: 12, unit: "m/s" }, // Dauerwind
      windBandMax: { direction: "max", value: 12, unit: "m/s" }, // Dauerwind
      gustSurface: { direction: "max", value: 18, unit: "m/s" }, // Böen (Herstellerangabe)
      precipitation: { direction: "max", value: 0.2, unit: "mm/h" },
      tempMin: { direction: "min", value: -10, unit: "°C" },
      tempMax: { direction: "max", value: 40, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "autel-evo-max-4t",
    label: "Autel EVO Max 4T",
    manufacturer: "Autel Robotics",
    category: "multicopter",
    ipRating: "IP43", // Sprühwasserschutz, aber keine Freigabe für Flug bei Regen
    marginPct: 0.2,
    source: "https://shop.autelrobotics.com/pages/evo-max-4t-specifications-aircraft",
    notes: "Max. Windwiderstand 12 m/s; Betrieb −20…50 °C; IP43 (kein Regenflug).",
    limits: {
      windSurface: { direction: "max", value: 12, unit: "m/s" },
      windBandMax: { direction: "max", value: 12, unit: "m/s" },
      gustSurface: { direction: "max", value: 12, unit: "m/s" },
      precipitation: { direction: "max", value: 0.2, unit: "mm/h" }, // IP43, kein Regenflug
      tempMin: { direction: "min", value: -20, unit: "°C" },
      tempMax: { direction: "max", value: 50, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "autel-evo2-pro-v3",
    label: "Autel EVO II Pro V3",
    manufacturer: "Autel Robotics",
    category: "multicopter",
    ipRating: null,
    marginPct: 0.2,
    source: "https://shop.autelrobotics.com/pages/evo-ii-pro-v3-specifications-aircraft",
    // Hersteller nennt „Windwiderstand Level 8" (Beaufort 8 ≈ 17,2–20,7 m/s);
    // konservativ die Untergrenze angesetzt. Vor Einsatz verifizieren.
    notes: "Windwiderstand Beaufort Level 8 (≈17 m/s, Untergrenze); Betrieb −10…40 °C; keine IP-Zertifizierung.",
    limits: {
      windSurface: { direction: "max", value: 17, unit: "m/s" },
      windBandMax: { direction: "max", value: 17, unit: "m/s" },
      gustSurface: { direction: "max", value: 17, unit: "m/s" },
      precipitation: { direction: "max", value: 0.2, unit: "mm/h" },
      tempMin: { direction: "min", value: -10, unit: "°C" },
      tempMax: { direction: "max", value: 40, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "dji-phantom4-rtk",
    label: "DJI Phantom 4 RTK",
    manufacturer: "DJI",
    category: "multicopter",
    ipRating: null,
    marginPct: 0.2,
    source: "https://www.dji.com/phantom-4-rtk/info",
    notes: "Max. Windwiderstand 10 m/s; Betrieb 0…40 °C; keine IP-Zertifizierung.",
    limits: {
      windSurface: { direction: "max", value: 10, unit: "m/s" },
      windBandMax: { direction: "max", value: 10, unit: "m/s" },
      gustSurface: { direction: "max", value: 10, unit: "m/s" },
      precipitation: { direction: "max", value: 0.2, unit: "mm/h" },
      tempMin: { direction: "min", value: 0, unit: "°C" },
      tempMax: { direction: "max", value: 40, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "dji-phantom4-pro-v2",
    label: "DJI Phantom 4 Pro V2.0",
    manufacturer: "DJI",
    category: "multicopter",
    ipRating: null,
    marginPct: 0.2,
    source: "https://www.dji.com/phantom-4-pro-v2/specs",
    notes: "Max. Windwiderstand 10 m/s (≈36 km/h); Betrieb 0…40 °C; keine IP-Zertifizierung.",
    limits: {
      windSurface: { direction: "max", value: 10, unit: "m/s" },
      windBandMax: { direction: "max", value: 10, unit: "m/s" },
      gustSurface: { direction: "max", value: 10, unit: "m/s" },
      precipitation: { direction: "max", value: 0.2, unit: "mm/h" },
      tempMin: { direction: "min", value: 0, unit: "°C" },
      tempMax: { direction: "max", value: 40, unit: "°C", marginPct: 0.1 },
      ...OPERATIONAL_LIMITS,
    },
  },
  {
    id: "meteomatics-mm670m",
    label: "Meteomatics Meteodrone MM-670M",
    manufacturer: "Meteomatics",
    category: "multicopter",
    ipRating: null, // Hersteller nennt kein IP-Rating, aber "waterproof", ausgelegt für Regen/Schnee
    marginPct: 0.2,
    source: "https://www.meteomatics.com/en/meteodrones-weather-drones/",
    notes: "Hexacopter für Vertikalsondierungen bis 6000 m AMSL (BVLOS-zertifiziert), kein klassischer Nutzlast-Copter. " +
      "Max. Windgeschwindigkeit 92 km/h (25,6 m/s, Herstellerangabe); Betrieb bis −45 °C; werkseitig \"waterproof\", " +
      "für Flug in Regen/Schnee freigegeben (kein mm/h-Grenzwert angegeben, konservativ geschätzt); Propeller-Enteisung an Bord. " +
      "Obergrenze der Betriebstemperatur nicht herstellerseitig spezifiziert — Schätzwert, vor Einsatz verifizieren.",
    limits: {
      windSurface: { direction: "max", value: 25.6, unit: "m/s" },
      windBandMax: { direction: "max", value: 25.6, unit: "m/s" },
      gustSurface: { direction: "max", value: 25.6, unit: "m/s" },
      precipitation: { direction: "max", value: 10, unit: "mm/h" }, // "waterproof", Regen/Schnee freigegeben, mm/h grob geschätzt
      tempMin: { direction: "min", value: -45, unit: "°C" },
      tempMax: { direction: "max", value: 40, unit: "°C", marginPct: 0.1 }, // nicht herstellerseitig spezifiziert, Schätzwert
      ...OPERATIONAL_LIMITS,
    },
  },
];

export const DRONE_PROFILES = BUILTIN_PROFILES.map((p) => ({ origin: "factory", ...p }));

export function getProfile(id) {
  return DRONE_PROFILES.find((p) => p.id === id) || DRONE_PROFILES[0];
}
