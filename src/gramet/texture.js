/**
 * Wolkendarstellung nach der Ogimet-GRAMET-Technik: viele kleine, flache
 * Ellipsen, jede erst weiß gefüllt UND DANN grau umrandet, in zufälliger
 * Reihenfolge übereinander.
 *
 * Der ganze Look hängt an dieser Reihenfolge. Weil jede Ellipse ihre Kontur
 * sofort nach ihrer Füllung zieht, übermalen die Füllungen späterer Ellipsen
 * die Ränder früherer. Innen bleiben nur vereinzelte graue Fetzen stehen (die
 * charakteristische Fleckigkeit), am Rand der Wolkenmasse überlebt die Kontur
 * und bildet die ausgefranste, handgezeichnete Silhouette. Zeichnete man erst
 * alle Füllungen und dann alle Ränder, entstünde ein Gitterbild -- also NICHT
 * die beiden Durchgänge trennen. Aus demselben Grund muss die Zeichenreihen-
 * folge gemischt sein: läuft sie zeilenweise, übermalt systematisch immer die
 * untere Reihe die obere und es sieht aus wie Dachschindeln.
 *
 * Zweite Zutat ist die Maske. Säßen die Ellipsen strikt in Gitterzellen mit
 * `cloudFrac` über der Schwelle, zeichneten sich die Zellkanten als Rechtecke
 * ab. Stattdessen wird `cloudFrac` bilinear in den PIXELRAUM interpoliert und
 * die Schwelle mit zwei Oktaven Value-Noise gestört. Die Ellipsendichte
 * skaliert mit dem Überschuss über der Schwelle: dünne Bewölkung wird licht
 * und löchrig, der blaue Hintergrund schimmert durch die Lücken und erzeugt
 * die Tiefenwirkung ganz ohne Schatten.
 *
 * Anders als die Vorgängerversion (Striche, direkt gezeichnet) läuft das über
 * ein Offscreen-Canvas mit Cache: die Ellipsenzahl liegt bei durchgehender
 * Bewölkung im hohen 4- bis 5-stelligen Bereich, und `render.js` baut bei
 * JEDER State-Änderung (Layer-Toggle, Hover-Resize) den ganzen Canvas neu auf.
 * Gecacht wird über die Chartgeometrie + Höhenband, ein Layer-Toggle blittet
 * also nur noch. Cache am `grid`-Objekt (WeakMap): neue Daten -> neues Gitter
 * -> automatisch neue Textur, ohne Invalidierungslogik.
 */

import { CF_FEW } from "../clouds.js";
import { hashSeed, mulberry32, valueNoise } from "./noise.js";

/**
 * Kalibrierparameter -- Namen, Einheiten und Wirkung identisch zum
 * Wolken-Tuner (`wolken-tuner.html`), damit dessen JSON hier 1:1 eingesetzt
 * werden kann. `seed` fehlt bewusst: der Seed kommt aus Ort + Zeitreihenstart,
 * sonst wäre das Muster nicht mehr an die Daten gebunden.
 *
 * Die Werte hier entsprechen dem Stand vor der Kalibrierung. Die Tuner-
 * Voreinstellungen weichen ab (density 30, threshold 0.30, gain 2.2,
 * noiseScale 0.025, noiseAmp 0.18) -- beim Übernehmen unbedingt `threshold`
 * beachten, s. dort.
 */
const TUNING = {
  // Ellipsenform: flach und breit, das Seitenverhältnis macht den
  // Wolkencharakter aus.
  wMin: 8, wMax: 24,        // Breite in px
  hMin: 3, hMax: 6,         // Höhe in px

  // Dichte in der Zählweise des Tuners (Versuche = density * 800 auf dessen
  // 960x560-Fläche); unten auf die tatsächliche Chartfläche umgerechnet, der
  // Reglerwert wirkt hier also genauso wie dort.
  density: 35,

  // Ab welcher Wolkenfraktion überhaupt gezeichnet wird. ACHTUNG, das ist
  // keine reine Optik: Vorgabe ist die meteorologische FEW-Schwelle aus
  // `clouds.js`. Zieht man sie auf den Tuner-Vorgabewert 0.30 hoch,
  // verschwinden SCT-Schichten (0.25) vollständig aus dem Chart.
  threshold: CF_FEW,

  // Steilheit der Annahmekennlinie: p = min(1, (frac - threshold) * gain).
  // 1/gain ist die Spanne über der Schwelle bis zur vollen Dichte --
  // 1.33 entspricht "voll ab Bedeckung 0.85".
  gain: 1 / 2.5,

  // Maskenstörung: zwei Oktaven Value-Noise auf die Schwelle. `noiseScale`
  // ist die Frequenz in 1/px (Kehrwert der Wellenlänge: 0.0385 ~ 26 px),
  // `noiseAmp` die Amplitude in cloudFrac-Einheiten.
  noiseScale: 1 / 26, noiseAmp: 0.15,

  // Kontur.
  gray: 150, grayAlpha: 0.6, strokeWidth: 2,
};

