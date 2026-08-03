/**
 * Leitet aus dem Zeit-Höhen-Gitter (`grid.js`) alles ab, was `render.js`
 * zeichnet: Isothermen, Isotachen, Tropopause, Tag/Nacht-Verlauf, Wolkenbasis,
 * Niederschlag, Hazard-Durchreichung. Alles in (Zeitindex/Unixzeit, Höhe m
 * AGL) — die Pixel-Projektion ist Sache des Renderers.
 */

import { derive as deriveGrid } from "./grid.js";
import { CF_FEW, CF_BKN } from "../clouds.js";
import { sunAltitude } from "../astro.js";
import { metarWeather } from "../briefing.js";
import * as icing from "./hazards/icing.js";
import * as turbulence from "./hazards/turbulence.js";

const KELVIN = 273.15;
const KT_PER_MS = 1.94384;
const FOG_BASE_M = 30; // m AGL — mirrors clouds.js FOG_BASE_M (nicht exportiert)
const ISOTHERM_MAX_JUMP_M = 1500; // m je Spaltenschritt, s. METHODIK/Plan
const ISOTHERM_THRESHOLDS_C = [0, -20, -40];
const ISOTACH_THRESHOLDS_KT = [50, 75, 100];

// CB-Erkennung: HEURISTIK, kein Modell-Flag (Open-Meteo liefert keine direkte
// Konvektions-/Cb-Kennung). Kombiniert Oberflächen-CAPE mit vergletschertem
// Wolkenoberrand (T <= -20 °C bei CF >= CF_BKN) ODER einem kräftigen Updraft
// irgendwo im Profil. Schwellwerte nicht kalibriert — grober erster Ansatz,
// per Screenshot-Vergleich mit echten GRAMETs nachzuschärfen (s. M3-Hinweis
// in render.js zur Wolkentextur-Kalibrierung).
const CB_CAPE_MIN_JKG = 300;
const CB_UPDRAFT_MIN_MS = 3;
// Ersatz-Oberrand, wenn weder ein vergletschertes Wolkenniveau noch überhaupt
// eine Wolkenspur im Profil gefunden wird (z. B. Gewitter nur via weather_code
// gemeldet) -- NICHT der Modelldeckel, s. PRECIP_FALLBACK_TOP_M.
const CB_FALLBACK_TOP_M = 6000;

// Fällt keine Wolke im CF_FEW-Sinn im Profil auf (Niederschlag aber laut
// weather_code/Menge gemeldet), Ersatz-Obergrenze für den Niederschlags-
// vorhang -- NICHT der Modelldeckel (führte zum "bis in die Stratosphäre"-
// Artefakt, s. Feedback). Grobe Annahme für flachen Nieselregen/Sprühregen.
const PRECIP_FALLBACK_TOP_M = 2000;
// Unterhalb dieser Menge (mm/h) gilt Niederschlag als nicht mehr relevant für
// den Vorhang, selbst wenn weather_code noch "-RA" o.ä. meldet (Rundungsreste).
const PRECIP_MIN_RATE = 0.05;

export function deriveView(grid) {
  const d = deriveGrid(grid);
  const isotherms = ISOTHERM_THRESHOLDS_C.map((tempC) => ({ tempC, polylines: isothermPolylines(grid, tempC) }));
  const isotachs = ISOTACH_THRESHOLDS_KT.map((kt) => ({ kt, polylines: contour(grid, d.wspd, kt / KT_PER_MS) }));
  const tropopauseLine = tropopause(grid);
  const daylightArr = daylight(grid);
  const nt = grid.times.length;
  const cloudBase = new Float32Array(nt);
  for (let i = 0; i < nt; i++) cloudBase[i] = cloudBaseAt(grid, d.cloudFrac, i);

  return {
    isotherms,
    isotachs,
    tropopause: tropopauseLine,
    daylight: daylightArr,
    cloudFrac: d.cloudFrac,
    cloudBase,
    precip: precipEntries(grid, cloudBase),
    cb: cbColumns(grid, d.cloudFrac, cloudBase),
    hazards: { icing: icing.computeGrid(grid), turbulence: turbulence.computeGrid(grid) },
  };
}

// --- Isothermen (spaltenweise Kreuzungssuche, s. Plan) ----------------------

