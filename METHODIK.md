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

## 4. Wolkenbasis / Ceiling / Wolkenschichten

**Eine gemeinsame Kurve für alles.** [src/clouds.js](src/clouds.js) ist die
Single Source of Truth: aus dem Modell-RH-Profil (native Level von Michael)
wird EINE höhenabhängige Wolkenfraktion abgeleitet, aus der sich Cross-Section,
Meteogramm-Ceiling, Go/No-Go-Tabelle und Briefing-METAR speisen — statt der
früheren drei getrennten, festen RH-Schwellen.

### 4.1 Wolkenfraktion: Eis-Korrektur + höhen-/windabhängige kritische Feuchte
`cloudFraction(rhW, T, z, w)`. Vier Schritte je Level:

**(a) Feuchte-Referenz aus q_v (Eis-Korrektur, ohne Annahme).** Basis ist die
**spezifische Feuchte** `q_v` (prognostisch, `specific_humidity_level{l}`, g/kg):
`vaporPressure()` rechnet den Dampfdruck `e = q·p/(ε + q(1−ε))`, `effectiveRH()`
bezieht ihn über die Mischphase auf einen geblendeten Sättigungsdampfdruck
(Wasser→Eis, `iceFraction()` linearer Ramp 0…−35 °C, darunter reines Eis).
Wirkung: bei −20 °C liefert schon geringe Feuchte Eissättigung — **macht Cirren
sichtbar**. Fehlt `q`, Rückfall auf die modellseitige RH **roh** (kein Boost).

*Warum q_v statt Modell-RH:* Direktvergleich an Michaels Instanz zeigte, dass
die Modell-`relative_humidity` unter 0 °C **bereits über Eis** referenziert ist
(z. B. −22 °C: RH_model 61 % = RH_i, nicht RH_w 49 %). Die Feuchte aus `q_v`
selbst zu rechnen vermeidet die dadurch drohende **Doppelkorrektur** und braucht
keine Referenz-Annahme mehr. Sättigungsdrücke via Magnus/WMO (Wasser & Eis).

**(b) Kritische Feuchte `criticalRH(z, T, w)`.** Wolke bildet sich ab `RH_crit`,
nicht erst bei Sättigung — in der Grenzschicht niedriger, frei höher:
`72 %` (Boden) → `85 %` (ab 1500 m). Im Eisast (α = `iceFraction`) auf `~72 %`
**eis-referenziert** abgesenkt (folgt der Nullgradgrenze, nicht einer festen
Höhe). **Vertikalwind** `w` (m/s, nativ `wind_w_level{l}`): Aufwind senkt,
Absinken hebt `RH_crit` — `−CRIT_W_MAX · tanh(w / W_SCALE)`.

**(c) Sundqvist:** `CF = clamp(1 − √(max(0, (100 − RH_eff)/(100 − RH_crit))), 0, 1)`.

**Startkalibrierung** (benannte Konstanten in clouds.js): `RH_CRIT_SURF=72`,
`RH_CRIT_MID=85`, `RH_CRIT_Z_REF=1500`, `RH_CRIT_ICE=72`, `ICE_T_FULL=−35`;
w-Dynamik `W_SCALE=0.1 m/s`, `CRIT_W_MAX=8 %` (**Platzhalter**, w-Schwellen noch
zu kalibrieren). Noch nicht modellspezifisch geprüft (ICON-D2 vs. ICON-EU).

### 4.2 Bedeckungskategorien (Okta)
`oktaCategory(cf)` bildet CF auf METAR-nahe Stufen ab. **BKN beginnt bei
`CF = 0.5`** — dieselbe Schwelle, die die Ceiling-Definition nutzt:
`CF_FEW=0.10 · CF_SCT=0.25 · CF_BKN=0.50 · CF_OVC=0.90`. METAR-Referenz:
FEW 1–2/8 · SCT 3–4/8 · BKN 5–7/8 · OVC 8/8.

### 4.3 Ceiling / Wolkenuntergrenze (zwei Ausgaben, ICAO-konform)
Zwei getrennte Größen statt eines harten Höhen-Cutoffs:
- **`cloudCeiling(col, i, {ccLowPct})`** — operationelles Ceiling (ICAO):
  unterste Höhe im **gesamten** Profil mit `CF ≥ 0.5` (BKN/OVC), **kein**
  Höhen-Cutoff. Geht ins Meteogramm und in die Go/No-Go-Tabelle. `null`, wenn
  nirgends BKN erreicht wird.
- **`lowestCloudBase(col, i)`** — Untergrenze der untersten markanten Schicht
  (`CF ≥ 0.10`, auch FEW/SCT), fürs Situationsbild.