const SPOT_FILL = "#fff";

// Zweite Oktave auf krummem Frequenzverhältnis (wie im Tuner): bei glatt 2.0
// fielen beide Rauschgitter aufeinander und man sähe wieder ein Raster.
const FBM_OCTAVE = 2.1, FBM_W1 = 0.65, FBM_W2 = 0.35;

// Umrechnung der Tuner-Dichte auf eine flächenbezogene Größe. Der Tuner
// verteilt `density * 800` Versuche über sein festes 960x560-Canvas; hier ist
// die Chartfläche variabel, also wird auf Versuche je 1000 px² normiert.
// Flächenbezug ist ohnehin zwingend: Modell-Level liegen am Boden dicht und
// oben weit auseinander, die Höhenachse staucht zusätzlich (log) bzw. streckt
// (lin). Zählte man je Gitterzelle, schwankte die sichtbare Dichte um Faktor
// ~35 über die Achse (am Boden ~5x dünner als in 10 km).
const TUNER_CANVAS_PX2 = 960 * 560;
const spotsPer1000px2 = () => TUNING.density * 800 / TUNER_CANVAS_PX2 * 1000;

// Auflösung der Maske in der Senkrechten (Pixel je Stützzeile). Bewusst
// unabhängig von der Dichte, damit sich beim Drehen an `density` nicht auch
// die Maskenschärfe ändert.
const MASK_ROW_PX = 4;

const cacheByGrid = new WeakMap();

/**
 * Zeichnet die Wolken in den Haupt-Canvas-Kontext (aus dem Cache geblittet,
 * bei Bedarf vorher offscreen aufgebaut).
 */
export function drawClouds(ctx, grid, cloudFrac, x, y) {
  const w = Math.max(1, Math.round(x.right - x.left));
  const h = Math.max(1, Math.round(y.bot - y.top));
  // Der Mittenwert unterscheidet log- von lin-Achse (gleiche Ränder, andere
  // Kennlinie) -- ohne ihn träfe der Cache beim Umschalten fälschlich zu.
  const key = [w, h, grid.times.length,
    y.inv(y.top).toFixed(2), y.inv((y.top + y.bot) / 2).toFixed(2), y.inv(y.bot).toFixed(2),
  ].join("|");

  let entry = cacheByGrid.get(grid);
  if (!entry || entry.key !== key) {
    entry = { key, canvas: paintOffscreen(grid, cloudFrac, x, y, w, h) };
    cacheByGrid.set(grid, entry);
  }
  ctx.drawImage(entry.canvas, x.left, y.top, w, h);
}

function paintOffscreen(grid, cloudFrac, x, y, w, h) {
  const dpr = window.devicePixelRatio || 1;
  const off = document.createElement("canvas");
  off.width = Math.round(w * dpr);
  off.height = Math.round(h * dpr);
  const octx = off.getContext("2d");
  octx.scale(dpr, dpr);
  // Im Offscreen liegt der Ursprung auf der linken oberen Chartecke; die
  // Skalen x()/y() rechnen weiterhin in Chartkoordinaten.
  octx.translate(-x.left, -y.top);
  paintClouds(octx, grid, cloudFrac, x, y);
  return off;
}