function isothermPolylines(grid, thresholdC) {
  const thrK = thresholdC + KELVIN;
  const { nk, times } = grid, nt = times.length;
  const active = []; // { line:[{t,z}], lastZ, lastI }
  const finished = [];

  for (let i = 0; i < nt; i++) {
    const zs = columnCrossings(grid, i, thrK);
    const usedZ = new Array(zs.length).fill(false);

    for (const a of active) {
      if (a.lastI !== i - 1) continue; // schon geschlossen (Lücke im Vorschritt)
      let bestJ = -1, bestD = Infinity;
      for (let j = 0; j < zs.length; j++) {
        if (usedZ[j]) continue;
        const dist = Math.abs(zs[j] - a.lastZ);
        if (dist < bestD) { bestD = dist; bestJ = j; }
      }
      if (bestJ >= 0 && bestD < ISOTHERM_MAX_JUMP_M) {
        usedZ[bestJ] = true;
        a.line.push({ t: times[i], z: zs[bestJ] });
        a.lastZ = zs[bestJ]; a.lastI = i;
      }
    }
    for (const a of active) if (a.lastI < i && a.line.length > 1) finished.push(a.line);
    for (let ai = active.length - 1; ai >= 0; ai--) if (active[ai].lastI < i) active.splice(ai, 1);
    for (let j = 0; j < zs.length; j++) {
      if (!usedZ[j]) active.push({ line: [{ t: times[i], z: zs[j] }], lastZ: zs[j], lastI: i });
    }
  }
  for (const a of active) if (a.line.length > 1) finished.push(a.line);
  return finished;
}

function columnCrossings(grid, i, thrK) {
  const { nk } = grid;
  const zs = [];
  for (let k = 0; k < nk - 1; k++) {
    const ix0 = i * nk + k, ix1 = i * nk + k + 1;
    const T0 = grid.T[ix0], T1 = grid.T[ix1];
    if (!Number.isFinite(T0) || !Number.isFinite(T1)) continue;
    if ((T0 >= thrK) !== (T1 >= thrK)) {
      const f = (thrK - T0) / (T1 - T0);
      zs.push(grid.z[ix0] + f * (grid.z[ix1] - grid.z[ix0]));
    }
  }
  return zs;
}

// --- Isotachen (marching squares) --------------------------------------------

/** Generische Konturlinien-Extraktion auf einem (Zeit x Level)-Feld — auch für
 *  spätere Hazard-Flächenumrisse wiederverwendbar (s. Plan). */
export function contour(grid, field, threshold) {
  const { nk, times } = grid, nt = times.length;
  const segments = [];

  for (let i = 0; i < nt - 1; i++) {
    for (let k = 0; k < nk - 1; k++) {
      const i00 = i * nk + k, i10 = (i + 1) * nk + k, i11 = (i + 1) * nk + k + 1, i01 = i * nk + k + 1;
      const v00 = field[i00], v10 = field[i10], v11 = field[i11], v01 = field[i01];
      if (![v00, v10, v11, v01].every(Number.isFinite)) continue;
      const p00 = { t: times[i], z: grid.z[i00] }, p10 = { t: times[i + 1], z: grid.z[i10] };
      const p11 = { t: times[i + 1], z: grid.z[i11] }, p01 = { t: times[i], z: grid.z[i01] };

      const bottom = crossesEdge(v00, v10, threshold) ? edgePoint(threshold, v00, v10, p00, p10) : null;
      const right = crossesEdge(v10, v11, threshold) ? edgePoint(threshold, v10, v11, p10, p11) : null;
      const top = crossesEdge(v01, v11, threshold) ? edgePoint(threshold, v01, v11, p01, p11) : null;
      const left = crossesEdge(v00, v01, threshold) ? edgePoint(threshold, v00, v01, p00, p01) : null;
      const crossing = [bottom, right, top, left].filter(Boolean);
      if (crossing.length === 2) { segments.push(crossing); continue; }
      if (crossing.length === 4) {
        // Sattelfall (zwei gegenüberliegende Ecken über der Schwelle): Paarung
        // über den Zellmittelwert entscheiden (asymptotic decider).
        const center = (v00 + v10 + v11 + v01) / 4;
        const b00 = v00 >= threshold, b11 = v11 >= threshold;
        const highDiagonal = b00 && b11;
        if (highDiagonal === (center >= threshold)) {
          segments.push([bottom, left]); segments.push([top, right]);
        } else {
          segments.push([bottom, right]); segments.push([top, left]);
        }
      }
    }
  }
  return chainSegments(segments);
}

