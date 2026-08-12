Betreff: surface_pressure/QFE in DZMaster – Umstellung von Roh-PS auf WMO-Druckreduktion

Kontext
-------
Bugsuche in DZMaster ergab, dass QFE-Werte an Bergstandorten teils deutlich daneben
lagen. Ursache gefunden und mit echten DWD-OpenData- und Open-Meteo-Abfragen
verifiziert (6 Alpenpunkte, ICON-D2 + ICON-EU, Lauf 2026-08-11 00Z).

Befund
------
- pressure_msl (PMSL) ist bei DWD OpenData und Open-Meteo praktisch identisch
  (Δ ≤ 0,5 hPa) – das ist der stabile, unveränderte Modell-Rohwert. Kein Problem.
- surface_pressure (PS) dagegen weicht stark ab – 0,2 bis 99,1 hPa Differenz in der
  Stichprobe. Grund: DWDs Roh-PS bezieht sich auf die vom Modell GEGLÄTTETE
  Orographie, nicht auf die echte Standorthöhe. Beispiel Zugspitze/ICON-EU: Modell
  „sieht" dort nur 1609 m (6,5-km-Gitter glättet den Gipfel massiv weg), real sind es
  2677 m → 1068 m Höhenlücke → 99 hPa Fehler.
- Korrelation Höhenlücke (Modellorographie vs. echte Höhe) ↔ Druckfehler: r = -0,995,
  Steigung ≈ -9,35 hPa pro 100 m Lücke. Das ist die dominante Fehlerquelle, um einen
  Faktor 5-20 größer als jeder Formel-/Temperaturfehler.
- Fazit: **PS darf nicht 1:1 vom Modellgitterpunkt übernommen werden, wenn der
  Standort in strukturiertem Gelände liegt und von der Modellorographie abweicht.**

Empfohlene Lösung: WMO/ICAO-Druckreduktion (etabliertes Verfahren)
-------------------------------------------------------------------
Statt Roh-PS zu verwenden, PS selbst aus PMSL + echter Standorthöhe berechnen –
mit dem Standardverfahren, das Wetterdienste für Bergstationen/Hochgebirgsflughäfen
zur QFE↔QNH-Reduktion nutzen (WMO Guide to Instruments and Methods of Observation,
analog ICAO-Verfahren für Aerodrome QNH).

Eingangsgrößen:
  h        = echte Standorthöhe (DEM, NICHT Modellorographie/HSURF)
  T_punkt  = aktuelle Modell-Temperatur am Standort (T2M reicht; in Kelvin)
  p_msl    = pressure_msl vom Modell (Pa oder hPa)

Algorithmus:
  1. Fiktive Meereshöhen-Temperatur (Extrapolation mit Standard-Lapse-Rate):
     T0' = T_punkt + 0,0065 * h        [K, h in m]

  2. Mittlere Schichttemperatur:
     Tm = (T_punkt + T0') / 2

  3. Hypsometrische Gleichung, PMSL → Zielhöhe:
     p(h) = p_msl * exp( -g * h / (R * Tm) )
     mit g = 9,80665 m/s², R = 287,05 J/(kg·K)

Der Unterschied zur bisherigen ICAO-Standardatmosphäre-Extrapolation (wie sie
Open-Meteo intern nutzt): dort ist die Referenztemperatur fix bei 288,15 K
(15 °C), hier wird die tatsächliche Modelltemperatur von heute als Anker
verwendet. Das entfernt den in der Stichprobe gefundenen systematischen
Formel-Restfehler von 3-7 hPa (isoliert getestet: Rohmodell-PS gegen dieselbe
Formel auf Modell-eigener Orographie angewandt).

Was bewusst NICHT umgesetzt wird
---------------------------------
Eine vollständige Integration über die realen Modell-Level (mehrere Druck-/Höhen-
level zwischen MSL und Zielhöhe mit jeweils realer Temperatur) wäre noch genauer
und würde auch echte Bodeninversionen korrekt abbilden – das WMO-Verfahren tut das
nicht, weil es sich seine virtuelle Referenztemperatur selbst mit der fixen
Standard-Lapse-Rate baut. Für den aktuellen Bedarf ist der Aufwand (zusätzliche
Level-Variablen abfragen, Sonderfall Level ↔ Orographie behandeln) gegenüber dem
Nutzen (nur bei ausgeprägten Inversionslagen relevant) nicht gerechtfertigt.
Falls das später gebraucht wird: die level-basierten Felder
(pressure_level{l}/temperature_level{l}/height_agl_level{l}) sind über dieselbe
Open-Meteo-API bereits verfügbar (siehe droneforecast/src/column.js als Vorlage).

Dokumentation
-------------
surface_pressure/QFE ist damit ein abgeleiteter, heuristischer Wert (WMO-Reduktion),
kein direkter Modell-Output. Bitte in der API-/Feld-Doku entsprechend kennzeichnen
(Quelle + Verfahren), damit das an keiner Stelle als Rohmodellwert missverstanden wird.