function paintClouds(ctx, grid, cloudFrac, x, y) {
  const { meta, times } = grid;
  const rng = mulberry32(hashSeed(`${meta.lat},${meta.lon},${meta.elevation},${times[0]}`));
  const noiseSeed = hashSeed(`noise:${meta.lat},${meta.lon},${times[0]}`);
  const mask = buildMask(grid, cloudFrac, x, y);

  // Kandidatenfläche über die Chartfläche hinaus erweitern, um die halbe
  // maximale Ellipsengröße: sonst fehlen am Rand die Ellipsen, deren
  // Mittelpunkt knapp draußen liegt, und die Randzone wäre systematisch
  // dünner als das Innere. Der Clip beim Zeichnen schneidet den Überstand ab.
  const padX = TUNING.wMax / 2, padY = TUNING.hMax / 2;
  const rx0 = x.left - padX, ry0 = y.top - padY;
  const rw = (x.right - x.left) + 2 * padX, rh = (y.bot - y.top) + 2 * padY;
  const attempts = Math.round(spotsPer1000px2() * rw * rh / 1000);

  ctx.save();
  // Ellipsen sind bis `wMax` breit -- ohne Clip ragten sie über die Höhenachse
  // und in den rechten Rand mit den Linien-Labels.
  ctx.beginPath();
  ctx.rect(x.left, y.top, x.right - x.left, y.bot - y.top);
  ctx.clip();
  ctx.fillStyle = SPOT_FILL;
  ctx.strokeStyle = `rgba(${TUNING.gray},${TUNING.gray},${TUNING.gray},${TUNING.grayAlpha})`;
  ctx.lineWidth = TUNING.strokeWidth;

  // Positionen gleichverteilt ziehen (nicht auf einem Raster): damit ist die
  // Zeichenreihenfolge von sich aus räumlich zufällig. Das ist Bedingung für
  // den Überdeckungseffekt -- liefe sie zeilenweise, übermalte systematisch
  // die spätere Reihe die frühere und es sähe aus wie Dachschindeln.
  for (let i = 0; i < attempts; i++) {
    const cx = rx0 + rng() * rw, cy = ry0 + rng() * rh;
    const base = mask.at(cx, cy);
    // Rauschen ausblenden, wo gar keine Wolke ist: additiv allein kann es die
    // Schwelle aus klarer Luft heraus überschreiten und Wolkenfetzen im Nichts
    // erfinden (passiert, sobald `noiseAmp` an `threshold` heranreicht -- bei
    // den Tuner-Vorgaben 0.18 < 0.30 nicht, bei unserer FEW-Schwelle 0.10
    // sehr wohl). Unterhalb der Schwelle läuft die Amplitude linear aus, an
    // der Kante wirkt sie voll -- genau dort soll sie ja ausfransen.
    const noiseGate = Math.min(1, base / TUNING.threshold);
    const frac = base + TUNING.noiseAmp * noiseGate * maskNoise(noiseSeed, cx, cy);
    if (frac <= TUNING.threshold) continue;
    // Dichte skaliert mit dem Überschuss über der Schwelle: dünne Bewölkung
    // wird licht und löchrig statt gleichmäßig blass.
    if (rng() >= Math.min(1, (frac - TUNING.threshold) * TUNING.gain)) continue;

    const ew = TUNING.wMin + rng() * (TUNING.wMax - TUNING.wMin);
    const eh = TUNING.hMin + rng() * (TUNING.hMax - TUNING.hMin);
    ctx.beginPath();
    ctx.ellipse(cx, cy, ew / 2, eh / 2, 0, 0, Math.PI * 2);
    ctx.fill();   // Reihenfolge fill -> stroke JE Ellipse, siehe Kopfkommentar.
    ctx.stroke();
  }
  ctx.restore();
}

// --- Cb-Schaft: dieselbe Technik, sandfarben ---------------------------------

/**
 * Kalibrierparameter des Cb-Schafts, Bedeutung wie in `TUNING` (Tuner-
 * Konvention). Eigener Satz, weil der Schaft anders aussehen muss als die
 * Schichtbewölkung: Inneres praktisch deckend (im Original schimmert dort
 * KEIN Blau durch, s. Referenz-Screenshot), Ellipsen etwas kleiner, Rauschen
 * gröber und kräftiger, damit die Säulenränder die typischen Beulen bekommen.
 */
const CB_TUNING = {
  wMin: 6, wMax: 14, hMin: 3, hMax: 6,
  // ~5-fache Überdeckung im Inneren -> Restlöcher < 1 %.
  density: 90,
  // Die Schaft-"Maske" ist eine Abstandsrampe (s. `paintCbRun`): 1 tief im
  // Inneren, 0.5 exakt auf der Rechteckkante, 0 eine Fransenbreite draußen.
  // threshold 0.5 legt die sichtbare Kante also auf die Geometrie, das
  // Rauschen verschiebt sie lokal um bis zu +-noiseAmp Rampeneinheiten.
  // gain ist an noiseAmp GEKOPPELT: 1/(1 - threshold - noiseAmp) ist der
  // kleinste Wert, bei dem das Innere (ramp = 1) auch beim ungünstigsten
  // Rauschwert (-noiseAmp) gesättigt bleibt -- darunter stanzt das koharente
  // Rauschen Löcher in den Schaft (bei einer nur ~28 px schmalen Säule liegt
  // fast alles im Fransenband, das fiel sofort auf). Wer noiseAmp erhöht,
  // muss gain mitziehen.
  threshold: 0.5, gain: 1 / (1 - 0.5 - 0.3),
  noiseScale: 1 / 14, noiseAmp: 0.3,
  // Halbe Breite der Abstandsrampe in px (Kante +- fringePx).
  fringePx: 9,
  fill: "#e9d5b5", gray: 130, grayAlpha: 0.75, strokeWidth: 1,
};