function crossesEdge(va, vb, threshold) { return (va >= threshold) !== (vb >= threshold); }
function edgePoint(threshold, va, vb, pa, pb) {
  const f = (threshold - va) / (vb - va);
  return { t: pa.t + f * (pb.t - pa.t), z: pa.z + f * (pb.z - pa.z) };
}

// Segmente (je zwei Endpunkte) zu Polylinien verketten. Ein innerer Kreuzungs-
// punkt wird von genau zwei Nachbarzellen mit identischen Eingabewerten
// berechnet -> bitgleich, daher reicht ein einfacher String-Schlüssel.
function chainSegments(segments) {
  const key = (p) => `${p.t}|${p.z}`;
  const pointMap = new Map();
  segments.forEach((seg, si) => {
    for (const end of [0, 1]) {
      const k = key(seg[end]);
      if (!pointMap.has(k)) pointMap.set(k, []);
      pointMap.get(k).push({ si, end });
    }
  });
  const used = new Array(segments.length).fill(false);
  const polylines = [];
  const extend = (chain, forward) => {
    for (;;) {
      const p = forward ? chain[chain.length - 1] : chain[0];
      const candidates = pointMap.get(key(p)) || [];
      const next = candidates.find(({ si }) => !used[si]);
      if (!next) return;
      used[next.si] = true;
      const other = segments[next.si][next.end === 0 ? 1 : 0];
      if (forward) chain.push(other); else chain.unshift(other);
    }
  };
  for (let si = 0; si < segments.length; si++) {
    if (used[si]) continue;
    used[si] = true;
    const chain = [segments[si][0], segments[si][1]];
    extend(chain, true);
    extend(chain, false);
    polylines.push(chain);
  }
  return polylines;
}

// --- Tropopause (WMO-Kriterium) ----------------------------------------------

function tropopause(grid) {
  const { nk, times } = grid, nt = times.length;
  const line = [];
  for (let i = 0; i < nt; i++) {
    let foundZ = NaN;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k, z = grid.z[ix];
      if (!Number.isFinite(z) || z < 5000) continue;
      const zLimit = z + 2000;
      let ok = true, reachedLimit = false;
      for (let k2 = k + 1; k2 < nk; k2++) {
        const ix2 = i * nk + k2, zz = grid.z[ix2];
        if (!Number.isFinite(zz)) break;
        if (zz > zLimit) { reachedLimit = true; break; }
        const lapseKPerKm = -(grid.T[ix2] - grid.T[ix]) / (zz - z) * 1000;
        if (lapseKPerKm > 2) { ok = false; break; }
      }
      // Kein Level bis zur 2-km-Grenze erreicht (Gitter endet zu früh) -> kein
      // Treffer, sonst Fehlalarm am Domänendeckel.
      if (ok && reachedLimit) { foundZ = z; break; }
    }
    if (Number.isFinite(foundZ)) line.push({ t: times[i], z: foundZ });
  }
  return smooth3(line);
}

function smooth3(line) {
  if (line.length < 3) return line;
  const out = [line[0]];
  for (let i = 1; i < line.length - 1; i++) {
    out.push({ t: line[i].t, z: (line[i - 1].z + line[i].z + line[i + 1].z) / 3 });
  }
  out.push(line[line.length - 1]);
  return out;
}

// --- Tag/Nacht ---------------------------------------------------------------

// Kontinuierlicher Faktor: 1 oberhalb 0° Sonnenhöhe, 0 unterhalb -12°
// (nautische Dämmerung), dazwischen linear.
function daylight(grid) {
  const { times, meta } = grid;
  const out = new Float32Array(times.length);
  for (let i = 0; i < times.length; i++) {
    const alt = sunAltitude(times[i] * 1000, meta.lat, meta.lon);
    out[i] = alt >= 0 ? 1 : alt <= -12 ? 0 : (alt + 12) / 12;
  }
  return out;
}

// --- Wolkenbasis + Niederschlag ----------------------------------------------

