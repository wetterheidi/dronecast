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

**Status:** Vereisung + Turbulenz **gebaut** — allerdings nicht in der
Wind-/Temperatur-Cross-Section wie hier ursprünglich skizziert, sondern im
GRAMET-Meteogramm ([src/gramet/](src/gramet/), Konturflächen +
WMO-nahe Symbole, s. METHODIK.md 7.6/7.7). Reine Windscherung (ohne
Richtungsscherung, als eigenständige Zone unabhängig von Ri) ist weiterhin
offen.

Ursprüngliche Idee: kritische Zonen als Overlay (schraffiert/umrandet) über
die Cross-Section legen, aus den vorhandenen Modell-Level-Daten
diagnostiziert:

- **Vereisung:** Zonen mit `0 °C … −15 °C` **und** hoher Feuchte / in Wolke
  (RH ≥ ~90 %). Klassisches Struktureis-Fenster. (Vgl. „atmospheric ice
  growth" im Beispiel-Screenshot.) → gebaut als Icing-Potential-Index,
  METHODIK.md 7.6.
- **Windscherung:** Betrag des vertikalen Windgradienten `|dV/dz|` zwischen
  benachbarten Leveln; v. a. bodennah (Low-Level-Windshear) drohnenrelevant.
  Auch Richtungsscherung (Drehung mit der Höhe) erfassen. → **weiterhin
  offen** als eigene Cross-Section-Größe; der Scherungsbetrag steckt zwar im
  Turbulenz-Index (unten), aber nur als Gate, nicht als eigene sichtbare
  Größe, und Richtungsscherung fließt gar nicht ein.
- **Turbulenz:** Proxy aus Scherung + statischer Stabilität (Richardson-Zahl
  `Ri = (g/θ)(dθ/dz) / (dV/dz)²`; kleine Ri → turbulent), alternativ
  einfacher Scherungs-/Böigkeits-Proxy. → gebaut als Turbulence-Flag-Index
  (TFI), METHODIK.md 7.7 — inkl. bekannter Grenzen (kein Befund bei
  Feuchtlabilität/Konvektion, Onset- statt Intensitätskriterium, s. dort).

## Jet-/Höhen-Turbulenz (CAT) über Ellrod TI1

**Status:** vorgemerkt (nur diskutiert) · **Auslöser:** Vergleich mit der
Turbulenzmethode aus Ogimets GRAMET (`E = (5·HWS + VWS² + 42)/4`) im
Gespräch — Ergebnis: Ogimets Formel selbst nicht übernehmenswert (unerklärte
Fit-Konstante „+42", an Cruise-Level-PIREPs kalibriert, kein Stabilitätsterm),
aber der **Ansatzpunkt ist real**: der bestehende TFI ([turbulence.js](src/gramet/hazards/turbulence.js),
METHODIK.md 7.7) ist Ri-/KH-Instabilität-basiert und dafür für das Flugband
(10 m – Betriebshöhe) richtig aufgestellt, aber **strukturell blind für
Jet-Turbulenz**: nahe der Tropopause ist die Schichtung meist so stabil
(großes N²), dass Ri trotz kräftiger Scherung nicht unter 0,25 fällt, obwohl
Deformation/Frontogenese an Jet-Streaks real Turbulenz erzeugt. Genau deshalb
wurde historisch der Ellrod-TI (Ellrod & Knapp 1992) als Ergänzung zu reinen
Ri-Diagnosen entwickelt — nicht nur eine andere Formel, sondern ein anderer
Mechanismus (Deformation/Frontogenese statt Kelvin-Helmholtz-Scherinstabilität).

### Architektur-Hürde: keine horizontalen Nachbarpunkte in der GRAMET-Säule
`fetchGrid(lat, lon, …)` ([grid.js](src/gramet/grid.js)) ist eine Säule an
**einem festen Punkt** über die Zeit (kein Routenschnitt) — Ellrod-TI braucht
aber horizontale Ableitungen (`∂u/∂x, ∂u/∂y, ∂v/∂x, ∂v/∂y`), die aus einer
Einzelsäule grundsätzlich nicht herleitbar sind, unabhängig von der Formel.
Vermutlich bildet Ogimets HWS genau das entlang der (dort vorhandenen)
Flugroute — ein Weg, der uns mangels Routenschnitt nicht offensteht.

**Lösung liegt aber schon im Code:** [windfield.js](src/windfield.js)
(`WindField`) fetcht/interpoliert bereits horizontale Gitterpunkte bilinear
für das Wind-Overlay — dieselbe Mechanik kann ein kleines Stützpunkt-Kreuz
(4 Nachbarn im Modellgitterabstand) um den Operationspunkt liefern, aus dem
sich Streckungs-/Scherungsdeformation (`Def = √(D_st² + D_sh²)`) bilden lässt.
Kein Neubau, aber ein echter Zusatz-Request (Kosten/Latenz) pro Level/Zeit.

### Vorschlag (Umriss, Details bei Umsetzung ausarbeiten)
- **Ellrod TI1 = Def · |dV/dz|** (Deformation × vertikale Scherung, `|dV/dz|`
  aus `shear2` in [grid.js](src/gramet/grid.js) schon vorhanden) als
  **eigenständiges** Onset-Kriterium, NICHT in die TFI-Formel gemischt
  (`max(TFI, TI1-Flag)` pro Schicht) — hält beide Mechanismen einzeln
  nachvollziehbar/debugbar, analog zum bestehenden Muster getrennter Gates.
- **Nur oberhalb der Grenzschicht rechnen** (grob ab ~500 hPa) — begrenzt den
  Zusatz-Request auf die paar Level, wo Jet-CAT überhaupt relevant ist, lässt
  den drohnenrelevanten Teil der Säule unangetastet.
- **Eigene Zeile/Legende** („Jet-/Höhen-CAT"), nicht stillschweigend in den
  TFI eingerechnet — sonst verwischt die saubere Trennung
  „Flugband-Turbulenz (Drohne)" vs. „Jet-CAT (Kontext, nicht drohnenrelevant,
  aber für Gesamtbild/bemannte Luftfahrt in der Nähe sinnvoll)".
- **Schwellen aus Ellrod & Knapp (1992) übernehmen** — beim Umsetzen im
  Originalpaper nachschlagen und mit Quelle in METHODIK.md dokumentieren,
  NICHT aus der Erinnerung schätzen (gleiches Prinzip wie bei den anderen
  unkalibrierten Schwellen im Projekt).

### Synergie mit „Karte: NWP-Modellgitter als Layer" (oben)
Im Gespräch aufgeworfen: eine spätere flächige Turbulenz-/CAT-Karte (Ausbau
des dort skizzierten NWP-Layers) bräuchte dieselbe
Deformationsberechnung — nur flächig über ein Gitter statt an einem
Operationspunkt extrahiert. Beide Verbraucher (GRAMET-Jet-CAT-Zeile und
künftiger Karten-Layer) sollten sich **ein** Deformationsmodul auf Basis von
`WindField` teilen, statt die Stützpunkt-Logik zweimal zu bauen — beim
tatsächlichen Bau eines der beiden zuerst entscheiden, ob sich die
Extraktion (Punkt) von der Rasterung (Fläche) sauber genug trennen lässt, um
das Modul wirklich gemeinsam zu nutzen.

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
**Gebaut**, s. METHODIK.md 6.7 (`icingRow()`) — Bandmaximum des Icing-
Potential-Index zwischen 10 m und Flughöhe, mit Höhenband als Subtext.
Schwellenkalibrierung weiterhin offen (nie geprüfte Referenzfälle, s.
„Bekannte Näherungen" in METHODIK.md).

### Turbulenz als eigene Zeile
**Gebaut**, s. METHODIK.md 6.8 (`turbulenceRow()`) — Bandmaximum des
Turbulence-Flag-Index (TFI), analog Vereisung, aber über die echten
Modellschichten statt Stützstellen-Sampling reduziert.

**Windstärke-Gate (2026-08-04 nachgerüstet):** ursprünglich erreichte der
TFI „severe" schon, sobald Ri knapp unter 0,25 UND die Scherung knapp über
0,05 s⁻¹ lag — unabhängig von der absoluten Windgeschwindigkeit. Bei einer
geprüften Vorhersage lag „severe" bodennah nachts bei durchweg ≤ 10 kt
Windgeschwindigkeit — plausibel als reines Scherungs-Onset-Signal
(Miles-Howard-Kriterium sagt nur, DASS sich Kelvin-Helmholtz-Wellen bilden
können, nichts über die resultierende Intensität/EDR), aber zu alarmierend
für die Kategorie „stark". Abhilfe: dritter Faktor `w(V)`
(mittlere Windgeschwindigkeit der Schicht), der NUR den Anteil oberhalb der
„moderate"-Schwelle kappt (`TFI = TFI_MODERATE + (raw − TFI_MODERATE) ·
w(V)`, s. METHODIK.md 7.7) — „moderate" bleibt bei Windstille erreichbar,
„severe" braucht zusätzlich ≥ 10 m/s. Schwellen (5/10 m/s) **ausdrücklich
ein erster Ansatz** ohne Referenzfälle, zur Nachjustierung vorgesehen,
sobald mehr Vorhersagen gegengeprüft sind.

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

## GRAMET als Web-Komponente (Ort/Zeit + Flugpfad)

**Status:** Grundgerüst für den Path-Modus gebaut, s. METHODIK.md 7.8 ·
**Motivation:** GRAMET ist inzwischen gut genug, um es auch außerhalb von
droneforecast einzubetten — als eigenständige Web-Komponente, die entweder
„Ort über Zeit" (wie heute) oder „Wetter entlang eines Flugpfads" zeigt, damit
z. B. die Schwester-App `trajectories` (nutzt dieselbe private Modell-Instanz,
s. `API_BASE` in [config.js](src/config.js)) sie für ihre berechneten
Trajektorien einsetzen kann.

**Bewusst begrenzter Umfang dieser Iteration:** nur Vorbereitung INNERHALB von
droneforecast — kein Custom-Element-Wrapper, keine Paket-Extraktion, keine
Änderungen an `trajectories`. Details/Datenmodell in METHODIK.md 7.8; hier nur
der Backlog-Blick, was als Nächstes drankäme:

**Gebaut (nachgerüstet):**
- Oberflächenwerte pro Wegpunkt — `path.js` ruft parallel zur Säule auch
  `fetchSurface()` je Wegpunkt auf, Böen/Sicht/SLP/Wettercode sind im
  Path-Modus damit genauso befüllt wie im Ort/Zeit-Modus.
- Sampling-Policy — `selectWaypointsToFetch()` nutzt jetzt die kombinierte
  Policy (Modell-Zeitauflösung ODER -Gitterweite, je nachdem was zuerst
  eintritt) statt der festen 12er-Platzhalterverteilung; feste Obergrenze
  bleibt nur noch als Notbremse für Extremfälle.
- Resampling auf feste Anzeige-Kadenz — neues
  [src/gramet/resample.js](src/gramet/resample.js), entkoppelt die
  (sparsame) Fetch-Dichte von einer frei wählbaren Anzeige-Dichte (z. B. alle
  10 Minuten), räumlich+zeitlich interpoliert zwischen den echten
  Wegpunkten. Oberflächenwerte werden dabei bewusst NICHT interpoliert
  (nächster Wegpunkt reicht, s. METHODIK.md 7.8).
- `sliceColumnAtTime()` interpoliert jetzt echt zwischen den Modellstunden
  statt nur zu runden — Nebeneffekt der Resampling-Arbeit, kommt auch den
  normalen Anker-Spalten zugute.
- Terrain-Profil (Mapterhorn) — [src/gramet/terrain.js](src/gramet/terrain.js)
  + [src/gramet/terrainTileCache.js](src/gramet/terrainTileCache.js), echtes
  Gelände entlang des Pfads (fester Zoom 12), IndexedDB-Kachelcache,
  Untergrund-Maskierung + terrainfolgende AGL-Deckellinie in der Haupttafel.
  Alle Details in METHODIK.md 7.9.

Alle Details in METHODIK.md 7.8/7.9.

- **Web-Component-Wrapper:** `renderGramet(host, grid, view, state)` nimmt
  bereits einen Host-Container statt fest ins droneforecast-DOM zu greifen —
  gute Ausgangsbasis. Offen: eigenes npm-Paket vs. Git-Submodule vs. Copy für
  die tatsächliche Verteilung an `trajectories`, Shadow-DOM-Kapselung fürs
  Styling, Custom-Element-Boilerplate (`<gramet-chart>` o. Ä.).
- **Terrain: regionale Feinauflösung (z13-17):** aktuell fester Zoom 12
  (weltweit verfügbar, s. METHODIK.md 7.9); Mapterhorn bietet für ausgewählte
  Gebiete deutlich feinere Kacheln (z. B. Schweiz swissALTI3D 0,5 m) — bei
  Bedarf später als adaptiver Zoom je nach Abdeckung nachrüstbar.
- **Gemeinsame Datenschicht mit `trajectories`:** `config.js` (`API_BASE`,
  `MODELS` inkl. Bbox) ist zwischen droneforecast und `trajectories` bereits
  identisch dupliziert — sollte langfristig EIN gemeinsames Modul werden,
  sobald die tatsächliche Extraktion ansteht (bewusst nicht Teil dieser
  Iteration, s. o.).
- **Datenquelle bei Einbettung:** GRAMET fetcht weiterhin selbst von der
  privaten Modell-Instanz (Entscheidung: kein reiner Renderer, der nur fertige
  Daten entgegennimmt) — das reicht, solange alle einbettenden Apps dieselbe
  Instanz mit Erlaubnis nutzen dürfen, wie aktuell der Fall.

---

## Weitere Ideen (Kurzliste)

- **Wind-Höhenwahl im Meteogramm:** optionaler Selektor (z. B. 10 m / 50 /
  100 / 150 m) statt fest 10 m — falls doch gewünscht.
- **Echte Windbarbs** als Alternative zu den Richtungspfeilen.
- **Südhalbkugel:** Sichel-Orientierung der Mondscheibe spiegeln
  (aktuell NH-Konvention: zunehmend = rechts beleuchtet).
- **Andere Satellitenbildquelle weltweit:** Alternative: NASA GIBS  Falls du doch einmal eine globale Abdeckung benötigst, bietet die NASA mit den Global Imagery Browse Services (GIBS) ebenfalls einen hervorragenden, kostenfreien WMS/WMTS. NASA GIBS integriert die europäischen Meteosat-Daten in ihre globalen Karten. Die Latenz ist dort mit ca. 30 Minuten minimal höher als direkt bei EUMETSAT, dafür lassen sich die Kacheln besonders performant als standardmäßiges WMTS-Overlay laden.
- **Terrain-Alternativquelle geprüft: AWS Open Data Terrain Tiles**
  (`registry.opendata.aws/terrain-tiles`, ehem. Mapzen/Joerd) — statischer
  S3-Bucket, kein Auth/Rate-Limit, sehr robust (AWS-S3-Grade), aber Datenstand
  seit ~2018 eingefroren (kein aktives Fixing mehr) und im Kern nur SRTM
  30 m mit bekannten Voids im Hochgebirge — genau dort, wo unsere
  GRAMET-Pfade meist liegen. Ergebnis: **Mapterhorn bleibt Primärquelle**
  (aktueller gepflegt, regional viel höhere Auflösung, s. o. „Terrain:
  regionale Feinauflösung"); AWS/Joerd höchstens als Fallback bei
  Mapterhorn-Ausfall denkbar, dann mit Hinweis auf spürbar gröbere Auflösung
  im UI (analog [[feedback_document_derived_values]]).  