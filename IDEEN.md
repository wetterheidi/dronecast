# Ideen & Erweiterungen (Backlog)

Sammlung möglicher Verbesserungen für spätere Ausbaustufen. Kein Zwang zur
Reihenfolge — hier landet, was uns beim Bauen als „später mal" auffällt.

Wie die bereits gebauten abgeleiteten Größen (LCL, RH-Ceiling, Go/No-Go-
Schwellenwertlogik, …) genau funktionieren, steht in [METHODIK.md](METHODIK.md)
— hier geht es nur um das, was noch offen ist.

---

## Wolkenbasis: Ceiling-Höhe aus dem Modell-RH-Profil

**Status:** **gebaut & abgelöst durch die gemeinsame CF-Kurve** — die frühere
Einzellösung (`lowestSaturatedHeight` mit fester 85-%-Schwelle) ist ersetzt
durch `cloudCeiling(col, i)` in [src/clouds.js](src/clouds.js), das denselben
Sundqvist-CF nutzt wie Cross-Section und Briefing (siehe Abschnitt
„Wolkenfraktion" unten und [METHODIK.md](METHODIK.md) Abschnitt 4). Verdrahtet
im Meteogramm (`refineCloudBase`, [src/app.js](src/app.js) `openMeteogram`)
**und** in der Go/No-Go-Tabelle (`cloudBase`-Zeile über `cloudCeilingArr`).

**Politik-Änderung:** `cloud_cover_low` ist **nicht mehr Trigger**, sondern nur
noch Konfidenz-Signal (`> 50 %` → durchgezogene statt gestrichelter Linie im
Meteogramm) — die Höhe bestimmt das RH-Profil. **Zwei Ausgaben (ICAO-konform,
kein Höhen-Cutoff):** `cloudCeiling` = unterste Höhe mit `CF ≥ 0.5` (BKN) im
gesamten Profil; `lowestCloudBase` = unterste markante Schicht (`CF ≥ 0.10`).
LCL bleibt reiner Fallback, wenn keine Säule geladen ist.

**Noch offen:** das **numerische Kartenprodukt** (Ceiling je Gitterpunkt) —
bewusst zuletzt, weil es eine Säule PRO Zelle braucht (viele Open-Meteo-
Requests, 429-Risiko wie in Commit `721b956`) und auf der noch zurückgestellten
NWP-Layer-Infra aufsetzt (siehe „Karte: NWP-Modellgitter als Layer" unten).
Realistisch: grobes Gitter, On-Demand, Batching/Rate-Limit.

### Ursprüngliche Skizze (Referenz)
Drei unabhängige Signale:

| Signal | sagt uns | Schwäche |
|---|---|---|
| `cloud_cover_low` (Oberfläche) | **ob** tiefe Wolke da ist | keine Höhe |
| LCL = 125·Spread | **Höhe** einer Basis | nur Bodenpaket |
| Modell-RH-Profil (Michael, Level) | Höhe der **gesättigten** Schicht | RH-Schwellen modellabhängig |

RH→Wolkenmengen-Heuristik: `RH < 65 %` → SKC (frei) · `65–85 %` → FEW/SCT ·
`≥ 85 %` → BKN (Ceiling-Kandidat) · `≈ 100 %` → OVC. RH-Schwellen ggf. je
Modell (ICON-D2 vs ICON-EU) noch kalibrieren — bislang ungeprüfter
Platzhalter (85 %). METAR-Achtel als Referenz: SKC 0 · FEW 1–2 · SCT 3–4 ·
BKN 5–7 · OVC 8.

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

**Noch offen (Ausbau):** Import-Vorschau/Konfliktdialog statt stillem Anhängen;
Bearbeiten von Richtung/Einheit je Parameter (bewusst fix gelassen);
Cloud-/Geräte-Sync (localStorage ist nur pro Browser).

## Karte: NWP-Modellgitter als Layer (Wind/Temp/Wolken/Ceiling)

**Status:** zurückgestellt (Phase 2) · **Voraussetzung:** [src/maplayers.js](src/maplayers.js)
(Satellit/Radar, Phase 1) ist gebaut und dient als Andockpunkt.

### Idee
Weitere Kartenlayer aus den ohnehin vorhandenen Modell-Level-Daten (u/v, T,
RH, Bewölkung, …) — z. B. Windgeschwindigkeit/-richtung, Temperatur, Wolken
oder Ceiling auf wählbarer Flughöhe, ggf. für mehrere Modelle (ICON-D2 vs.
ICON-EU). Anders als Satellit/Radar (extern, fertige Kacheln) müssten diese
Layer aus den eigenen Open-Meteo-Abfragen gerastert/gezeichnet werden
(Canvas- oder Vektor-Overlay statt XYZ-Tiles).

### Andockpunkt (aus Phase 1 bewusst so gebaut)
`initMapLayers(map)` in [src/maplayers.js](src/maplayers.js) legt bereits
einen eigenen Leaflet-Pane (`wxOverlays`, zIndex 350, zwischen `tilePane`
und `overlayPane`) für Wetter-Overlays an; Satellit/Radar nutzen darin
`zIndex: 10`/`20`. Neue NWP-Layer sollten in denselben Pane mit einem dazu
konsistenten `zIndex` eingehängt werden, statt eine neue Pane-Strategie zu
erfinden. Persistenz folgt demselben Muster wie `satLayerOn`/`radarLayerOn`
in [src/settings.js](src/settings.js) (neue `DEFAULTS`-Keys, kein Rewrite
nötig). Bewusst kein generisches Plugin-System für Phase 1 gebaut — erst
beim tatsächlichen Bau eines zweiten/dritten NWP-Layer-Typs entscheiden, ob
sich ein Registrierungsmuster lohnt.

---

## Nowcasting: Blitz-/Gewitterwarnung im Radius

**Status:** vorgemerkt (nur diskutiert, realisierbar bestätigt) · **Rubrik:**
Nowcasting-Layer · **Kontext geklärt:** App ist **rein nicht-kommerziell** und
**reiner Client** (kein Backend) — das rahmt alle Optionen unten ein.

### Ziel
Warnhinweis für den Nutzer, wenn innerhalb eines voreingestellten Radius
(10 / 20 km, konfigurierbar) **tatsächlich detektierte** Blitze auftraten.
Sicherheitskritisch für Drohnenbetrieb, hartes Kriterium (kaum Graustufen).

### Beobachtung ≠ Vorhersage (zwei verschiedene Features)
- **Detektierte Blitze (Nowcast)** = gemessene Entladungen → *das* ist der
  Radius-Warnhinweis. Braucht echte Detektionsdaten, die **Open-Meteo nicht
  liefert**.
- **Gewitterpotenzial (Forecast)** = CAPE, Lifted Index, `lightning_potential`
  aus Open-Meteo → *vorausschauende* Warnung, aber keine Echtzeit-Detektion.
  Könnte später als **ergänzende** Vorhersage danebenstehen (schnell machbar,
  keine neue Quelle).

### Datenquelle: Blitzortung.org (der gangbare Weg)
Bei nicht-kommerziell lizenzrechtlich sauber (Attribution Pflicht:
„Blitzdaten © Blitzortung.org & Mitwirkende"; keine Weiterverbreitung der
Rohdaten). Kommerzielle Alternativen wären Météorage / nowcast GmbH
(kostenpflichtig), NOAA GOES-GLM (nur Amerika), DWD (teils lizenziert) — hier
nicht relevant.

**Client-only möglich, weil WebSockets keinem CORS-Preflight unterliegen:**
- WebSocket-Server `ws1..ws8.blitzortung.org` (Community-reverse-engineered,
  dieselbe Quelle wie lightningmaps.org). Init-JSON senden, dann Event-Stream
  `{time, lat, lon, …}`.
- **Haken 1 – Dekompression:** Payload mit eigenem LZW-artigem Verfahren
  gepackt → kleiner Decoder nötig (bekanntes Community-Snippet, ~30 Zeilen).
- **Haken 2 – Fragilität:** undokumentiert, kann sich ohne Vorwarnung ändern.
  Für ein sicherheitsrelevantes Feature → robuste Fehlerbehandlung +
  expliziter „Datenquelle nicht verfügbar"-Zustand sind **Pflicht**.
- **Haken 3 – globaler Stream:** Feed liefert weltweite Blitze → sofort
  clientseitig auf Bounding-Box um Nutzerstandort (± ~0,3°) filtern.
- **Persistenz-Grenze:** WebSocket lebt nur bei offener Seite → nur Warnung
  *während aktiver Nutzung*, keine Hintergrund-Push. Für Vor-Ort-Check vor
  dem Start genau richtig; echte Push bräuchte Backend + Service Worker.

### Architektur-Skizze (client-only)
```
Nowcasting-Layer „Blitze"
 ├─ LightningService (WebSocket-Wrapper)
 │   ├─ connect() → ws{1..8}, Reconnect-Logik
 │   ├─ decode()  → LZW-Decoder
 │   ├─ Bounding-Box-Filter (Nutzerpos ± ~0.3°)
 │   └─ Ringpuffer: Blitze der letzten 30 min, ältere verwerfen
 ├─ Warnlogik
 │   ├─ Haversine(Nutzer, Blitz) ≤ R
 │   ├─ Stufen: <10 km rot · 10–20 km gelb · >20 km grün
 │   └─ Zeitfenster (letzte 15/30 min; vgl. 30/30-Regel Luftfahrt)
 └─ Leaflet-Layer: Blitz-Marker + Radius-Kreise + Warn-Badge
```
Dockt an vorhandenes Leaflet-Setup an (Repo nutzt `leaflet-rotate`); der
Overlay-Pane `wxOverlays` aus [src/maplayers.js](src/maplayers.js) ist der
naheliegende Andockpunkt, Persistenz analog `satLayerOn`/`radarLayerOn` in
[src/settings.js](src/settings.js).

### Zwingend
- **Disclaimer** bei Rot/„nicht fliegen": ohne Gewähr, keine amtliche Quelle,
  Sichtbeobachtung geht vor; Blitzortung ist Community-Netz mit variabler
  Detektionseffizienz.
- **Attribution** sichtbar (s. o.).

### Vorgehen (Vorschlag)
Direkt Stufe 1 (echte Detektion), da Client-only offen. Optional vorab ein
kleiner Proof-of-Concept (nur Verbindung + Roh-Events in der Konsole), um die
WebSocket-Fragilität abzusichern, bevor Feature-Arbeit investiert wird. CAPE-
Vorhersage als spätere Ergänzung, nicht als Vorstufe nötig.

---

## Weitere Ideen (Kurzliste)

- **Wind-Höhenwahl im Meteogramm:** optionaler Selektor (z. B. 10 m / 50 /
  100 / 150 m) statt fest 10 m — falls doch gewünscht.
- **Echte Windbarbs** als Alternative zu den Richtungspfeilen.
- **Südhalbkugel:** Sichel-Orientierung der Mondscheibe spiegeln
  (aktuell NH-Konvention: zunehmend = rechts beleuchtet).
- **Andere Satellitenbildquelle weltweit:** Alternative: NASA GIBS  Falls du doch einmal eine globale Abdeckung benötigst, bietet die NASA mit den Global Imagery Browse Services (GIBS) ebenfalls einen hervorragenden, kostenfreien WMS/WMTS. NASA GIBS integriert die europäischen Meteosat-Daten in ihre globalen Karten. Die Latenz ist dort mit ca. 30 Minuten minimal höher als direkt bei EUMETSAT, dafür lassen sich die Kacheln besonders performant als standardmäßiges WMTS-Overlay laden.  