// Unterkante des untersten zusammenhängenden Bereichs mit cloudFrac >= CF_FEW
// (mirrors clouds.js `lowestCloudBase`, hier direkt auf dem schon berechneten
// Gitter-cloudFrac statt erneuter cloudFraction()-Aufrufe).
function cloudBaseAt(grid, cloudFrac, i) {
  const { nk } = grid;
  let prevH = null, prevCf = null;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k, h = grid.z[ix];
    if (!Number.isFinite(h)) continue;
    const cf = cloudFrac[ix];
    if (cf >= CF_FEW && prevCf != null && prevCf < CF_FEW && prevH != null) {
      const f = (CF_FEW - prevCf) / (cf - prevCf);
      const base = prevH + f * (h - prevH);
      if (base >= FOG_BASE_M) return base;
    } else if (cf >= CF_FEW && prevCf == null && h >= FOG_BASE_M) {
      return h;
    }
    prevH = h; prevCf = cf;
  }
  return NaN;
}

// Obergrenze der zusammenhängenden Wolkenschicht ab `baseH`: kleine, trockene
// Zwischenschichten (< CLOUD_TOP_GAP_TOLERANCE_M) werden überbrückt, damit
// z. B. eine dünne bodennahe Feuchteschicht nicht fälschlich als eigene,
// flache "Wolke" von der eigentlich regnenden Schicht darüber abgeschnitten
// wird (führte zu Niederschlagsvorhängen, die weit unter der sichtbaren
// Wolke endeten, s. Feedback) — eine ECHTE, größere Lücke (z. B. zu isoliert
// darüberliegendem Cirrus) beendet die Schicht aber weiterhin.
const CLOUD_TOP_GAP_TOLERANCE_M = 1200;
function cloudTopAt(grid, cloudFrac, i, baseH) {
  if (!Number.isFinite(baseH)) return NaN;
  const { nk } = grid;
  let top = baseH, lastCloudH = baseH;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k, h = grid.z[ix];
    if (!Number.isFinite(h) || h < baseH) continue;
    const cf = cloudFrac[ix];
    if (cf >= CF_FEW) { lastCloudH = h; top = h; }
    else if (h - lastCloudH > CLOUD_TOP_GAP_TOLERANCE_M) break;
  }
  return top;
}

// Höchstes Level im GESAMTEN Profil mit CF >= CF_FEW (nicht nur die unterste,
// zusammenhängende Schicht wie `cloudTopAt`) -- robuster Fallback, wenn die
// Basis-Erkennung nichts findet, aber irgendwo im Profil doch Wolke steckt.
function anyCloudTopAt(grid, cloudFrac, i) {
  const { nk } = grid;
  let top = NaN;
  for (let k = 0; k < nk; k++) {
    const ix = i * nk + k;
    if (cloudFrac[ix] >= CF_FEW) top = grid.z[ix];
  }
  return top;
}

function freezingHeightAt(grid, i) {
  const { nk } = grid;
  for (let k = 0; k < nk - 1; k++) {
    const ix0 = i * nk + k, ix1 = i * nk + k + 1;
    const T0 = grid.T[ix0] - KELVIN, T1 = grid.T[ix1] - KELVIN;
    if (T0 >= 0 && T1 < 0) {
      const f = T0 / (T0 - T1);
      return grid.z[ix0] + f * (grid.z[ix1] - grid.z[ix0]);
    }
  }
  return NaN;
}

/**
 * Niederschlagseintrag je Stunde: `weather_code` (als METAR-Kürzel, dieselbe
 * Tabelle wie die Wetter-Zeile) entscheidet OB und ALS WAS gezeichnet wird,
 * die Menge (`precipitation`, mm/h) nur, wie DICHT (Intensität). Vorher war
 * die Menge allein das Gate (>0,1 mm/h) -- bei sehr leichtem Niederschlag
 * rundet die Menge oft auf ~0, obwohl weather_code ihn noch meldet, was die
 * Wetter-Zeile und den gezeichneten Vorhang auseinanderlaufen ließ (s.
 * Feedback). Phase (Regen/Schnee) kommt jetzt ebenfalls aus dem METAR-Kürzel
 * (SN/SG/FZ...), nicht mehr nur aus `snowfall > 0`.
 */