/**
 * Cb-Schäfte mit der Ellipsentechnik zeichnen. `cb` ist das Array aus
 * `derive.js` (`{base, top}` je Stunde oder null). Aufeinanderfolgende
 * Cb-Stunden werden zu EINEM Lauf zusammengefasst und mit durchgehender,
 * zwischen den Stundenmitten interpolierter Ober-/Unterkante gezeichnet --
 * zeichnete man je Stunde eine eigene Säule, entstünde an jeder gemeinsamen
 * Kante eine Doppelfranse quer durch die Wolkenmasse.
 *
 * Kein Offscreen-Cache wie bei den Schichtwolken: Cb-Läufe sind klein
 * (wenige tausend Ellipsen selbst bei mehrstündigen Gewitterlagen).
 * Seed je Lauf aus Ort + Startstunde: Läufe würfeln unabhängig voneinander
 * (gleiche Überlegung wie beim Niederschlag, s. `render.js` `drawPrecip`).
 */
export function drawCbShafts(ctx, grid, cb, x, y) {
  if (!cb) return;
  const { meta, times } = grid;
  const dt = times.length > 1 ? times[1] - times[0] : 3600;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x.left, y.top, x.right - x.left, y.bot - y.top);
  ctx.clip();
  ctx.fillStyle = CB_TUNING.fill;
  const g = CB_TUNING.gray;
  ctx.strokeStyle = `rgba(${g},${g},${g},${CB_TUNING.grayAlpha})`;
  ctx.lineWidth = CB_TUNING.strokeWidth;

  for (let i = 0; i < times.length; i++) {
    if (!cb[i]) continue;
    let j = i;
    while (j + 1 < times.length && cb[j + 1]) j++;
    const pts = [];
    for (let k = i; k <= j; k++) {
      pts.push({ cx: x(times[k]), yT: y(cb[k].top), yB: y(Math.max(0, cb[k].base)) });
    }
    const seed = hashSeed(`cb:${meta.lat},${meta.lon},${times[i]}`);
    paintCbRun(ctx, seed, pts, x(times[i] - dt / 2), x(times[j] + dt / 2));
    i = j;
  }
  ctx.restore();
}

function paintCbRun(ctx, seed, pts, X0, X1) {
  const T = CB_TUNING;
  const rng = mulberry32(seed);

  // Ober-/Unterkante an der Stelle `cx`: zwischen den Stundenmitten linear,
  // davor/danach konstant (halbe Randspalte).
  const edge = (cx, key) => {
    if (cx <= pts[0].cx) return pts[0][key];
    for (let k = 1; k < pts.length; k++) {
      if (pts[k].cx >= cx) {
        const a = pts[k - 1], b = pts[k];
        return a[key] + (cx - a.cx) / (b.cx - a.cx) * (b[key] - a[key]);
      }
    }
    return pts[pts.length - 1][key];
  };

  // Kandidatenfläche: Lauf-Hülle plus Franse plus halbe Maximalellipse.
  const yT = Math.min(...pts.map((p) => p.yT)), yB = Math.max(...pts.map((p) => p.yB));
  const pad = T.fringePx + T.wMax / 2;
  const rx0 = X0 - pad, ry0 = yT - pad;
  const rw = (X1 - X0) + 2 * pad, rh = (yB - yT) + 2 * pad;
  if (!(rw > 0) || !(rh > 0)) return;
  const attempts = Math.round(T.density * 800 / TUNER_CANVAS_PX2 * rw * rh);

  for (let i = 0; i < attempts; i++) {
    const cx = rx0 + rng() * rw, cy = ry0 + rng() * rh;
    // Vorzeichenbehafteter Abstand zur Laufkontur (innen positiv), als Rampe
    // auf [0,1]: 0.5 exakt auf der Kante, s. Kommentar an CB_TUNING.threshold.
    const d = Math.min(cx - X0, X1 - cx, cy - edge(cx, "yT"), edge(cx, "yB") - cy);
    const ramp = clamp(0.5 + d / (2 * T.fringePx), 0, 1);
    // Rauschen bewusst UNGEDÄMPFT addiert (anders als bei den Schichtwolken):
    // es soll die Kante verschieben -- Beulen nach außen, Kerben nach innen,
    // Reichweite +-noiseAmp * 2 * fringePx Pixel. Das Innere schützt nicht
    // eine Dämpfung, sondern die gain-Kopplung (s. CB_TUNING): selbst beim
    // ungünstigsten Rauschwert bleibt die Annahme dort bei 1. Fetzen im
    // Nichts kann es ebenfalls nicht geben, solange noiseAmp < threshold.
    const v = ramp + T.noiseAmp * cbNoise(seed, cx, cy);
    if (v <= T.threshold) continue;
    if (rng() >= Math.min(1, (v - T.threshold) * T.gain)) continue;

    const ew = T.wMin + rng() * (T.wMax - T.wMin);
    const eh = T.hMin + rng() * (T.hMax - T.hMin);
    ctx.beginPath();
    ctx.ellipse(cx, cy, ew / 2, eh / 2, 0, 0, Math.PI * 2);
    ctx.fill();   // fill -> stroke je Ellipse, wie bei den Schichtwolken.
    ctx.stroke();
  }
}

