# Ideen & Erweiterungen (Backlog)

Sammlung möglicher Verbesserungen für spätere Ausbaustufen. Kein Zwang zur
Reihenfolge — hier landet, was uns beim Bauen als „später mal" auffällt.

---

## Wolkenbasis: Ceiling-Höhe aus dem Modell-RH-Profil

**Status:** zurückgestellt · **Motivation:** die aktuell schwächste Größe im
Meteogramm ist die *Höhe* der Wolkenbasis.

### Aktueller Stand (Ausgangslage)
Im Panel „Wolkenbasis tief" ([src/meteogram.js](src/meteogram.js), `drawBaseVis`):
- Basis = **LCL nach Espy**: `125 · (T₂ₘ − Td₂ₘ)` m AGL.
- Trigger nur über **tiefe** Bewölkung (`cloud_cover_low`):
  `< 25 %` keine Linie · `25–50 %` gestrichelt (SCT) · `> 50 %` durchgezogen
  (BKN/OVC = Ceiling).
- Schwäche: LCL ist eine **Bodenpaket-Größe** — gut für konvektive/tiefe
  Wolken, ungenau für Schichtwolken.

### Idee: RH-Profil als Höhen-Verfeinerung + Konsistenz-Check
Feuchte **nicht** als Primärquelle (führt allein zu Unsicherheit — Erfahrung
aus `upper_winds_open_meteo`), sondern als Höhen-Verfeinerung und Konfidenz.

Drei unabhängige Signale, die wir haben:

| Signal | sagt uns | Schwäche |
|---|---|---|
| `cloud_cover_low` (Oberfläche) | **ob** tiefe Wolke da ist | keine Höhe |
| LCL = 125·Spread | **Höhe** einer Basis | nur Bodenpaket |
| Modell-RH-Profil (Michael, Level) | Höhe der **gesättigten** Schicht | RH-Schwellen modellabhängig |

### Algorithmus (Skizze)
1. In der `WindField` `metExtras` einschalten → `relative_humidity_level{l}`
   pro Level verfügbar.
2. Neue Methode: RH-Profil einer Säule zu Zeit *t* zurückgeben (analog zu
   `windAt`, aber ganze Spalte im Low-Band Boden … ~2 km AGL).
3. Pro Vorhersagestunde die Säule von unten durchgehen und die
   RH→Wolkenmengen-Heuristik anwenden:
   - `RH < 65 %` → SKC (frei)
   - `65–85 %` → FEW/SCT
   - `≥ 85 %` → BKN (Ceiling-Kandidat) · `≈ 100 %` → OVC
4. **Kombinieren, nicht ersetzen:**
   - `cloud_cover_low` bleibt der **Trigger** (Wolkenschema des Modells fängt
     Subskalen-Effekte ab, die reine RH verpasst).
   - Wo eine gesättigte Low-Schicht existiert: **deren Höhe statt LCL** plotten.
   - Beide einig (`low > 50 %` **und** `RH ≥ 85 %`) → hohe Konfidenz →
     durchgezogen; nur eins → gestrichelt.

### Kosten / Hinweise
- ~48 Profil-Auswertungen pro Ort und Lauf (Level sind ohnehin geladen, also
  günstig — wie die frühere Höhen-Windreihe).
- RH-Schwellen ggf. je Modell (ICON-D2 vs ICON-EU) leicht kalibrieren.
- METAR-Achtel als Referenz: SKC 0 · FEW 1–2 · SCT 3–4 · BKN 5–7 · OVC 8.

---

## Wolkenfraktion (Cross-Section): höhenabhängige kritische RH

**Status:** zurückgestellt · **Betrifft:** Bewölkungs-Panel der Cross-Section.

### Aktueller Stand
Bewölkung wird aus der Level-Feuchte über eine **feste, stückweise lineare
Kennlinie** diagnostiziert ([src/column.js](src/column.js), `cloudFrac`):
`< 65 %` frei · `65–85 %` → 0…0,5 (FEW/SCT) · `85–100 %` → 0,5…1,0 (BKN/OVC).
Reine Visualisierungs-Heuristik, feste Schwelle über alle Höhen.