function precipEntries(grid, cloudBase) {
  const out = [];
  const { times, surface } = grid;
  if (!surface) return out;
  const cloudFrac = deriveGrid(grid).cloudFrac;
  for (let i = 0; i < times.length; i++) {
    const label = Number.isFinite(surface.wcode?.[i]) ? metarWeather(surface.wcode[i]) : "N/A";
    const amt = surface.precip[i];
    const hasAmount = Number.isFinite(amt) && amt > PRECIP_MIN_RATE;
    const hasWx = label !== "NSW" && label !== "N/A";
    const isFogOnly = label === "FG" || label === "FZFG"; // Nebel ist kein Niederschlag
    if (!hasAmount && (!hasWx || isFogOnly)) continue;

    const freezingZ = freezingHeightAt(grid, i);
    // Oberkante des Vorhangs: zusammenhängende Schicht ab der Basis
    // (`cloudTopAt`, jetzt mit Lückentoleranz, s. dort). Nur wenn gar keine
    // Basis gefunden wurde (Niederschlag laut weather_code/Menge, aber keine
    // Wolke im CF_FEW-Sinn erkannt), Ersatz über die höchste Wolkenspur im
    // ganzen Profil bzw. einen festen Fallback -- NICHT einfach das Maximum
    // aus beidem, sonst reißt der Vorhang bis zu unverbundenem Cirrus weit
    // darüber (nächstes Artefakt, s. Feedback-Iteration).
    const top = cloudTopAt(grid, cloudFrac, i, cloudBase[i]);
    const anyTop = anyCloudTopAt(grid, cloudFrac, i);
    const zTop = Number.isFinite(top) ? top : Number.isFinite(anyTop) ? anyTop : PRECIP_FALLBACK_TOP_M;
    const isSnow = label.includes("SN") || label.includes("SG")
      || (Number.isFinite(surface.snow[i]) && surface.snow[i] > 0);
    // Nominale Mindestrate, wenn nur weather_code (nicht die Menge) den
    // Niederschlag anzeigt -- sonst bliebe der Vorhang trotz "-RA" unsichtbar.
    const rate = hasAmount ? amt : 0.3;
    out.push({ t: times[i], zTop, freezingZ, type: isSnow ? "sn" : "ra", rate });
  }
  return out;
}

/**
 * CB-Spalten (Cumulonimbus) — `weather_code` meldet Gewitter (TS-Kürzel)
 * direkt aus dem Modell, das ist das verlässlichste Signal. HEURISTISCHER
 * Ersatz, wenn kein TS-Code vorliegt: CAPE über Schwelle + vergletscherter
 * Wolkenoberrand (CF >= CF_BKN bei T <= -20 °C), oder ein kräftiger Updraft
 * irgendwo im Profil. Liefert pro Stunde entweder `null` oder `{ base, top }`
 * (m AGL) für den Cb-Schaft im Renderer. CAPE-/Updraft-Schwellen (nicht der
 * weather_code-Pfad) nicht kalibriert.
 */
function cbColumns(grid, cloudFrac, cloudBase) {
  const { nk, times, surface } = grid;
  const out = [];
  for (let i = 0; i < times.length; i++) {
    let maxAbsW = 0, deepTop = NaN;
    for (let k = 0; k < nk; k++) {
      const ix = i * nk + k;
      const w = grid.w[ix];
      if (Number.isFinite(w) && Math.abs(w) > maxAbsW) maxAbsW = Math.abs(w);
      if (cloudFrac[ix] >= CF_BKN && (grid.T[ix] - KELVIN) <= -20) {
        const z = grid.z[ix];
        if (!Number.isFinite(deepTop) || z > deepTop) deepTop = z;
      }
    }
    const label = Number.isFinite(surface?.wcode?.[i]) ? metarWeather(surface.wcode[i]) : "N/A";
    const wxThunder = label.includes("TS");
    const cape = surface?.cape ? surface.cape[i] : NaN;
    const capeSignal = Number.isFinite(cape) && cape >= CB_CAPE_MIN_JKG && Number.isFinite(deepTop);
    const updraftSignal = maxAbsW >= CB_UPDRAFT_MIN_MS;
    if (!wxThunder && !capeSignal && !updraftSignal) { out.push(null); continue; }
    // Kein Modelldeckel als Fallback (derselbe Fehler wie beim Niederschlag,
    // s. precipEntries) -- erst der höchste Level mit irgendeiner
    // Wolkenspur, sonst ein plausibler mittlerer Cb-Oberrand.
    const anyTop = anyCloudTopAt(grid, cloudFrac, i);
    const top = Number.isFinite(deepTop) ? deepTop : Number.isFinite(anyTop) ? anyTop : CB_FALLBACK_TOP_M;
    const base = Number.isFinite(cloudBase[i]) ? cloudBase[i] : 0;
    out.push({ base, top });
  }
  return out;
}
