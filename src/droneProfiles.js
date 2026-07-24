/**
 * Drohnenprofile für die Go/No-Go-Tabelle: pro Profil ein Satz Grenzwerte,
 * gegen die die Vorhersage bewertet wird. Ein Profil ist ein reines
 * Datenobjekt in DRONE_PROFILES — ein weiteres Modell wird einfach als
 * neuer Eintrag ergänzt, ohne dass Auswerte- oder Render-Code sich ändert.
 *
 * limits[key] = { direction: "max"|"min", value, unit, marginPct? }
 *   max:  Rot ab value; Gelb ab value·(1 − marginPct)
 *   min:  Rot ab value; Gelb ab value·(1 + marginPct)
 *   marginPct fehlt -> Profil-Default (profile.marginPct) greift.
 *
 * ACHTUNG: Die Werte im Platzhalterprofil sind Beispielwerte zur
 * Software-Entwicklung — keine geprüften Herstellerangaben. Vor dem
 * operationellen Einsatz durch reale Grenzwerte ersetzen/ergänzen.
 */

export const DRONE_PROFILES = [
  {
    id: "placeholder-multicopter",
    label: "Platzhalter · Multicopter (Beispielwerte, nicht geprüft)",
    marginPct: 0.2,
    limits: {
      windAtHeight: { direction: "max", value: 12, unit: "m/s" },
      gustSurface: { direction: "max", value: 15, unit: "m/s" },
      cloudBase: { direction: "min", value: 150, unit: "m" },
      visibility: { direction: "min", value: 5000, unit: "m" },
      precipitation: { direction: "max", value: 0.5, unit: "mm/h" },
      tempMin: { direction: "min", value: -10, unit: "°C" },
      tempMax: { direction: "max", value: 40, unit: "°C", marginPct: 0.1 },
    },
  },
];

export function getProfile(id) {
  return DRONE_PROFILES.find((p) => p.id === id) || DRONE_PROFILES[0];
}