### Idee: RH_crit mit Höhe/Druck variieren (Sundqvist-Typ)
Echte Wolkenschemata nutzen keine feste Schwelle, sondern eine **kritische
relative Feuchte `RH_crit(p)`**, ab der Wolke gebildet wird — sie ist in der
Grenzschicht niedriger (Wolken entstehen dort schon bei geringerer RH) und in
der freien Troposphäre höher. Wolkenfraktion z. B. (Sundqvist):

```
CF = 1 − sqrt( max(0, (RH_sat − RH) / (RH_sat − RH_crit(p)) ) )
```

mit `RH_sat ≈ 100 %`. `RH_crit(p)` typischerweise ~0,6–0,7 nahe Boden,
ansteigend auf ~0,8–0,9 in der Höhe (Profil aus dem Druck/der Höhe ableiten).

### Nutzen / Hinweise
- Physikalisch plausiblere vertikale Wolkenstruktur als die feste Schwelle,
  v. a. der Übergang Grenzschicht ↔ freie Troposphäre.
- Braucht keine neuen Daten (RH pro Level ist vorhanden); nur `cloudFrac`
  ersetzen und ein `RH_crit(p)`-Profil festlegen (ggf. je Modell kalibrieren).
- Verwandt mit dem [RH-Profil-Ceiling](#wolkenbasis-ceiling-höhe-aus-dem-modell-rh-profil)
  oben — beide könnten sich dieselbe `RH_crit`-Kurve teilen.

---

## Gefahrenbereiche in der Cross-Section visualisieren

**Status:** vorgemerkt · **Vehikel:** Wind-/Temperatur-Cross-Section (die
vertikale Struktur macht diese Gefahren überhaupt erst sichtbar).

Idee: kritische Zonen als Overlay (schraffiert/umrandet) über die
Cross-Section legen, aus den vorhandenen Modell-Level-Daten diagnostiziert:

- **Vereisung:** Zonen mit `0 °C … −15 °C` **und** hoher Feuchte / in Wolke
  (RH ≥ ~90 %). Klassisches Struktureis-Fenster. (Vgl. „atmospheric ice
  growth" im Beispiel-Screenshot.)
- **Windscherung:** Betrag des vertikalen Windgradienten `|dV/dz|` zwischen
  benachbarten Leveln; v. a. bodennah (Low-Level-Windshear) drohnenrelevant.
  Auch Richtungsscherung (Drehung mit der Höhe) erfassen.
- **Turbulenz:** Proxy aus Scherung + statischer Stabilität (Richardson-Zahl
  `Ri = (g/θ)(dθ/dz) / (dV/dz)²`; kleine Ri → turbulent), alternativ
  einfacher Scherungs-/Böigkeits-Proxy.

Alle drei Größen sind aus `u/v`, `T`, `RH`, `height_agl` je Level ableitbar —
keine neuen Datenquellen nötig. Als Farbstufen oder Konturen im Panel.

## Weather Briefing: Ausbau

**Status:** Grundgerüst gebaut ([src/briefing.js](src/briefing.js), Button
„Briefing") · **Motivation:** zwei bewusst zurückgestellte Verfeinerungen aus
der Erstumsetzung.

### Ortsname im Kopf (Reverse-Geocoding)
Aktuell zeigt der Briefing-Kopf **Koordinaten + Gitterhöhe**. DZMaster löst
zusätzlich den Ortsnamen via Nominatim auf
(`nominatim.openstreetmap.org/reverse`).
- Bewusst weggelassen, um eine **Netzabhängigkeit/Fehlerquelle** beim
  Seitenaufbau zu vermeiden.
- Nachrüsten: vor `buildBriefingHtml` optional den Namen holen, bei Fehler
  sauber auf Koordinaten zurückfallen (Try/Catch wie in DZMaster). Ggf.
  Ergebnis cachen, damit wiederholtes Öffnen keine erneute Abfrage auslöst.

### Direkt-Download als `.html`-Datei
Aktuell öffnet das Briefing einen **neuen Tab** (`window.open` + `document.write`).
- Alternative/Ergänzung: denselben HTML-String als `Blob` herunterladen
  (`type: "text/html"`, `<a download>` — Muster wie DZMasters
  `exportComprehensiveReportAsHtml`/Blob-Download).
- Dateiname z. B. `droneforecast-briefing_<lat>_<lon>_<YYYY-MM-DD>.html`.
- Nützlich für Offline-Ablage/Weitergabe; Tab-Variante bleibt für „schnell
  ansehen & drucken".

### Verwandt / später
- **Mehrtages-Briefing:** aktuell nur der laufende Tag (UTC). Auf den
  geladenen Horizont (1–5 Tage) erweitern, nach Tagen gruppiert — bewusst
  klein gehalten, um die Seite lesbar zu lassen.

## Go/No-Go-Tabelle: Ausbaustufe 2

**Status:** V1 gebaut ([src/gonogo.js](src/gonogo.js),
[src/gonogotable.js](src/gonogotable.js), [src/droneProfiles.js](src/droneProfiles.js),
Button „Tabelle (Go/No-Go)") · **Motivation:** bewusst zurückgestellte
Parameter/Ausbauten aus der Erstumsetzung, siehe Planungsgespräch.

### Vereisung als eigene Zeile
T/RH-Band `0 °C … −15 °C` mit hoher Feuchte (RH ≥ ~90 %) aus den Modell-
Leveln — siehe „Gefahrenbereiche in der Cross-Section" oben. In V1 bewusst
ausgelassen, da die Schwellenkalibrierung ohne Referenzfälle unsicher ist.

### Turbulenz als eigene Zeile
Scherungs-/Richardson-Zahl-Proxy (`Ri = (g/θ)(dθ/dz) / (dV/dz)²`), ebenfalls
aus den Modell-Leveln ableitbar — siehe Cross-Section-Idee oben. Gleiches
Kalibrierungsproblem wie Vereisung.

### Böen auf Flughöhe hochrechnen
V1 zeigt Böen nur als Bodenwert (10 m, klar gelabelt) — das Modell liefert
keine Böen auf Modell-Leveln. Mögliche Ergänzung: Böenfaktor aus den
Bodenwerten (`Böen10m / Mittelwind10m`) auf den Mittelwind der Flughöhe
anwenden. Bewusst zurückgestellt, um keine unvalidierte Zusatzannahme in die
Bewertung einzubauen.

### In-App-Editor für Drohnenprofile
Aktuell wird ein neues Profil als Objekt in `DRONE_PROFILES`
([src/droneProfiles.js](src/droneProfiles.js)) ergänzt (Code-Änderung, kein
Neuladen der App-Logik nötig). Falls das auf Dauer zu umständlich wird: ein
Formular im Panel, das Profile liest/schreibt (z. B. `localStorage`), statt
sie im Quellcode zu pflegen.

## Weitere Ideen (Kurzliste)

- **Cross-Section (Höhe × Zeit):** eigenes Produkt; hier gehören die
  Höhenwinde aus Michaels Modell-Leveln hin (aus dem Meteogramm bewusst
  herausgehalten).
- **Karte mit Layern:** auswählbare Vorhersageparameter, Satellit, Radar.
- **Wind-Höhenwahl im Meteogramm:** optionaler Selektor (z. B. 10 m / 50 /
  100 / 150 m) statt fest 10 m — falls doch gewünscht.
- **Echte Windbarbs** als Alternative zu den Richtungspfeilen.
- **Südhalbkugel:** Sichel-Orientierung der Mondscheibe spiegeln
  (aktuell NH-Konvention: zunehmend = rechts beleuchtet).
- **RH-Profil-Ceiling** (siehe oben).
