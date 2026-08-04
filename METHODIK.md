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
Single Source of Truth: aus den Modell-Leveln (native Level von Michael) wird
EINE höhenabhängige Wolkenfraktion abgeleitet, aus der sich Cross-Section,
Meteogramm-Ceiling, Go/No-Go-Tabelle und Briefing-METAR speisen — statt der
früheren drei getrennten, festen RH-Schwellen.

### 4.1 Wolkenfraktion: dreistufig nach bester verfügbarer Quelle
`cloudFraction(hum, z, w)` wählt je Level die beste verfügbare Eingangsgröße
(`hum` bündelt `clc`/`qw`/`qi`/`q`/`p`/`t`/`rh`):

**Stufe 1 — `clc` (Modell-Bedeckungsgrad).** `cloud_cover_level{l}` (%) ist
Michaels direktes ICON-Level-Output — die Diagnose, die die Sundqvist-Kurve
(Stufe 3) bislang nur nachzubilden versuchte, inkl. Subskalen-Bewölkung.
Vorhanden ⇒ `CF = clc / 100`, unmittelbar. Kein Dunst-Guard nötig (der existiert
nur gegen RH-Proxy-Artefakte); die Nebel-Behandlung (4.3, Basis `< FOG_BASE_M`)
bleibt unverändert nachgeschaltet.

**Stufe 2 — `qw`/`qi` (Wolkenwasser/-eis), wenn `clc` fehlt.**
`cloud_water_level{l}`/`cloud_ice_level{l}` (g/kg) sind das tatsächliche
Kondensat, aber **nicht symmetrisch** verrechnet: `condensateFraction(qw, qi) =
1 − exp(−(qw/QCOND_SCALE_WATER + qi/QCOND_SCALE_ICE))` mit getrennten Skalen
(`QCOND_SCALE_WATER = 2e-5 kg/kg`, `QCOND_SCALE_ICE = 5e-6 kg/kg`, Eis also
~4x sensitiver — bei gleicher Masse erzeugt Eis mehr Bedeckungsgrad als Wasser).

