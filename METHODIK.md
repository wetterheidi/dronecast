# Methodik: abgeleitete Größen

DroneForecast zeigt neben rohen Modell-/Oberflächenwerten mehrere **abgeleitete
Größen** — Werte, die aus den Rohdaten berechnet statt direkt von der API
geliefert werden (Taupunkt, Wolkenbasis, Windmaximum im Band, die Go/No-Go-
Ampel selbst, …). Dieses Dokument erklärt für jede davon **die Formel, die
Annahmen dahinter und die bekannten Schwächen** — damit nachvollziehbar
bleibt, warum eine Zelle grün, gelb oder rot ist, auch wenn der Rohwert nicht
direkt sichtbar ist.

Reine Rohwerte (z. B. `temperature_2m`, `wind_gusts_10m`, `cloud_cover_low`)
sind hier nicht aufgeführt — die kommen unverändert von der Open-Meteo-API
(siehe [src/config.js](src/config.js) `SURFACE_CORE`/`SURFACE_OPTIONAL`).

---

## 1. Wind

### Wind auf Modell-Leveln
[src/windfield.js](src/windfield.js), `WindField.windAt()`. Dreifach
interpoliert:
- **horizontal:** bilinear über die vier umgebenden Gitterpunkte
  (`bilinearWeights`),
- **vertikal:** linear zwischen zwei benachbarten Modell-Leveln, gebrackt
  über die AGL-Höhe des Ziels (`heightBracket`) — unterhalb des untersten
  Levels (~10 m) wird auf dieses geklammert,
- **zeitlich:** linear zwischen zwei Stundenwerten (`timeWeights`).

u/v werden komponentenweise interpoliert, der Betrag erst danach gebildet
(`Math.hypot(u,v)`) — das ist der physikalisch korrekte Weg, nicht
Geschwindigkeit und Richtung getrennt zu mitteln.

### Böen
Es gibt **keine Böen auf Modell-Leveln** — das Modell liefert `wind_gusts_10m`
ausschließlich am Boden. Die App rechnet das **bewusst nicht** auf Flughöhe
hoch (kein validierter Böenfaktor verfügbar); die Böen-Zeile ist deshalb
überall explizit als „10 m" beschriftet. Siehe IDEEN.md, „Böen auf Flughöhe
hochrechnen" für die zurückgestellte Erweiterung.

### Windmaximum im Band (Go/No-Go: „Wind Maximum (10 m–Flughöhe)")
[src/app.js](src/app.js), `windBandMaxAt()`/`bandHeights()`. Kein exaktes
Profilmaximum, sondern ein **Stützstellen-Sampling**: 3–16 Höhen zwischen
10 m und der eingestellten Flughöhe (grob alle 50 m, siehe `bandHeights()`),
an jeder Stützhöhe `windAt()` ausgewertet, Maximum der Beträge genommen. Da
das `WindField` am Operationspunkt bereits vollständig gecacht ist (alle
benötigten Level wurden beim Laden der Vorhersage geholt), kostet das keine
zusätzlichen Netzwerk-Requests — nur Interpolation. Bei stark
nicht-monotonen Profilen (z. B. sehr schmale Low-Level-Jets) kann das
Sampling ein schmales Maximum zwischen zwei Stützhöhen verpassen.

---

## 2. Taupunkt

[src/windfield.js](src/windfield.js), `dewpointC()`. Primär aus dem
Dampfdruck `e = q·p / (0.622 + 0.378·q)` (spezifische Feuchte `q` + Druck
`p`), Magnus-Formel nach `Td` aufgelöst:
`Td = 243.12·ln(e/611.2) / (17.62 − ln(e/611.2))`. Fallback über relative
Feuchte + Temperatur, falls `q`/`p` an einem Rechenpunkt fehlen.

**Bewusst nicht** die API-eigene `dew_point_2m`-Variable am Modell-Level
verwendet: die nutzt bei `T < 0 °C` Sättigung über Eis statt über Wasser —
das würde bei Unterkühlung/Vereisungsbetrachtung zu einem Taupunkt führen,
der nicht zur hier verwendeten Wasser-Magnus-Formel passt (Inkonsistenz
zwischen Boden- und Level-Werten).

---

## 3. Potentielle Temperatur

[src/windfield.js](src/windfield.js), `theta()`:
`θ = T_K · (1000 / p_hPa)^κ` mit `κ = R/c_p ≈ 0,2854` (trockene Luft).
Wird für isentrope Zielflächen bei Trajektorien gebraucht (`vmotion:
"theta"`), aktuell **nicht** im Meteogramm oder in der Go/No-Go-Tabelle
verwendet, aber Teil derselben Datenkette (`needs.t`/`needs.p` in
`WindField.init()`).