// Eigene Oktav-Salts (2/3), damit das Schaftrauschen nicht mit dem
// Schichtwolkenrauschen desselben Seeds korreliert.
function cbNoise(seed, px, py) {
  const s = CB_TUNING.noiseScale;
  const a = valueNoise(seed, px * s, py * s, 2);
  const b = valueNoise(seed, px * s * FBM_OCTAVE, py * s * FBM_OCTAVE, 3);
  return (FBM_W1 * a + FBM_W2 * b - 0.5) * 2;
}

// --- Maske: cloudFrac bilinear im Pixelraum ----------------------------------

/**
 * `cloudFrac` auf ein pixelbezogenes Zwischengitter umtasten: Spalten sind die
 * Zeitschritte, Zeilen liegen äquidistant in PIXELN (nicht in Metern). Die
 * Höhenachse ist nichtlinear und die Modell-Level sind ungleich verteilt --
 * beides wird damit einmalig aufgelöst, danach ist `at()` reine Bilinear-
 * interpolation und billig genug für zehntausende Abfragen.
 */
function buildMask(grid, cloudFrac, x, y) {
  const { nk, times } = grid, nt = times.length;
  const rows = Math.max(2, Math.ceil((y.bot - y.top) / MASK_ROW_PX) + 1);
  const table = new Float32Array(nt * rows);
  for (let r = 0; r < rows; r++) {
    const z = y.inv(y.top + r * MASK_ROW_PX);
    for (let i = 0; i < nt; i++) table[i * rows + r] = fracInColumn(grid, cloudFrac, i, z, nk);
  }

  const spanX = x.right - x.left;
  return {
    at(px, py) {
      const fi = clamp((px - x.left) / spanX * (nt - 1), 0, nt - 1);
      const fr = clamp((py - y.top) / MASK_ROW_PX, 0, rows - 1);
      const i0 = Math.floor(fi), r0 = Math.floor(fr);
      const i1 = Math.min(i0 + 1, nt - 1), r1 = Math.min(r0 + 1, rows - 1);
      const ft = fi - i0, fz = fr - r0;
      const a = table[i0 * rows + r0], b = table[i1 * rows + r0];
      const c = table[i0 * rows + r1], d = table[i1 * rows + r1];
      return (a + (b - a) * ft) * (1 - fz) + (c + (d - c) * ft) * fz;
    },
  };
}

/** cloudFrac einer Zeitspalte auf Höhe `z` (linear zwischen den Levels). */
function fracInColumn(grid, cloudFrac, i, z, nk) {
  const base = i * nk;
  if (z <= grid.z[base]) return cloudFrac[base];
  let k = 1;
  while (k < nk && grid.z[base + k] < z) k++;
  if (k >= nk) return 0; // oberhalb des obersten Levels: keine Wolke
  const z0 = grid.z[base + k - 1], z1 = grid.z[base + k];
  const f = z1 > z0 ? (z - z0) / (z1 - z0) : 0;
  return cloudFrac[base + k - 1] + f * (cloudFrac[base + k] - cloudFrac[base + k - 1]);
}

// --- Value-Noise --------------------------------------------------------------

// Bewusst im PIXELRAUM (nicht in Zeit/Höhe): die Franserei am Wolkenrand soll
// über den ganzen Chart gleich grob aussehen, unabhängig davon, wie stark die
// Höhenachse an dieser Stelle staucht.
function maskNoise(seed, px, py) {
  const s = TUNING.noiseScale;
  const a = valueNoise(seed, px * s, py * s, 0);
  const b = valueNoise(seed, px * s * FBM_OCTAVE, py * s * FBM_OCTAVE, 1);
  return (FBM_W1 * a + FBM_W2 * b - 0.5) * 2; // nullsymmetrisch, [-1,1]
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