*Quelle der Asymmetrie:* Grundner et al. 2024 (JAMES, „Data-Driven Equation
Discovery of a Cloud Cover Parameterization") — deren per Regression
gefundener Kondensat-Term liefert Koeffizienten a₈≈1,16 mg/kg (Wasser),
a₉≈0,31 mg/kg (Eis), Verhältnis ≈3,8. **Vorbehalt, per Prüfung bestätigt:**
Diese Koeffizienten stammen aus einem ML-Ersatzschema für ~80-km-
Klimamodellauflösung (trainiert gegen kilometerskalige Referenzsimulationen),
NICHT aus dem operationellen ICON-D2/EU-Schema, das unser `clc` tatsächlich
liefert — nur die **Richtung** (Eis sensitiver) ist direkt begründet, nicht
die absolute Größe. Eine eigene Regression `-ln(1-CLC/100) = qw/s_w + qi/s_i`
gegen ~8000 echte (T, qw, qi, CLC)-Tripel von Michaels Instanz (getrennt nach
T > 0 °C / T < −35 °C) ergab je nach Schätzmethode (Least-Squares vs. Median
der Punktschätzungen) Verhältnisse zwischen ~7,6 und ~13 — Richtung bestätigt,
absoluter Wert bleibt unsicher. Beide Konstanten sind daher weiterhin
**Platzhalter**, die Grundner-Ratio nur die Startannahme.

*Warum Stufe 2 strukturell nie so gut wie CLC wird:* Laut DWD-Doku
(„DWD Database Reference for ICON") ist unser `qw`/`qi` die reine
**Grid-Scale**-Größe aus der Sättigungsadjustierung des Mikrophysikschemas
(Seifert & Beheng 2006, zweimomentig) — „based on the assumption that there
would be no sub-grid-scale variability. That assumption is particularly
problematic for precipitation generation, moist turbulence and radiation."
`clc` ist dagegen laut DWD explizit konsistent mit einer **diagnostischen**
Variante (`QC_DIA`/`QI_DIA`), die Subgrid-/Turbulenz-/Konvektions-Anteile
einrechnet — genau die für tiefe, fleckige Bewölkung (Ceiling!) entscheidende
Komponente. Michaels Instanz liefert die DIA-Variante nicht (geprüft, mehrere
Namensvarianten). Stufe 2 bleibt also ein grober Nothelfer mit struktureller
Obergrenze, kein vollwertiger CLC-Ersatz — Kalibrierungsaufwand lohnt sich
hier weniger als in Stufe 3.

**Stufe 3 — Sundqvist-Fallback aus der Feuchte, wenn beides fehlt.** Der
ursprüngliche, weiterhin unveränderte Algorithmus — greift automatisch, wenn
Michaels Instanz `clc`/`qw`/`qi` (noch) nicht führt (`fetchColumn()` in
[src/column.js](src/column.js) fällt bei einem fehlgeschlagenen Request mit den
optionalen Feldern auf einen zweiten Request nur mit den Kernvariablen zurück —
Muster wie `SURFACE_OPTIONAL` in `weather.js`). Vier Schritte je Level:

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

**(b) Kritische Feuchte `criticalRH(z, T, w, model)`.** Wolke bildet sich ab
`RH_crit`, nicht erst bei Sättigung — nach CLC-Kalibrierung (s. u.) mit
GEGENÜBER der ursprünglichen Annahme UMGEKEHRTER Höhenrichtung: `96 %` am
Boden → `83 %` ab `RH_CRIT_Z_REF` (modellspezifisch, D2 300 m/EU 1200 m).
Im Eisast (α = `iceFraction`) auf `96,5 %` **eis-referenziert** — bei
Kältephasen also eher ANGEHOBEN gegenüber dem freitroposphärischen `83 %`-
Wert, nicht abgesenkt wie früher angenommen (folgt der Nullgradgrenze, nicht
einer festen Höhe). **Vertikalwind** `w` (m/s, nativ `wind_w_level{l}`,
Dynamik noch unkalibriert, Platzhalter): Aufwind senkt, Absinken hebt
`RH_crit` — `−CRIT_W_MAX · tanh(w / W_SCALE)`.

**(b′) Bodennaher Dunst-Guard — unter der aktuellen Kalibrierung faktisch
inaktiv.** In den untersten `Z_SURF_M = 150 m` wird `RH_crit` von
`RH_CRIT_SURF_GUARD = 90 %` am Boden linear auf das normale Profil angehoben
(ursprünglicher Zweck: bodennah ist hohe RH oft **optischer Dunst**, keine
Wolke). Mit dem seit der CLC-Kalibrierung (s. u.) geltenden `RH_CRIT_SURF =
96 %` liegt das allgemeine Profil am Boden bereits ÜBER dem Guard-Wert (90 %)
— der `max(crit, guard)` greift daher aktuell nie zugunsten des Guards.
Bewusst nicht entfernt: strukturelles Sicherheitsnetz, falls `RH_CRIT_SURF`
künftig (z. B. nach Rekalibrierung mit mehr Daten) wieder sinkt.

**(c) Sundqvist:** `CF = clamp(1 − √(max(0, (100 − RH_eff)/(100 − RH_crit))), 0, 1)`.

**Kalibrierung gegen echtes CLC (umgesetzt).** ⚠️ **Regelmäßig neu prüfen** —
s. Warnhinweis direkt im Konstanten-Block von `clouds.js`. Statt freier
Startwerte sind `RH_CRIT_SURF`, `RH_CRIT_MID`, `RH_CRIT_Z_REF` und
`RH_CRIT_ICE` jetzt direkt gegen echtes `clc` von Michaels Instanz gefittet
(Fehlerquadrat-Minimierung der vollen Sundqvist-Formel gegen `CLC/100`, nicht
nur eine Zwischengröße — robust gegen Annahmen über die Kurvenform).
Reproduzier-/Rekalibrierbar mit `npm run calibrate:clouds`
([scripts/calibrate-clouds.mjs](scripts/calibrate-clouds.mjs)).

- **Ergebnis:** `RH_CRIT_SURF=96`, `RH_CRIT_MID=83`, `RH_CRIT_ICE=96,5`.
  `RH_CRIT_Z_REF` modellspezifisch: **D2=300 m, EU=1200 m** (`col.model`
  wählt die Konstante, Default 950 m ohne Modellinfo) — plausibel an die
  unterschiedliche Grenzschichtauflösung gekoppelt.
- **Überraschender Befund — Höhenrichtung umgekehrt:** `RH_CRIT_SURF (96 %) >
  RH_CRIT_MID (83 %)`, GENAU ANDERSHERUM als die ursprüngliche Annahme
  (72→85, aufsteigend). Physikalische Deutung: in der turbulent durchmischten
  Grenzschicht ist die Feuchte innerhalb einer Gitterzelle relativ homogen —
  erst nahe Gebietssättigung wird ein Teilbereich wolkig. In der freien
  Troposphäre ist Feuchte kleinräumiger fleckig (Frontalzonen, Wellen), schon
  niedrigeres Gitter-Mittel reicht für Teilsättigung.
- **Fit-Güte:** MSE mit den alten Konstanten (72/85/1500) lag bei 0,0099 —
  kaum besser als die naive Vorhersage "immer der Mittelwert" (0,0113). Mit
  den neuen Konstanten: 0,0022 (≈80 % Fehlerreduktion). Eisast: 0,0156 →
  0,0076 (Referenz 0,0215).
- **Robustheit:** unabhängig für ICON-D2 und ICON-EU gefittet —
  `RH_CRIT_SURF` liegt in beiden bei ~95–96 %, die Höhenrichtung ist in
  beiden Modellen gleich umgekehrt. Nur `RH_CRIT_Z_REF` unterscheidet sich
  deutlich (s. o.).
- **Bekannte Einschränkungen (nicht kleinreden):**
  - Datenbasis nur **ein Kalendermonat** (August 2026) — saisonale
    Verzerrung möglich (Sommer-Grenzschicht ≠ Winter-Inversion). **Deshalb
    die ausdrückliche Pflicht, `npm run calibrate:clouds` regelmäßig bei
    anderen Wetterlagen erneut laufen zu lassen und zu vergleichen.**
  - `W_SCALE`/`CRIT_W_MAX` (w-Dynamik) sind weiterhin **Platzhalter** —
    zu wenige Level mit nennenswertem `|w|` in der Kalibrierungsstichprobe.
  - Der Dunst-/Nebel-Guard (`Z_SURF_M`, `RH_CRIT_SURF_GUARD`) wurde bewusst
    NICHT gegen CLC gefittet — er soll ja gerade den Fall abfangen, wo
    CLC/RH "Wolke" sagen, real aber nur Dunst vorliegt; dafür bräuchte es
    echte Sicht-/METAR-Referenz, nicht CLC selbst.
  - Regime-Vermischung (Höhe korreliert mit Wettertyp in der Stichprobe)
    ist nicht ausgeschlossen — eine reine Korrelationsanalyse.

**Kalibrierungs-Hintergrund:** DWDs COSMO-Physikdokumentation (Doms et al.
2011) beschreibt das operationelle Subgrid-Wolkenschema selbst als „an
empirical function depending on relative humidity and height" — strukturell
**dieselbe Form** wie unser Sundqvist-Fallback, anders als Stufe 2 (dort
strukturelle Obergrenze durch grid-scale `qw`/`qi`, s. o.) stand einer
Kalibrierung hier nichts im Weg.

**`developmentTag(w)` — Entwicklungstendenz, orthogonal zur CF-Stufen-Kette.**
Unabhängig davon, welche Stufe die Wolkenfraktion liefert, geht die
Information aus `w` (Vertikalgeschwindigkeit) bislang nur in Stufe 3
(`criticalRH`) ein — bei verfügbarem `clc`/`qw`/`qi` ginge sie sonst verloren,
obwohl `w` nichts über „ist Wolke da" aussagt (das leisten CF bereits),
sondern über „wächst sie gerade oder löst sie sich auf". Daher als separate
Funktion, an jedem Level zusätzlich zu `cloudFraction()` aufrufbar, ohne deren
Signatur zu ändern: `w > W_DEV_THRESHOLD` (0,3 m/s, **Platzhalter**, an
`W_SCALE` orientiert) ⇒ `"developing"`, `w < −W_DEV_THRESHOLD` ⇒
`"dissipating"`, sonst `"stable"`. Genutzt in der Briefing-Höhentabelle
(Spalte „Tendenz", [src/briefing.js](src/briefing.js)) — bislang nicht in
Cross-Section/Meteogramm verdrahtet (offene Erweiterung, keine feste
Darstellung dafür entschieden). `w` auf nativen ICON-D2-Leveln (2,2 km) ist
kleinskalig/verrauscht — einzelne Level/Stunden-Werte können zwischen den
Kategorien flackern.

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

**Nebel statt „Cloud 0 m":** bodenberührende Sättigung (Basis `< FOG_BASE_M =
30 m`) wird von Ceiling **und** unterster Basis **übersprungen** (`minBaseM` in
`lowestCrossing`) und die nächste Schicht darüber gesucht. Eine Wolke am Boden
ist Nebel — nicht als Wolkenschicht geführt. Das verhindert zugleich ein
Phantom-„NoGo" der Go/No-Go-Wolkenbasiszeile bei bloß feuchter (aber
sichtiger) Bodenluft.

**`groundFog(col, i)` — physikalischer Nebelnachweis aus QW/QI.** Bislang trug
die reine Sicht + `weather_code` der Oberflächen-API (einer *anderen* Instanz
als Michaels Modell-Level) die gesamte Nebelerkennung. Mit `qw`/`qi` steht ein
direkter Nachweis von Flüssigwasser/Eis am Boden zur Verfügung: prüft die Level
unterhalb `FOG_QW_CHECK_M = 50 m` (von unten) auf `qw + qi > FOG_QW_MIN`
(**Platzhalter**, wie die `QCOND_SCALE_*`-Konstanten in 4.1). Rückgabe
`{fog, freezing}` — `freezing`
(T ≤ 0 °C im Nebel-Level, unterkühlter Nebel, vereist auf Oberflächen inkl.
Rotorblättern) — oder `null`, wenn die Instanz `qw`/`qi` (noch) nicht führt.

*Additiv, nicht ersetzend:* wo `groundFog` ein Ergebnis liefert, wird es per
ODER mit der `weather_code`-Erkennung verknüpft (nie stillschweigend
überschrieben — beide Quellen können Nebel unabhängig erkennen):
- **Go/No-Go** (`gonogo.js` `hazardRow`): `groundFogArr` (aus `app.js`
  vorberechnet, parallel zu `cloudCeilingArr`) ergänzt die 45/48-Prüfung;
  `freezing` (oder Code 48) beschriftet die Zelle „Gefr. Nebel" statt „Nebel".
- **Meteogramm** (`meteogram.js` `drawCloud`/`drawWeatherRibbon`/Tooltip):
  derselbe `groundFog`-Marker wie im Go/No-Go, zusätzlich zum
  `weather_code`-Marker; Tooltip ergänzt „(gefrierend)".
- **Briefing** (`briefing.js` `metarWeather`): bestätigt `groundFog` Nebel,
  meldet `weather_code` aber **kein** signifikantes Wetter (`NSW`/`N/A`), wird
  FG/FZFG ergänzt. Zeigt `weather_code` bereits Schwereres (Gewitter,
  Niederschlag), bleibt das unverändert — Nebel wird nicht darübergestülpt.

**Meteogramm** (`refineCloudBase()`, verdrahtet in `openMeteogram()`,
[src/app.js](src/app.js)): liegt ein Modell-Ceiling vor, bestimmt DAS die Höhe
(durchgezogen bei hoher Konfidenz, gestrichelt sonst); fehlt es, Fallback auf
die LCL-Schätzung (4.5). Die Säule wird beim ersten Öffnen nachgeladen
(`ensureColumn()`) — schlägt das fehl, bleibt es sauber bei der LCL-Schätzung.
Das Tief-Panel zeichnet die Basis nur bis `~2500 m` (höhere Ceilings, z. B.
Cirrus-BKN, gehören nicht ins Tief-Panel) und **verbindet nicht über große
Basissprünge** (> 400 m = anderes Stockwerk → Lücke statt Scheinlinie).

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

### 4.4b Kartenlayer (Bedeckungsgrad + Ceiling, flächig)
`src/cloudoverlay.js` (Schwesterlayer zu Wind-/Böenlayer): dieselbe Methodik
wie oben, nur räumlich statt am Operationspunkt — je Gitterpunkt eine
Mini-Säule (`h/t/p/rh/q/w` je Level) aus dem gecachten Level-Band, ausgewertet
mit denselben `cloudCeiling()`/`bandCoverage()`. Zwei unabhängig zuschaltbare
Darstellungen aus EINEM Fetch:
- **Bedeckungsgrad**: `bandCoverage()` (neu, auf `cloudLayers()` aufgesetzt)
  bündelt alle Schichten je Stockwerk (tief `< 2000 m`, mittel, hoch
  `> 6500 m` AGL — `CLOUD_BAND_LOW_MAX_M`/`CLOUD_BAND_HIGH_MIN_M`, Startwerte)
  zum jeweiligen CF-Maximum. Als graue Fläche, Deckkraft ~ CF — ein
  Stockwerk zur Zeit (Umschalter), damit sich nichts überlagert.
- **Ceiling**: `cloudCeiling()` unverändert, wie im Meteogramm — als
  Farbfläche (Höhe → Farbskala) oder Zahlenwerte am Gitterpunkt.

Anders als der Wind-Layer ist das geladene Level-Band NICHT an
`settings.maxHeight` gekoppelt, sondern reicht immer bis
`CLOUD_OVERLAY_CAP_M` (12 km, wie `cloudLayers()`s `capM`-Default) — eine
hohe Schicht ist fürs Bedeckungsbild relevant, auch über der Flughöhe.

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

### 6.7 Vereisungs-Zeile (`icingRow()`, Intensitätsstufe statt Indexwert)
„Vereisung (10 m–Flughöhe)" wertet dieselbe Physik wie das GRAMET (`hazards/
icing.js` `ipiAt`, s. 7.6) auf ein **Bandmaximum** zwischen 10 m und
`opHeightM` aus — Stützstellen-Sampling wie beim Windmaximum (6, `bandHeights`
in `app.js`), aber **synchron**: `icingBandMaxAt()` interpoliert direkt auf
dem bereits geladenen GRAMET-Gitter (`state.data.gmGrid`, mit GRAMET geteilt —
kein eigener Request, keine WindField-Anbindung nötig).

Angezeigt wird **nicht** der rohe IPI-Wert, sondern die vertraute
Aviatik-Intensitätsstufe: `ipiCategory()` liefert dieselben vier Stufen
(none/light/moderate/severe) wie die GRAMET-Kontur, hier auf die deutschen
Tabellenbegriffe „keine/leicht/mäßig/stark" gemappt (`ICING_LABEL`). Die
Ampelfarbe kommt separat aus `ipiStatus()` (gröber, drei Stufen: grün < 0,30,
gelb < 0,45, sonst rot — dieselben Schwellen wie `ipiCategory`, nur ohne die
„none"/"light"-Unterscheidung, da Go/No-Go keine eigene Ampelfarbe für „Spur
von Vereisung" hat) — „leicht" kann also auf grünem Grund stehen. Anders als
bei `numericRow` ist die Schwelle **nicht profilabhängig** — es gibt (noch)
keine drohnenspezifische Vereisungstoleranz, daher `icingRow()` statt
`numericRow()`/`evalThreshold()`. Fehlt das Bandmaximum (Säule nicht geladen),
bleibt die Zeile `"na"` — nie stillschweigend grün (6.2).

**Höhenband der stärksten Vereisung** (zweite, kleinere Zeile in der Zelle,
`cell.subtext`): `icingBandMaxAt()` liefert nicht nur den Maximalwert, sondern
auch die Höhengrenzen des zusammenhängenden Bereichs um dieses Maximum, in
dem der IPI dessen eigene Kategorie-Untergrenze (`ipiCategoryFloor()`, z. B.
`IPI_SEVERE` bei einem Maximum in „severe") nicht unterschreitet — exakte
Kreuzungshöhen linear zwischen den Stützstellen interpoliert, genau wie
`crossHeight()` für Wolkenbasis/-obergrenze in `clouds.js`. Bei „keine"
(kein Wert erreicht `IPI_LIGHT`) gibt es kein Band, die Zelle zeigt nur die
Intensität. `gonogotable.js` rendert `subtext` generisch als kleinere zweite
Zeile unter dem Hauptwert (`.gng-subtext`, `css/style.css`) — bislang nur von
der Vereisungszeile genutzt.

### 6.8 Turbulenz-Zeile (`turbulenceRow()`, analog 6.7)

„Turbulenz (10 m–Flughöhe)" wertet dieselbe Physik wie das GRAMET
(`hazards/turbulence.js` `tfiAt`, s. 7.6) auf ein Bandmaximum zwischen 10 m
und `opHeightM` aus, Aufbau der Zelle (Kategorie-Label + Ampel + Höhenband
als `subtext`) identisch zu 6.7. **Ein Unterschied zur Vereisungs- (und
Wind-)Reduktion:** `turbulenceBandMaxAt()` in `app.js` resampelt NICHT auf
Stützhöhen (`bandHeights()`, alle ~50 m), sondern iteriert direkt über die
echten Modellschichten, deren Mittelpunkt im Band liegt — Ri/Scherung sind
selbst schon Differenzenquotienten über die jeweilige Schichtdicke zwischen
zwei Modell-Leveln (7.1); ein Resampling würde nur künstliche, nicht durch
Daten gestützte Zwischenwerte zwischen den eigentlichen Messpunkten erzeugen.
Bei sehr niedriger Flughöhe (gröbere Levelauflösung am unteren Rand als das
Band breit ist, keine Schicht-Mittelhöhe fällt hinein) Fallback auf die dem
Bandzentrum nächstgelegene Schicht — sonst bliebe die Zeile ausgerechnet bei
niedrigen `maxHeight`-Einstellungen leer, dem für Drohnen häufigsten Fall.

**Warum keine eigene Böen-Zeile dupliziert wird:** Böen liegen nur am Boden
vor (1) und werden bewusst nicht auf Flughöhe hochgerechnet — die Turbulenz-
Zeile deckt exakt die Lücke darüber ab (dynamische/thermische Instabilität
im Flugband), keine der beiden Zeilen wiederholt die andere.

---

## 7. GRAMET (Cross-Section entlang der Route)

[src/gramet/](src/gramet/) baut ein eigenes Zeit-Höhen-Gitter aus der bereits
geladenen Säule (`column.js`) + den Oberflächenwerten und leitet daraus
Isolinien, Wolken/Niederschlag und Konvektionszellen ab — dieselben
Grundgrößen wie Abschnitt 1–4, aber flächig über Zeit statt punktuell am
Operationspunkt. Neu seit dieser Iteration; bislang nirgends sonst
dokumentiert.

### 7.1 Zeit-Höhen-Gitter
[src/gramet/grid.js](src/gramet/grid.js), `gridFromColumn()` +
`derive()`. Level bereits in Aufstiegsreihenfolge aus `column.js` (k=0 ≈
10 m AGL), Einheiten intern SI. Levelddruck kommt 1:1 aus der Säule
(`pressure_level{l}`) — die ursprünglich geplante hydrostatische Integration
aus `pressure_msl` war unnötig, Michaels Server liefert den Leveldruck
bereits direkt. `derive()` rechnet zusätzlich potentielle Temperatur `θ`,
Windbetrag `wspd` und `cloudFrac` (über dieselbe dreistufige
`clouds.js`-Heuristik wie Abschnitt 4.1) sowie — auf gestaffelten
Zwischenniveaus — Scherung `shear2 = (du/dz)² + (dv/dz)²`,
Brunt-Väisälä-Frequenz `N² = (g/θ)·dθ/dz` und Richardson-Zahl `Ri = N²/shear2`.
Diese drei sind Eingangsgrößen des Turbulenzmoduls (7.7): `ri`/`shear2`
liegen NUR auf diesen Zwischenniveaus vor (`nm = nk-1` Werte je Zeitspalte,
nicht auf den `nk` Original-Leveln) — jeder Verbraucher, der eine
Level-indizierte Größe braucht (z. B. die GRAMET-Kontur), muss die beiden
angrenzenden Schichtwerte selbst auf ein Level zurückführen, s. 7.6.

### 7.2 Isolinien & Tropopause
[src/gramet/derive.js](src/gramet/derive.js).

- **Isothermen** (0/−20/−40 °C): je Zeitspalte werden alle Höhen gesucht, an
  denen `T` die Schwelle kreuzt (lineare Interpolation zwischen Leveln), dann
  spaltenübergreifend zu Polylinien verkettet — die nächste Spalte verlängert
  eine bestehende Linie an ihrem nächstgelegenen Kreuzungspunkt, sofern der
  Sprung `< ISOTHERM_MAX_JUMP_M = 1500 m` bleibt (sonst neue Linie; verhindert
  Fehlverbindungen bei mehrdeutigen Kreuzungen, z. B. Inversionen).
- **Isotachen** (50/75/100 kt): generischer Marching-Squares-Konturierer
  (`contour()`) auf dem Zeit×Level-Feld `wspd` — bewusst allgemein gehalten,
  bereits jetzt für andere Felder wiederverwendbar. Sattelfälle (zwei
  gegenüberliegende Zellecken über der Schwelle) werden über den
  Zellmittelwert aufgelöst (asymptotic decider), damit keine sich
  kreuzenden Liniensegmente entstehen.
- **Tropopause:** WMO-Kriterium — unterstes Level ab 5000 m AGL, ab dem der
  Temperaturgradient über die gesamten nächsten 2000 m nirgends `> 2 K/km`
  beträgt. Wird das Gitter vor Erreichen der 2-km-Prüfstrecke abgeschnitten
  (Domänendeckel), zählt das explizit NICHT als Treffer (sonst
  Fehlalarm am oberen Rand). Ergebnislinie mit gleitendem 3-Punkt-Mittel
  geglättet (`smooth3`).
- **Tag/Nacht-Verlauf:** `sunAltitude()` ([src/astro.js](src/astro.js)) je
  Spalte, kontinuierlicher Faktor 1 oberhalb 0° Sonnenhöhe, 0 unterhalb −12°
  (nautische Dämmerung), dazwischen linear — steuert nur die Hintergrund-
  Einfärbung, keine physikalische Ableitung.

### 7.3 Wolkenbasis/-obergrenze im GRAMET
[src/gramet/derive.js](src/gramet/derive.js), `cloudBaseAt()`/`cloudTopAt()`.
Spiegelt `clouds.js` `lowestCloudBase()` (Abschnitt 4.3), rechnet aber direkt
auf dem bereits am Gitter vorliegenden `cloudFrac` statt erneuter
`cloudFraction()`-Aufrufe — Basis = unterster zusammenhängender Bereich mit
`CF ≥ CF_FEW`, bodenberührende Sättigung (`< FOG_BASE_M = 30 m`, gespiegelte
Konstante) zählt als Nebel, nicht als Wolke.

Der Obergrenzen-Suche (`cloudTopAt`) wurde eine **Lückentoleranz**
(`CLOUD_TOP_GAP_TOLERANCE_M = 1200 m`) hinzugefügt: kleine trockene
Zwischenschichten innerhalb dieser Distanz unterbrechen die zusammenhängende
Schicht nicht mehr. Vorher schnitt eine dünne bodennahe Feuchteschicht die
eigentlich darüber regnende Wolke fälschlich ab, wodurch der
Niederschlagsvorhang (7.4) weit unter der sichtbar gezeichneten Wolke endete.
Eine echte, größere Lücke (z. B. isoliert darüberliegender Cirrus) beendet die
Schicht weiterhin. `anyCloudTopAt()` sucht zusätzlich das höchste Level im
GESAMTEN Profil mit `CF ≥ CF_FEW`, als robusterer Fallback, falls die
Basis-Erkennung selbst nichts findet.

### 7.4 Niederschlagsvorhang
[src/gramet/derive.js](src/gramet/derive.js), `precipEntries()`. Zwei getrennte
Rollen statt eines einzigen Mengen-Gates:

- **OB gezeichnet wird:** `weather_code` (als METAR-Kürzel über dieselbe
  Tabelle wie die Wetter-Zeile, [src/briefing.js](src/briefing.js)
  `metarWeather()`) oder die Menge (`precipitation > PRECIP_MIN_RATE =
  0,05 mm/h`) — jede der beiden Quellen reicht allein. Vorher war die Menge
  allein das Gate; bei sehr leichtem Niederschlag rundet sie oft auf ~0,
  obwohl `weather_code` ihn noch meldet, wodurch Wetter-Zeile und gezeichneter
  Vorhang auseinanderliefen.
- **ALS WAS:** Phase (Regen/Schnee) kommt jetzt primär aus dem METAR-Kürzel
  (`SN`/`SG`/`FZ…`), nicht mehr nur aus `snowfall > 0`. Meldet nur
  `weather_code`, aber keine Menge (z. B. „−RA"), wird eine nominale
  Mindestrate von 0,3 mm/h angenommen, sonst bliebe der Vorhang trotz
  gemeldetem Niederschlag unsichtbar. Reiner Nebel (`FG`/`FZFG`) zählt
  explizit nicht als Niederschlag.
- **WIE HOCH:** Oberkante = `cloudTopAt()` (7.3, jetzt mit Lückentoleranz) ab
  der erkannten Basis. Nur wenn gar keine Basis gefunden wird (Niederschlag
  laut `weather_code`/Menge gemeldet, aber keine Wolke im `CF_FEW`-Sinn
  erkannt), Ersatz über `anyCloudTopAt()`, zuletzt einen festen
  `PRECIP_FALLBACK_TOP_M = 2000 m` (grobe Annahme für flachen
  Sprühregen/Nieselregen) — **nie** der Gitterdeckel als Ersatz. Das
  Maximum aus beiden Quellen zu nehmen wurde bewusst verworfen: es riss den
  Vorhang bis zu unverbundenem Cirrus weit darüber („bis in die Stratosphäre"-
  Artefakt).

### 7.5 Konvektion: TCU-/Cb-Spalten
[src/gramet/derive.js](src/gramet/derive.js) `cbColumns()` +
[src/gramet/hazards/convection.js](src/gramet/hazards/convection.js). Liefert
pro Stunde `null` oder `{base, top, kind: "tcu"|"cb"}` für Schaft und Glyph
(WMO-Symbole CL3 bzw. CL9, reine Zeichenzuordnung in
[src/gramet/render.js](src/gramet/render.js)).

**Parcel-Theorie (`convection.js`), Schwerpunkt CCL statt LCL.** Portiert aus
`sounding_data/sounding_viewer.html`, bewusst als eigener geschlossener
Konstantensatz statt über `clouds.js` (dort leicht andere Magnus-
Koeffizienten — Mischen würde Isohume und Feuchtadiabate gegeneinander
verstimmen):
- **CCL** — erstes Niveau, an dem die Isohume durch den Bodentaupunkt die
  Umgebungstemperatur erreicht (lineare Interpolation am Kreuzungspunkt) —
  physikalische Basis der Quellwolke.
- **TA (Auslösetemperatur)** — CCL-Temperatur trockenadiabatisch auf
  Bodendruck zurückgeführt. Ersetzt einen früheren festen CAPE-Schwellwert,
  weil TA die tatsächliche Sperrschicht aus dem Profil auswertet statt eines
  pauschalen Werts.
- **EL** — ab CCL feuchtadiabatisch aufwärts (RK4-Integration, 5-hPa-Schritte,
  Pseudoadiabate aus Mixed-Phase-Sättigungsdampfdruck: Wasser > 0 °C, Eis
  < −40 °C, dazwischen linear geblendet), CAPE aufintegriert mit virtueller
  Temperaturkorrektur (Doswell & Rasmussen 1994); EL = erstes Niveau, an dem
  der Auftrieb nach einer positiven Phase wieder negativ wird.
- Bodenzustand bevorzugt 2-m-Temperatur/-Taupunkt, Druck vom untersten Level
  (~10 m AGL, Höhendifferenz gegenüber der CCL-Suchschrittweite
  vernachlässigbar); fehlen die 2-m-Werte, tritt das unterste Modell-Level an
  ihre Stelle.

**Ob überhaupt eine Spalte entsteht — drei Wege, jeder für sich hinreichend:**
1. `weather_code` meldet TS (Gewitter) oder SH/+SH (Schauer) — direktes
   Modellsignal, verlässlicher als die eigene Parcel-Rechnung.
2. Thermische Auslösung: `T_2m ≥ TA − TRIGGER_EXCESS_K` (2 K Zuschlag) **und**
   Mächtigkeit `EL − CCL ≥ TCU_MIN_DEPTH_M = 1500 m` (ein flaches Cu-Feld ist
   noch keine TCU). Der Zuschlag korrigiert, dass `T_2m` ein
   Gitterzellen-Mittel ist, während Konvektion aus den wärmsten
   Thermikblasen startet (überadiabatische Bodenschicht, besonnte Hänge,
   subskalige Heterogenität — 0,5–2 K wärmer als das Zellmittel), plus dass TA
   selbst rund die Hälfte des 2-m-Taupunktfehlers erbt. Beide Effekte zeigen
   in dieselbe Richtung: ein striktes `T_2m ≥ TA` löst systematisch zu spät
   aus. **`TRIGGER_EXCESS_K` ist nicht kalibriert.**
3. Auffangpfad mit den alten, ebenfalls unkalibrierten Schwellen
   `CAPE ≥ CB_CAPE_MIN_JKG = 300 J/kg` oder `max|w| ≥ CB_UPDRAFT_MIN_MS =
   3 m/s`, nur falls 1. und 2. nichts liefern (z. B. CCL nicht bestimmbar).

**Towering-Hürde (hartes Veto):** der Oberrand muss
`TCU_MIN_ABOVE_FREEZING_M = 1524 m` (5000 ft, grob das −10-°C-Niveau bei
Standardgradient, Beginn nennenswerter Vereisung im Turm) über der 0-°C-Grenze
liegen — sonst entsteht gar keine Konvektionsspalte (weder Schaft noch
Symbol), auch wenn einer der drei Wege oben angeschlagen hat. Ein flacher
Schönwetter-Cumulus, der die Frostgrenze kaum erreicht, wäre sonst
fälschlich als TCU geplottet worden; in labilen Lagen verschmolzen genau
diese Randstunden den Nachmittag zu einem durchgehenden Block. Ausnahme: ein
gemeldetes `TS` hebelt die Hürde aus — ein Gewitter ohne vereisten Oberrand
laut unserer (Fallback-lastigen) Höhenschätzung ist ein Widerspruch, in dem
die Oberrand-Schätzung die unsicherere Größe ist. Weder diese Hürde noch die
darunterliegenden Schwellen sind kalibriert.

**Cb vs. TCU:** `kind = "cb"`, wenn `TS` gemeldet wird **oder** der Oberrand
vergletschert ist (`T ≤ CB_GLACIATION_C = −20 °C`) **und** tropopausennah
liegt (`< CB_TROPOPAUSE_GAP_M = 1200 m` Abstand) — dort, wo sich tatsächlich
ein Amboss ausbreiten kann. `+SH` allein zählt bewusst NICHT als Cb-Signal:
Schauerintensität belegt keinen vergletscherten Oberrand. Sonst `"tcu"`.

**Basis/Oberrand-Fallback-Ketten** (nie der Modelldeckel, gleiches Prinzip wie
7.4): Oberrand = EL, sonst höchstes vergletschertes `CF ≥ CF_BKN`-Level, sonst
irgendeine Wolkenspur im Profil, sonst `CB_FALLBACK_TOP_M = 6000 m`. Basis =
CCL, sonst die allgemeine Wolkenbasis (7.3), sonst 0 — mit der Nebenbedingung
`Basis < Oberrand` (sonst würde bei hochbasiger Konvektion ohne EL ein
Fallback-Oberrand unter dem CCL liegen und der Schaft invertiert gezeichnet).

### 7.6 Vereisung (Icing-Potential-Index)
[src/gramet/hazards/icing.js](src/gramet/hazards/icing.js).

**Architektur, bewusst physik-/UI-getrennt:** die Vereisungsdiagnose soll
sowohl das GRAMET-Meteogramm als auch später die Go/No-Go-Tabelle bedienen —
zwei Konsumenten mit unterschiedlicher Reduktion (Meteogramm: kontinuierliches
Feld pro Gitterzelle; Go/No-Go: ein Bandmaximum pro Stunde, analog 1). Deshalb
ist die Physik als reine, UI-unabhängige Funktion `ipiAt(tC, cloudFrac)`
gebaut, die keine dieser beiden Reduktionen kennt.

**Icing-Potential-Index (IPI) = f_T(T) · cloudFrac**, pro Zelle/Punkt:
- **f_T(T)** — weiches Temperaturfenster (Trapez) statt harter 0…−15-°C-Box:
  `0` bei `T ≥ 0 °C`; linear `0 → 1` zwischen `0` und `−2 °C` (schneller
  Onset — Klareis ist knapp unter 0 °C am gefährlichsten, große
  Tropfen/hoher LWC); `1` im Kernfenster `−2…−15 °C` (maximale
  Häufigkeit unterkühlten Flüssigwassers); linear `1 → 0` zwischen `−15` und
  `−20 °C` (zunehmend vergletschert, SLW versiegt); `0` bei `T ≤ −20 °C`
  (praktisch nur noch Eiskristalle). Die −20-°C-Kante ist absichtlich
  identisch mit `CB_GLACIATION_C` aus `derive.js` (7.5) gehalten, damit nicht
  zwei verschiedene Vergletscherungstemperaturen im selben Modul
  auseinanderdriften — dort nicht exportiert (zirkulärer Import), daher
  eigenständig gepflegt, aber bewusst gleich.
- **cloudFrac** — statt einer eigenen RH-Schwelle (ursprünglich geplant: 0 bei
  RH ≤ 90 %, linear auf 1 bei 100 %) wird die bereits kalibrierte
  Wolkenfraktion aus 4.1 wiederverwendet (dieselbe Größe wie Wolkenbasis und
  Cb-Erkennung) — eine Definition für „ist die Zelle in der Wolke" im ganzen
  GRAMET statt einer zweiten, unkalibrierten RH-Heuristik. `derive.js` reicht
  `d.cloudFrac` direkt an `icing.computeGrid(grid, cloudFrac)` durch.

Physik dahinter: `f_T` kodiert „gibt es überhaupt unterkühltes Flüssigwasser",
`cloudFrac` „ist die Zelle in der Wolke". Das Produkt ist die ehrlichste
Näherung an LWC ohne eigene Flüssigwassergröße.

**Kategorisierung:** `ipiCategory()` bildet den kontinuierlichen IPI (0…1) auf
`none/light/moderate/severe` ab, Schwellen `0,15/0,30/0,45` — **nicht
kalibriert**, gemeinsam für alle künftigen Verbraucher (GRAMET-Kontur, später
Go/No-Go-Status) definiert, damit eine spätere Kalibrierung an einer Stelle
beide Darstellungen trifft.

**Rendering (GRAMET):** `computeGrid()` liefert die Kategorie pro Gitterzelle
für `drawHazardArea()` (Kontur-Fläche, s. 7.5-Muster) — bewusst **über**
Wolken/Niederschlag gezeichnet (transparente Füllung, s.
[render.js](src/gramet/render.js)), damit die Gefahrenfläche auf der Wolke
„aufsitzt" statt darunter zu verschwinden. Zusätzlich ein WMO-nahes
Vereisungssymbol (U-Bogen mit zwei vertikalen Linien) je zusammenhängender
`severe`-Fläche, an deren Schwerpunkt, mit Mindestabstand analog zu den
Cb-Glyphen (7.5).

**Go/No-Go-Bandmaximum:** implementiert, s. 6.7 (`icingBandMaxAt()` in
`app.js`, Zeile „Vereisung (10 m–Flughöhe)" in `gonogo.js`) — dieselbe Physik
(`ipiAt`), eigene Reduktion (Bandmaximum statt Kontur) und eigene
Kategorisierung (`ipiStatus`, drei statt vier Stufen).

**Noch offen:** Aufwind-Bonus `f_w(w)` (Hebung repliziert SLW, wie im
NCAR-CIP-Ansatz) — `w` liegt über `grid.w` bereit, aber bewusst nicht in V1;
echte Kalibrierung aller Schwellen (T-Fenster wie IPI-Kategorien) mit realen
Vereisungsfällen.

### 7.7 Turbulenz (Turbulence-Flag-Index)
[src/gramet/hazards/turbulence.js](src/gramet/hazards/turbulence.js).

**Bewusste Abgrenzung zur Böen-Zeile/zum Böen-Overlay:** Böen liegen nur am
Boden vor (1) und werden nicht auf Flughöhe hochgerechnet. Der TFI deckt
gezielt die Lücke DARÜBER ab — dynamische und thermische Instabilität im
Flugband zwischen 10 m und Betriebshöhe. Keine der beiden Größen dupliziert
die andere.

**Turbulence-Flag-Index, Rohwert `raw = g(Ri) · s(|dV/dz|)`**, pro
Modellschicht (Ri/Scherung liegen nur auf den gestaffelten Zwischenniveaus
vor, s. 7.1):
- **g(Ri)** — Miles-Howard-Kriterium für Kelvin-Helmholtz-Instabilität: `1`
  für `Ri ≤ 0,25` (inklusive `Ri < 0`, also labiler/überadiabatischer
  Schichtung, z. B. bodennaher Tagesthermik — ein Index deckt damit
  mechanische UND thermische Turbulenz ab, ohne zwei getrennte Diagnosen);
  linear `1 → 0` zwischen `0,25` und `1,0`; `0` darüber (Turbulenz gilt als
  zunehmend unwahrscheinlich).
- **s(|dV/dz|)** — Scher-Gate: `0` unterhalb `0,02 s⁻¹` (≈ 2 m/s je 100 m),
  linear auf `1` ab `0,05 s⁻¹`. Nötig, weil Ri als Verhältnis bei Scherung
  nahe 0 numerisch instabil wird (`grid.js` `derive()` setzt `ri = NaN`
  bereits bei `shear2 ≤ 1e-8` als reinen Divisionsschutz, s. 7.1) — ohne
  dieses Gate würde eine völlig ruhige, schwach stabile Schicht fälschlich
  als Turbulenz erkannt. Das Gate wird deshalb VOR `g(Ri)` ausgewertet: bei
  `s = 0` wird sofort `0` zurückgegeben, statt `g(NaN) · 0 = NaN` zu bilden.

**Windstärke-Gate `w(V)` — TFI = `raw`, falls `raw ≤ TFI_MODERATE (0,30)`,
sonst `TFI_MODERATE + (raw − TFI_MODERATE) · w(V)`.** Ergänzt nach einem
Praxis-Check (2026-08-04): `g`/`s` sind reine Onset-Kriterien (sagen nur,
DASS sich Kelvin-Helmholtz-Wellen bilden können) und sättigen beide schnell
auf `1` — ohne Korrektur war „severe" schon bei knapp erfülltem Ri- UND
Scher-Kriterium erreichbar, unabhängig von der absoluten Windgeschwindigkeit
(beobachtet: bodennahe „severe"-Flächen bei durchweg ≤ 10 kt Wind). `w(V)`
(`V` = mittlere Windgeschwindigkeit der Schicht, komponentenweise aus u/v
gemittelt, Betrag danach) ist `0` unterhalb `5 m/s` (≈ 10 kt), linear auf `1`
ab `10 m/s` (≈ 19 kt) — **erste Schätzung, ausdrücklich zur Nachjustierung
vorgesehen.** Bewusst NICHT als weiterer multiplikativer Faktor auf den
GESAMTEN Index (das würde auch „light"/„moderate" bei jeder Kalmenlage
unterdrücken), sondern nur auf den Anteil oberhalb der „moderate"-Schwelle:
bei Windstille bleibt „moderate" weiterhin erreichbar, nur „severe" braucht
zusätzlich spürbaren Wind.

**Kategorisierung:** `tfiCategory()` bildet den TFI (0…1) auf
`none/light/moderate/severe` ab, Schwellen `0,15/0,30/0,60` — **nicht
kalibriert**, exakt nach demselben Muster wie die IPI-Schwellen (7.6)
gemeinsam für GRAMET-Kontur und Go/No-Go-Ampel definiert.

**Rendering (GRAMET):** anders als bei Vereisung (Punktgrößen T/cloudFrac an
jedem Level direkt bekannt) liegen Ri/Scherung nur AUF DEN SCHICHTEN
zwischen zwei Modell-Leveln vor. `computeGrid()` gibt daher jedem Level das
Maximum der beiden angrenzenden Schichten (unten/oben; Rand-Level haben nur
eine) — reine Zuordnungsregel, keine Interpolation zwischen Schichten.
Kontur-Fläche wie bei Vereisung (`drawHazardArea()`, 7.6-Muster), Symbol
(ICAO-SIGWX „mäßige Turbulenz", Dachform) nur auf der stärksten Kategorie
(`severe`), analog zum Vereisungssymbol nur auf `severe`-Flächen.

**Go/No-Go-Bandmaximum:** implementiert, s. 6.8.

**Bekannte Grenzen der Diagnose (wichtig für die Interpretation):**
- **Feuchtlabilität/Konvektion wird NICHT erkannt.** `Ri` basiert auf der
  TROCKENEN potenziellen Temperatur `θ` (7.1). In und um hochreichende
  Konvektion (Cb/TCU, 7.5) ist das grobaufgelöste Modell-Mittelprofil
  außerhalb der eigentlichen Aufwindkerne meist neutral bis leicht stabil
  geschichtet (`dθ/dz ≥ 0`), obwohl daneben erhebliche konvektive Böigkeit
  herrscht — bedingte (feuchte) Instabilität ist physikalisch ein anderer
  Mechanismus als die hier diagnostizierte Kelvin-Helmholtz-Scherinstabilität
  und zeigt sich im trockenen `θ`-Gradienten nicht. Die TFI-Fläche bleibt
  deshalb in und um Schauer-/Gewitterzellen typischerweise leer — das ist
  **kein Befund für „unauffällig"**, sondern eine Diagnoselücke; die
  Cb/TCU-Symbole selbst tragen die Turbulenzwarnung für diesen Fall bereits
  implizit (ein Cb bedeutet für jeden Piloten erwartete Turbulenz, ohne dass
  der TFI das zusätzlich markieren müsste).
- **Bodennahe, nächtliche Flächen sind meist ein Low-Level-Jet-Effekt, kein
  Artefakt.** Tagsüber durchmischt die konvektive Grenzschicht den Impuls
  (Wind wird mit der Höhe homogenisiert, wenig lokale Scherung knapp über
  Grund). Nachts entkoppelt die stabile Grenzschicht die Bodenreibung vom
  freien Wind darüber; genau dort kann sich Scherung konzentrieren, bis `Ri`
  trotz starker Stabilität die kritische Schwelle unterschreitet. Häufungen
  im Band 30–300 m in den Nachtstunden (erkennbar am Tag/Nacht-Verlauf des
  Hintergrunds, s. 7.3) sind damit meteorologisch plausibel und decken exakt
  die Lücke ab, für die die Zeile gedacht ist (Höhen, in denen es keine
  Böen-Beobachtung gibt, aber Drohnen typischerweise fliegen).
- **Onset-Kriterium ≠ Intensität — inzwischen über `w(V)` teilkompensiert,
  nicht gelöst.** Physikalisch ist das Miles-Howard-Kriterium korrekt als
  Instabilitäts-ONSET (wann können sich Kelvin-Helmholtz-Wellen bilden),
  sagt aber nichts über die resultierende Turbulenzintensität (EDR) aus.
  Das Windstärke-Gate (oben) verhindert nur, dass „severe" bei insgesamt
  schwachem Wind vergeben wird — es skaliert NICHT die tatsächliche
  Intensität, und die Gate-Schwellen (5/10 m/s) selbst sind eine erste
  Schätzung ohne Referenzfälle. Operative Turbulenz-Indizes (z. B. Ellrod
  TI, GTG) verwenden zusätzlich Deformation und weitere Terme; hier bislang
  nicht nachgebildet.

---

## Bekannte Näherungen — Kurzübersicht

Ausführliche Diskussion und geplante Verfeinerungen stehen in
[IDEEN.md](IDEEN.md); hier nur die Liste der Stellen, an denen eine
vereinfachende Annahme steckt:

| Größe | Annahme/Schwäche |
|---|---|
| RH_crit-Kalibrierung (4.1) | 72→85 % / Eis 72 % / Boden-Guard 90 % / w — Startwerte, nicht kalibriert |
| Feuchte-Basis (4.1) | aus `q_v` (annahmefrei); Fallback auf Modell-RH nur wenn q fehlt |
| Nebel-Grenze (4.3) | Basis < 30 m = Nebel (Sicht/ww statt Wolke); Schwelle heuristisch |
| w-Schwellen (4.1) | `W_SCALE`/`CRIT_W_MAX` Platzhalter, noch nicht kalibriert |
| LCL-Fallback (4.5) | Bodenpaket-Näherung, ungenau bei Schichtwolken |
| Wind-Bandmaximum (1) | Stützstellen-Sampling, kein exaktes Profilmaximum |
| Böen (1) | nur am Boden, keine Hochrechnung auf Flughöhe |
| Go/No-Go-Schwellenwerte | Platzhalterprofil, keine geprüften Herstellerwerte |
| Vereisungs-Bandmaximum (6.7) | Stützstellen-Sampling wie Wind-Bandmaximum, kein exaktes Profilmaximum; feste statt drohnenspezifischer Schwelle |
| Turbulenz-Bandmaximum (6.8) | echte Modellschichten statt Stützstellen-Sampling (bewusst, s. 6.8), aber grobe Levelauflösung am unteren Rand kann bei sehr niedriger Flughöhe nur eine Schicht treffen |
| GRAMET Konvektionsschwellen (7.5) | `TRIGGER_EXCESS_K`, Towering-Hürde, CAPE-/Updraft-Auffangpfad — sämtlich unkalibriert |
| GRAMET Niederschlags-Fallback-Obergrenze (7.4) | 2000 m, grobe Annahme für flachen Niesel-/Sprühregen ohne erkannte Wolkenspur |
| GRAMET Vereisung (7.6) | `f_T`-Fenster und IPI-Kategorie-Schwellen (0,15/0,30/0,45) unkalibriert; `cloudFrac` statt eigener LWC-Größe |
| GRAMET Turbulenz (7.7) | `Ri`/Scher-Gate-Schwellen (0,25/1,0 bzw. 0,02/0,05 s⁻¹), Windstärke-Gate (5/10 m/s) und TFI-Kategorie-Schwellen (0,15/0,30/0,60) unkalibriert; sieht KEINE feuchte/konvektive Instabilität (nur trockenes `θ`); Onset-Kriterium weiterhin ohne echte Intensitätsskalierung, s. 7.7 |