---

## 4. Wolkenbasis / Ceiling

Mehrstufiger Ansatz, drei Signale kombiniert statt eines:

### 4.1 LCL nach Espy (Basisschätzung)
[src/clouds.js](src/clouds.js), `cloudBaseAgl()`:
`Basis ≈ 125 · (T₂ₘ − Td₂ₘ)` m AGL — nur wenn `cloud_cover_low ≥ 25 %`
(sonst `null`, keine relevante tiefe Bewölkung). Espy ist eine
**Bodenpaket-Näherung**: gut für konvektive Quellwolken (Cumulus), die aus
einem aufsteigenden Bodenpaket entstehen; **ungenau für Schichtwolken**
(Stratus) oder Advektionsnebel, die nicht aus lokaler Konvektion stammen.

### 4.2 RH-Profil-Kandidat (Höhen-Verfeinerung)
[src/column.js](src/column.js), `lowestSaturatedHeight(col, i, rhThreshold=85,
capM=2500)`: unterste Höhe (zwischen zwei Modell-Leveln linear
interpoliert), an der die relative Feuchte die Schwelle **85 %** erreicht —
begrenzt auf das „Low-Band" bis 2500 m AGL, damit nicht versehentlich eine
Mittel-/Hochwolke als tiefe Basis gemeldet wird. `null`, wenn im Band nichts
Gesättigtes liegt.

**Die 85-%-Schwelle ist ein ungeprüfter Platzhalter**, nicht modellspezifisch
kalibriert (ICON-D2 vs. ICON-EU können unterschiedliche RH-Charakteristik
haben). METAR-Referenz für die grobe Einordnung: SKC 0/8 · FEW 1–2/8 ·
SCT 3–4/8 · BKN 5–7/8 · OVC 8/8.

### 4.3 Kombination
[src/clouds.js](src/clouds.js), `refineCloudBase()`:
- `cloud_cover_low` bleibt der **Trigger** — das Wolkenschema des Modells
  fängt Subskalen-Effekte ab, die eine reine RH-Schwelle verpassen würde.
- Existiert ein RH-Kandidat (4.2), **ersetzt dessen Höhe die LCL-Schätzung**
  (4.1); sonst bleibt die LCL-Schätzung als Fallback.
- `confident: true` **nur wenn beide Signale übereinstimmen**
  (`cloud_cover_low > 50 %` **und** ein RH-Kandidat existiert) — im
  Meteogramm: durchgezogene Linie bei hoher Konfidenz, gestrichelt bei nur
  einem Signal.

Verwendet in `openMeteogram()` ([src/app.js](src/app.js)): lädt dafür beim
ersten Öffnen die volle Modell-Säule nach (`ensureColumn()`, dieselbe Quelle
wie Cross-Section/Briefing) — schlägt das fehl, fällt das Panel sauber auf
die reine LCL-Schätzung (4.1) zurück.

**Aktuell nicht** in die Go/No-Go-Tabelle eingeflossen — die `cloudBase`-
Zeile dort nutzt weiterhin nur die reine LCL-Schätzung (4.1). Siehe
IDEEN.md, „Go/No-Go-Tabelle: Ausbaustufe 2" für die offene Diskussion, wie
Bedeckungsgrad, Sicht und `weather_code` dort zusätzlich einfließen sollen.

### 4.4 Wolkenfraktion (nur Cross-Section-Heatmap — andere Verwendung!)
[src/column.js](src/column.js), `cloudFrac(rh)`: `< 65 %` → 0 (frei),
`65–85 %` → linear 0…0,5 (FEW/SCT), `85–100 %` → linear 0,5…1,0 (BKN/OVC).
**Reine Visualisierungsheuristik** für die Bewölkungs-Heatmap der
Cross-Section — anders als 4.1–4.3 keine „Basishöhe", sondern ein
kontinuierlicher Bedeckungsgrad je Höhenband. Nicht Teil der
Meteogramm- oder Go/No-Go-Bewertung.

---

## 5. Nullgradgrenze

Zwei unabhängige, aktuell **nicht querverglichene** Quellen:
- **Cross-Section:** [src/column.js](src/column.js), `zeroCrossing()` —
  unterster Level-Übergang `T ≥ 0 °C → T < 0 °C` von unten nach oben, linear
  zwischen den beiden Leveln interpoliert.
- **„Aktuell"-Panel:** die API-eigene Oberflächenvariable
  `freezing_level_height` (optional, modellabhängig verfügbar), unverändert
  übernommen.