Beide über die CF-Kurve zwischen zwei Leveln interpoliert. `cloud_cover_low`
**gatet die Existenz NICHT** (anders als früher), sondern liefert nur die
**Konfidenz** (`> 50 %` → `confident: true`) — fängt Subskalen-Effekte ab, ohne
die Höhe zu diktieren.

**Meteogramm** (`refineCloudBase()`, verdrahtet in `openMeteogram()`,
[src/app.js](src/app.js)): liegt ein Modell-Ceiling vor, bestimmt DAS die Höhe
(durchgezogen bei hoher Konfidenz, gestrichelt sonst); fehlt es, Fallback auf
die LCL-Schätzung (4.5). Die Säule wird beim ersten Öffnen nachgeladen
(`ensureColumn()`) — schlägt das fehl, bleibt es sauber bei der LCL-Schätzung.

**Go/No-Go-Tabelle** (`evaluate(..., cloudCeilingArr)`,
[src/gonogo.js](src/gonogo.js)): die `cloudBase`-Zeile nutzt das Ceiling-Array
(in app.js aus der Säule vorberechnet, parallel zu `windBandMax`). Ist die
Säule nicht verfügbar, fällt die Zeile auf die LCL-Schätzung (4.5) zurück.

### 4.4 Wolkenschichten (Briefing, METAR-nah)
`cloudLayers(col, i, {capM=12000, maxLayers=4})`: liefert **alle** Schichten
(tief, mittelhoch, hoch) als `{baseM, cover, cf}` von unten nach oben — eine
Schicht ist ein zusammenhängender Levelblock mit `CF ≥ CF_FEW`, Basis =
interpolierte Höhe des Schwellenübergangs, Bedeckung = CF-Maximum im Block.
Bis 12 km (damit auch Cirrus erscheint), **ohne** den früheren „nur zunehmende
Bedeckung"-Filter (eine dünnere hohe Schicht über einer tieferen wird nicht
mehr verschluckt). Genutzt in der METAR-Zeile des Briefings
([src/briefing.js](src/briefing.js) `metarCloudsForHour`).

### 4.5 LCL nach Espy (Fallback)
`cloudBaseAgl()`: `Basis ≈ 125 · (T₂ₘ − Td₂ₘ)` m AGL — nur wenn
`cloud_cover_low ≥ 25 %`. Reine **Bodenpaket-Näherung** (gut für konvektive
Cumulus, ungenau für Schichtwolken/Advektionsnebel), dient nur noch als
Rückfall, wenn keine Modell-Säule vorliegt.

---

## 5. Nullgradgrenze

Zwei unabhängige Quellen mit **unterschiedlichem Bezugsniveau** — nicht
direkt vergleichbar, ohne die Geländehöhe (`surface.elevation`) einzurechnen:

- **„Aktuell"-Panel:** die API-eigene Oberflächenvariable
  `freezing_level_height` (optional, modellabhängig verfügbar), unverändert
  übernommen. **Bezugsniveau: AMSL** (Höhe über Meeresspiegel, so liefert
  Open-Meteo diese Variable) — Zeile ist entsprechend als „Nullgradgrenze
  (AMSL)" beschriftet ([src/app.js](src/app.js), `renderNow()`).
- **Cross-Section:** [src/column.js](src/column.js), `zeroCrossing()` —
  unterster Level-Übergang `T ≥ 0 °C → T < 0 °C` von unten nach oben, linear
  zwischen den beiden Leveln interpoliert. **Bezugsniveau: AGL**, da sie auf
  `height_agl_level{l}` rechnet (siehe `fetchColumn()`), passend zur
  AGL-Höhenachse der Cross-Section.

Umrechnung: `AMSL ≈ AGL + surface.elevation`. Beide Werte weichen also
**um die Modell-Geländehöhe am Punkt** voneinander ab — das ist kein
Rechenfehler, sondern unterschiedliche Referenzniveaus für dieselbe
physikalische Höhe. Aktuell wird das nicht automatisch umgerechnet oder
gegengeprüft; wer beide Werte vergleicht, muss die Geländehöhe manuell
berücksichtigen.

---

## 5b. Elevation: echtes Gelände vs. Modell-Orographie

Zwei unabhängige Quellen mit **unterschiedlicher Bedeutung von „elevation"**:

- **`surface.elevation`** ([src/weather.js](src/weather.js), `fetchSurface()`
  gegen `api.open-meteo.com`) ist die **echte Geländehöhe** aus einem
  90-m-Digital-Elevation-Model — unabhängig vom gewählten Modell und
  identisch zu Open-Meteos dedizierter Elevation-API. Wird im Status nach
  dem Laden als „Elevation" angezeigt ([src/app.js](src/app.js),
  `loadForecast()`).