Beide sollten in der Praxis nah beieinanderliegen, sind aber technisch
unabhängig berechnet (unterschiedliche Modell-Ausgabewege).

---

## 6. Go/No-Go-Bewertung

[src/gonogo.js](src/gonogo.js). Bewertet jeden Parameter unabhängig gegen ein
[src/droneProfiles.js](src/droneProfiles.js)-Profil, dann eine
Gesamtaussage pro Stunde.

### 6.1 Schwellenwert-Logik (`evalThreshold`)
Jeder Grenzwert hat eine Richtung:
- **`max`** (z. B. Wind, Böen, Niederschlag): **rot** ab `value ≥ limit`;
  **gelb** ab `value ≥ limit · (1 − marginPct)`; sonst **grün**.
- **`min`** (z. B. Sicht, Wolkenbasis): spiegelbildlich mit `≤` und
  `(1 + marginPct)`.

`marginPct` ist der **prozentuale Sicherheitsabstand**, der die Gelb-Zone
definiert — pro Parameter im Profil überschreibbar, sonst gilt
`profile.marginPct` als Default (aktuell 20 % im Platzhalterprofil).

### 6.2 Fehlende Daten (`"na"`)
Ein `null`/`NaN`-Rohwert wird als eigener Status **`"na"`** geführt, **nie**
stillschweigend als grün gewertet (Sicherheitsprinzip: fehlende Daten dürfen
keine Go-Entscheidung vortäuschen). Einzige Ausnahme:
`cloudBase` bei fehlendem Trigger (`cloud_cover_low < 25 %`, also `null` von
`cloudBaseAgl()`) — das ist **kein fehlender Messwert**, sondern die
Aussage „keine relevante tiefe Bewölkung", also tatsächlich grün.

### 6.3 Gesamtbewertung (`conclusionAt`)
Priorität über alle Zeilen einer Stunde: **rot > „keine Daten" > gelb >
grün.** Die erste Zeile mit dem höchstrangigen Status wird als
„begrenzender Faktor" im Tooltip der Bewertungszeile angezeigt
(`limitingId`).

### 6.4 Werte mit zwei Grenzen (`rangeRow`, z. B. Temperatur)
Ein Messwert kann gegen **zwei** Grenzen geprüft werden (Min **und** Max,
z. B. Batterie-Kältegrenze und Überhitzungsgrenze). Angezeigt wird **eine**
Zeile mit dem tatsächlichen Stundenwert; die Farbe ist der strengere
(`worseStatus`) der beiden Einzelbewertungen — statt zwei redundanter
Zeilen für denselben Messwert.

### 6.5 Wolkenbasis-Limit
Die effektive Grenze ist `max(Profil-Minimum, Flughöhe)`
(`scaledMinLimit()`): die Basis muss **sowohl** über der geplanten Flughöhe
**als auch** über einem profilspezifischen VLOS-Mindestwert liegen — der
strengere der beiden Werte gewinnt.

### 6.6 Hazard-Zeile (kategorial, keine Schwelle)
Aus `weather_code` (`hazardRow()`), ohne numerischen Grenzwert:
- `95/96/99` (Gewitter) → **rot**,
- `56/57/66/67` (gefrierender Niederschlag) → **rot**,
- `45/48` (Nebel) → **gelb**, aber **nur wenn** `visibility` an diesem
  Zeitpunkt fehlt (liefert das Modell einen Sichtwert, deckt die
  Sicht-Zeile die Lage bereits numerisch ab — keine doppelte Bewertung),
- sonst **grün** (kein Hazard-Code).

---

## Bekannte Näherungen — Kurzübersicht

Ausführliche Diskussion und geplante Verfeinerungen stehen in
[IDEEN.md](IDEEN.md); hier nur die Liste der Stellen, an denen eine
vereinfachende Annahme steckt:

| Größe | Annahme/Schwäche |
|---|---|
| LCL (4.1) | Bodenpaket-Näherung, ungenau bei Schichtwolken |
| RH-Ceiling-Schwelle (4.2) | 85 % ungeprüft, nicht modellkalibriert |
| Wind-Bandmaximum (1) | Stützstellen-Sampling, kein exaktes Profilmaximum |
| Böen (1) | nur am Boden, keine Hochrechnung auf Flughöhe |
| Go/No-Go-Schwellenwerte | Platzhalterprofil, keine geprüften Herstellerwerte |
| Go/No-Go Wolkenbasis-Zeile | nutzt noch reine LCL, nicht die RH-Verfeinerung |
| Vereisung, Turbulenz | in der Go/No-Go-Tabelle noch nicht abgebildet |