- **`WindField`-internes `elevation`** ([src/windfield.js](src/windfield.js),
  `storePoint()`/`elevationAt()`, Daten von `open-meteo.mah.priv.at`) ist
  die **modelleigene, geglättete Orographie** des jeweiligen Gitters (ICON
  nutzt dafür ein SLEVE-geländefolgendes Koordinatensystem, siehe unten).

### Warum wir das NICHT ineinander umrechnen (Korrektur einer früheren Annahme)

Naheliegend wäre: „Wind auf 120 m AGL" einfach relativ zur **echten**
Geländehöhe anfragen (`mode: "amsl"`, Ziel = `surface.elevation + 120`)
statt relativ zur Modell-Orographie. **Das ist physikalisch falsch** und
wurde hier bewusst verworfen, nachdem wir es zunächst vorgeschlagen hatten:

Das unterste Modell-Level liegt *absichtlich* auf einer festen Höhe über
der **modelleigenen** Orographie — dort ist die bodennahe Grenzschicht
(Reibung, Scherung, Turbulenz) tatsächlich aufgelöst, exakt wie bei der
WMO-10-m-Windkonvention, die ebenfalls vom untersten Modell-Level aus
relativ zur Modell-Oberfläche extrapoliert wird. Fragt man stattdessen
„echte Geländehöhe + 120 m" als AMSL-Ziel an, kann das bei großer
Modell/Real-Differenz einen Level treffen, der im Modell **weit oberhalb**
der eigenen Grenzschicht liegt — der zurückgegebene Wind wäre dann zu
schwach reibungsbeeinflusst und würde eine falsche Präzision vortäuschen,
die schlechter ist als der Status quo.

### Die eigentliche Grenze: unaufgelöstes Gelände

Große Differenz zwischen `surface.elevation` (echt) und der Modell-
Orographie ist kein Rechenfehler, sondern das direkte Symptom, dass das
**Modellgitter diese Geländeform nicht auflöst** — laut DWD-eigener
ICON-Dokumentation braucht das Erfassen einzelner Bergketten oder Täler
ein feineres Gitter, als ICON-D2 (~2,2 km) oder ICON-EU (~6,5 km) bieten.
Beispiele (empirisch geprüft):

| Ort | Echt (DEM) | Modell-Orographie | Δ |
|---|---|---|---|
| Zugspitze (Einzelgipfel, ICON-D2) | 2677 m | 2177 m | −500 m |
| Innsbruck (Talkessel, ICON-EU) | 579 m | 936 m | +357 m |

Eine echte Korrektur bräuchte ein eigenes Downscaling-Modell (Mesoscale-
to-Microscale-Kopplung wie WAsP, CFD-Mikrositing oder ML-Downscaling) —
außerhalb des Rahmens dieser App. Was die App stattdessen tut: die
Differenz **offenlegen statt verschweigen**, passend zum „na" wird nie
still grün"-Prinzip aus Abschnitt 6.2.

### Umsetzung
[src/app.js](src/app.js), `renderNow()`: `WindField.elevationAt(lat, lon)`
(bilinear an der Abfrageposition) gegen `surface.elevation` verglichen,
als „Modellorographie"-Zeile mit Differenz angezeigt. Ab
`TERRAIN_MISMATCH_WARN_M = 100` m (grobe Faustregel, keine
Literaturkonstante) wird die Zeile rot hervorgehoben plus ein Warnhinweis
eingeblendet: die Wind-auf-Höhe-Werte in diesem Fall mit Vorsicht
interpretieren, da das Modellgitter das lokale Gelände hier nicht auflöst.

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
`cloudBase` ohne tiefe BKN-Schicht (`null` von `cloudCeiling()`, bzw. bei
fehlender Säule `cloud_cover_low < 25 %` von `cloudBaseAgl()`) — das ist
**kein fehlender Messwert**, sondern die Aussage „keine relevante tiefe
Bewölkung", also tatsächlich grün.

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
| RH_crit-Kalibrierung (4.1) | 72→85 % / Eis 72 % / w-Dynamik — Startwerte, nicht modellkalibriert |
| Feuchte-Basis (4.1) | aus `q_v` (annahmefrei); Fallback auf Modell-RH nur wenn q fehlt |
| w-Schwellen (4.1) | `W_SCALE`/`CRIT_W_MAX` Platzhalter, noch nicht kalibriert |
| LCL-Fallback (4.5) | Bodenpaket-Näherung, ungenau bei Schichtwolken |
| Wind-Bandmaximum (1) | Stützstellen-Sampling, kein exaktes Profilmaximum |
| Böen (1) | nur am Boden, keine Hochrechnung auf Flughöhe |
| Go/No-Go-Schwellenwerte | Platzhalterprofil, keine geprüften Herstellerwerte |
| Vereisung, Turbulenz | in der Go/No-Go-Tabelle noch nicht abgebildet |
