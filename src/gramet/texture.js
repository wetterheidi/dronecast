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

// --- Cb/TCU: Schaft und Amboss -----------------------------------------------

/**
 * Die Konvektionssäule wird als SILHOUETTE gezeichnet, nicht als Rechteck mit
 * rundum gleicher Franse. Drei Kanten, drei verschiedene Charaktere -- genau
 * das macht eine Säule als Cb/TCU erkennbar, gerade wenn sie über viele
 * Stunden durchläuft und sonst nur ein sandfarbener Fleck wäre:
 *
 *   - UNTERKANTE hart und waagerecht abgeschnitten. Kondensationsniveau ist
 *     eine Fläche, keine Zufallsgrenze; eine ausgefranste Cb-Basis gibt es in
 *     der Natur nicht. Umgesetzt als Clip auf die Basislinie (nicht als
 *     Abstandsrampe) -- so werden auch die Ellipsen, deren Mittelpunkt knapp
 *     darüber liegt, sauber gekappt statt darunter herauszuhängen.
 *   - OBERKANTE gewellt, mit einer Kerbe zwischen je zwei Stunden
 *     (`turretEdge`): der Lauf zerfällt optisch wieder in einzelne Quelltürme.
 *     Die Wellen gehen nur nach UNTEN, nie über den Modelloberrand hinaus --
 *     sonst stieße der Schaft durch den flachen Ambossdeckel.
 *   - SEITEN weich, wie bisher über Rampe + Rauschen.
 *
 * Der Amboss ist eine eigene Region mit umgekehrter Härte (flacher Deckel oben,
 * weiche Unterseite) und sitzt seitlich über den Schaft hinaus -- s.
 * `drawCbAnvils`.
 */

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
  // Die Schaft-"Maske" ist eine Abstandsrampe (s. `paintRegion`): 1 tief im
  // Inneren, 0.5 exakt auf der weichen Kante, 0 eine Fransenbreite draußen.
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
 * Amboss: gleiche Technik, aber vergletschert -- heller (fast weiß, mit einem
 * Rest Sandton, damit er sich vom reinen Weiß der Schichtbewölkung absetzt),
 * flachere und breitere Ellipsen für den faserigen Cirrus-Charakter, gröberes
 * und schwächeres Rauschen (die Ambossränder wehen aus, sie beulen nicht).
 */
const ANVIL_TUNING = {
  wMin: 8, wMax: 20, hMin: 3, hMax: 5,
  density: 70,
  threshold: 0.5, gain: 1 / (1 - 0.5 - 0.25),
  noiseScale: 1 / 18, noiseAmp: 0.25,
  fringePx: 8,
  fill: "#f3ebdc", gray: 140, grayAlpha: 0.7, strokeWidth: 1,
};

// Ambossgeometrie in Pixeln. Die Ausladung skaliert mit der STUNDENBREITE (und
// ist zusätzlich an der Lauflänge gedeckelt, s. Aufrufstelle): würde sie an der
// Lauflänge hängen, bekäme eine sechsstündige Gewitterlage einen absurd weit
// ausgezogenen Deckel. Die Dicke skaliert mit der Schafttiefe, gedeckelt, damit
// flache Zellen keinen Deckel im Verhältnis 1:1 bekommen.
const ANVIL_DEPTH_FRAC = 0.22, ANVIL_DEPTH_MIN = 16, ANVIL_DEPTH_MAX = 60;
const ANVIL_FLARE_CELLS = 0.9, ANVIL_FLARE_MIN = 18, ANVIL_FLARE_MAX = 80;
// Restdicke an der Ambossspitze (Anteil der vollen Dicke) -- die Unterseite
// läuft nach außen keilförmig aus, das ist die Ambossform.
const ANVIL_TIP_FRAC = 0.15;
// Wie weit die Ambossunterseite höchstens nach unten gezogen wird, um an einen
// tiefer liegenden Schaftoberrand anzuschließen (Vielfaches der Dicke).
const ANVIL_MAX_DROP = 2.5;
// Der Ambossdeckel liegt um diesen Betrag ÜBER dem höchsten Schaftoberrand:
// dessen weiche Kante streut um +-noiseAmp*2*fringePx plus halbe Ellipse nach
// oben, und genau diese Fusseln sollen nicht über dem flachen Deckel stehen.
const ANVIL_OVERSHOOT = CB_TUNING.noiseAmp * 2 * CB_TUNING.fringePx + CB_TUNING.hMax / 2;

// Farbe der nachgezogenen Wolkenbasis -- dunkler als die Schaftfüllung, wie die
// beschattete Unterseite einer Konvektionswolke.
const CB_BASE_LINE = "rgba(108,92,72,0.85)";

/**
 * Cb-/TCU-Schäfte mit der Ellipsentechnik zeichnen. `cb` ist das Array aus
 * `derive.js` (`{base, top, kind}` je Stunde oder null). Aufeinanderfolgende
 * Stunden werden zu EINEM Lauf zusammengefasst und mit durchgehender,
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
  const { times } = grid;
  const dt = times.length > 1 ? times[1] - times[0] : 3600;

  ctx.save();
  clipChart(ctx, x, y);
  setSpotStyle(ctx, CB_TUNING);

  for (const [i, j] of runsOf(cb, (c) => !!c)) {
    paintShaft(ctx, runGeometry(grid, cb, x, y, i, j, dt));
  }
  ctx.restore();
}

/**
 * Geometrie eines Schaftlaufs. Bewusst rein aus (grid, cb, Skalen, i, j)
 * abgeleitet und ohne Zustand -- `drawCbAnvils` ruft sie für DENSELBEN Lauf
 * noch einmal auf und bekommt bitweise dieselbe Turmkante (gleicher Seed,
 * gleiche Eingaben). Nur so kann die Ambossunterseite den Kuppeln des Schafts
 * folgen, statt Lücken über den Einkerbungen offen zu lassen.
 */
function runGeometry(grid, cb, x, y, i, j, dt) {
  const { meta, times } = grid;
  const pts = [];
  for (let k = i; k <= j; k++) {
    pts.push({ cx: x(times[k]), yT: y(cb[k].top), yB: y(Math.max(0, cb[k].base)) });
  }
  const X0 = x(times[i] - dt / 2), X1 = x(times[j] + dt / 2);
  const yTop = Math.min(...pts.map((p) => p.yT));
  const yBot = Math.max(...pts.map((p) => p.yB));
  const seed = hashSeed(`cb:${meta.lat},${meta.lon},${times[i]}`);
  const cellPx = pts.length > 1 ? (pts[1].cx - pts[0].cx) : (X1 - X0);
  return {
    pts, X0, X1, yTop, yBot, seed,
    top: turretEdge(seed, pts, X0, X1, yBot - yTop, cellPx),
    bot: (cx) => edgeAt(pts, "yB", cx),
  };
}

function paintShaft(ctx, geom) {
  const { pts, X0, X1, yTop, yBot, seed, top, bot } = geom;
  if (!(X1 > X0) || !(yBot > yTop)) return;

  paintRegion(ctx, seed, CB_TUNING, { x0: X0, x1: X1, hardBot: true, salt: [2, 3], top, bot });

  // Die harte Kante zusätzlich als Linie nachziehen: der Clip allein
  // hinterlässt eine Treppe aus angeschnittenen Ellipsenrändern, erst der
  // Strich macht daraus die eine, durchgehende Wolkenbasis.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(X0, bot(X0));
  for (const p of pts) ctx.lineTo(p.cx, p.yB);
  ctx.lineTo(X1, bot(X1));
  ctx.strokeStyle = CB_BASE_LINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/**
 * Ambosse über die Cb-Läufe legen. Bewusst ein eigener Durchgang NACH den
 * Schichtwolken (s. `render.js`): der Amboss liegt definitionsgemäß im
 * Cirrus-Stockwerk, würde er wie der Schaft vor den Wolken gezeichnet, malte
 * ihn das weiße Ellipsenfeld dort sofort wieder zu und die Form wäre weg.
 *
 * Läufe hier nur über `kind === "cb"`: TCU haben per Definition keinen Amboss.
 * Ein Lauf aus tcu,tcu,cb,cb bekommt also nur über der Cb-Hälfte einen Deckel.
 */
export function drawCbAnvils(ctx, grid, cb, x, y) {
  if (!cb) return;
  const { meta, times } = grid;
  const dt = times.length > 1 ? times[1] - times[0] : 3600;
  const cellW = Math.abs(x(times[0] + dt) - x(times[0]));

  ctx.save();
  clipChart(ctx, x, y);
  setSpotStyle(ctx, ANVIL_TUNING);

  for (const [i, j] of runsOf(cb, (c) => c && c.kind === "cb")) {
    // Turmkante des UMGEBENDEN Schaftlaufs holen (ein Lauf kann tcu- und
    // cb-Stunden mischen) -- die Ambossunterseite muss ihr folgen.
    let a = i, b = j;
    while (a > 0 && cb[a - 1]) a--;
    while (b + 1 < times.length && cb[b + 1]) b++;
    const shaft = runGeometry(grid, cb, x, y, a, b, dt);

    const X0 = x(times[i] - dt / 2), X1 = x(times[j] + dt / 2);
    let yTop = Infinity, yBot = -Infinity;
    for (let k = i; k <= j; k++) {
      yTop = Math.min(yTop, y(cb[k].top));
      yBot = Math.max(yBot, y(Math.max(0, cb[k].base)));
    }
    yTop -= ANVIL_OVERSHOOT;
    if (!(X1 > X0) || !(yBot > yTop)) continue;

    const depth = clamp(ANVIL_DEPTH_FRAC * (yBot - yTop), ANVIL_DEPTH_MIN, ANVIL_DEPTH_MAX);
    // Zusätzlich an der Lauflänge gedeckelt: eine einzelne Cb-Stunde bekäme
    // sonst einen Deckel dreimal so breit wie ihr Schaft (Pilz statt Amboss).
    const flare = clamp(Math.min(ANVIL_FLARE_CELLS * cellW, 0.75 * (X1 - X0)),
      ANVIL_FLARE_MIN, ANVIL_FLARE_MAX);
    // Unterseite: über dem Schaft volle Dicke, nach außen keilförmig auf die
    // Spitzendicke auslaufend (Exponent < 1 -> konkav, wie ein echter Amboss).
    // Über dem Schaft zusätzlich bis auf dessen Turmkante heruntergezogen,
    // sonst klaffte über jeder Einkerbung ein blauer Spalt.
    const bot = (cx) => {
      const t = cx < X0 ? (X0 - cx) / flare : cx > X1 ? (cx - X1) / flare : 0;
      const wedge = yTop + depth * (1 - (1 - ANVIL_TIP_FRAC) * Math.pow(clamp(t, 0, 1), 0.65));
      if (t > 0) return wedge;
      return Math.min(Math.max(wedge, shaft.top(cx)), yTop + ANVIL_MAX_DROP * depth);
    };

    const seed = hashSeed(`anvil:${meta.lat},${meta.lon},${times[i]}`);
    paintRegion(ctx, seed, ANVIL_TUNING, {
      x0: X0 - flare, x1: X1 + flare, hardTop: true, salt: [4, 5],
      top: () => yTop, bot,
    });
  }
  ctx.restore();
}

/**
 * Oberkante eines Schaftlaufs als Quellturm-Profil: je Stunde eine Kuppel
 * (Ellipsenbogen), die Kante ist deren UNTERE EINHÜLLENDE (Minimum in y).
 * Weil die Kuppeln breiter sind als der Stundenabstand, überschneiden sie sich
 * und hinterlassen zwischen zwei Türmen eine Einkerbung -- genau die Kontur
 * eines mehrzelligen Quellwolkenfeldes.
 *
 * Bewusst NICHT als Stützstellen-Interpolation zwischen Scheitel und Kerbe:
 * damit werden die Scheitel flach und die Flanken steil, der Lauf sah aus wie
 * eine Zinnenmauer. Die Einhüllende macht es umgekehrt richtig herum -- runde
 * Kuppen, scharfe Kerben.
 *
 * Wichtig: die Auslenkung geht nur nach UNTEN (kein Punkt liegt über dem
 * gerechneten Oberrand). Ein Turm ÜBER dem Modellwert würde den flachen
 * Ambossdeckel durchstoßen, der auf dem höchsten Oberrand des Laufs sitzt.
 *
 * Die Amplitude muss deutlich über der Rauschweite des Randes liegen
 * (+-noiseAmp*2*fringePx ~ 5 px), sonst verwäscht das Rauschen die Kerben und
 * der Lauf sieht wieder aus wie ein glatter Klotz.
 */
function turretEdge(seed, pts, X0, X1, depthPx, cellPx) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const amp = clamp(depthPx * 0.2, 14, 60);
  const domes = pts.map((p) => ({
    cx: p.cx,
    // Halbe Kuppelbreite knapp über halbem Stundenabstand: die Kuppeln
    // überlappen gerade so, dass die Kerbe rund die halbe Amplitude tief wird.
    // Deutlich breiter (>= 0.7) und die Kerben verschwinden fast ganz.
    w: Math.max(6, cellPx * (0.52 + 0.14 * rng())),
    a: amp * (0.75 + 0.5 * rng()),
    // Scheitel dürfen nur nach unten abweichen (s. Ambossdeckel oben).
    y: p.yT + amp * 0.25 * rng(),
  }));
  // Wo keine Kuppel greift (Laufrand, oder wenn die Stunden weiter auseinander
  // liegen als die Kuppeln breit sind), liegt die Kante auf Schulterhöhe.
  return (cx) => {
    let best = edgeAt(pts, "yT", cx) + amp;
    for (const d of domes) {
      const u = (cx - d.cx) / d.w;
      if (u <= -1 || u >= 1) continue;
      const yq = d.y + d.a * (1 - Math.sqrt(1 - u * u));
      if (yq < best) best = yq;
    }
    return best;
  };
}

/**
 * Ellipsentextur in ein Gebiet zwischen zwei x-abhängigen Kanten füllen.
 *
 * `reg.hardTop`/`reg.hardBot` schalten die jeweilige Kante von "weich" auf
 * "hart": weiche Kanten gehen über die Abstandsrampe + Rauschen (sie fransen
 * aus, deshalb wird auch über die Kante hinaus gestreut), harte Kanten stehen
 * im CLIP-Pfad und schneiden die Ellipsen exakt auf der Geometrie ab. Der
 * Clip-Pfad folgt darum nur den harten Kanten; in den weichen Richtungen ist
 * er großzügig um die Fransenbreite aufgeweitet.
 */
function paintRegion(ctx, seed, T, reg) {
  const { x0, x1, top, bot, hardTop = false, hardBot = false, salt = [2, 3] } = reg;
  const rng = mulberry32(seed);
  const pad = T.fringePx + T.wMax / 2;
  const xL = x0 - pad, xR = x1 + pad;
  if (!(xR > xL)) return;

  // Kanten abtasten: sie sind nichtlinear (Türme, Ambosskeil), Bounding-Box
  // und Clip-Pfad brauchen sie also diskretisiert.
  const SAMPLES = 96;
  const xs = new Float64Array(SAMPLES + 1);
  const tops = new Float64Array(SAMPLES + 1), bots = new Float64Array(SAMPLES + 1);
  let yMin = Infinity, yMax = -Infinity;
  for (let s = 0; s <= SAMPLES; s++) {
    const cx = xL + (xR - xL) * s / SAMPLES;
    xs[s] = cx; tops[s] = top(cx); bots[s] = bot(cx);
    if (tops[s] < yMin) yMin = tops[s];
    if (bots[s] > yMax) yMax = bots[s];
  }
  // Jenseits einer harten Kante lohnt nur noch eine halbe Ellipse Streubreite
  // (weiter draußen liegende Mittelpunkte ragen ohnehin nicht mehr herein).
  const ry0 = yMin - (hardTop ? T.hMax / 2 : pad);
  const ry1 = yMax + (hardBot ? T.hMax / 2 : pad);
  if (!(ry1 > ry0)) return;

  ctx.save();
  ctx.beginPath();
  if (hardTop) {
    ctx.moveTo(xs[0], tops[0]);
    for (let s = 1; s <= SAMPLES; s++) ctx.lineTo(xs[s], tops[s]);
  } else { ctx.moveTo(xL, ry0); ctx.lineTo(xR, ry0); }
  if (hardBot) for (let s = SAMPLES; s >= 0; s--) ctx.lineTo(xs[s], bots[s]);
  else { ctx.lineTo(xR, ry1); ctx.lineTo(xL, ry1); }
  ctx.closePath();
  ctx.clip();

  const attempts = Math.round(T.density * 800 / TUNER_CANVAS_PX2 * (xR - xL) * (ry1 - ry0));
  for (let i = 0; i < attempts; i++) {
    const cx = xL + rng() * (xR - xL), cy = ry0 + rng() * (ry1 - ry0);
    // Vorzeichenbehafteter Abstand zu den WEICHEN Kanten (innen positiv), als
    // Rampe auf [0,1]: 0.5 exakt auf der Kante, s. Kommentar an
    // CB_TUNING.threshold. Harte Kanten bleiben außen vor -- dort soll die
    // Dichte bis zur Schnittlinie voll bleiben, gekappt wird per Clip.
    let d = Math.min(cx - x0, x1 - cx);
    if (!hardTop) d = Math.min(d, cy - top(cx));
    if (!hardBot) d = Math.min(d, bot(cx) - cy);
    const ramp = clamp(0.5 + d / (2 * T.fringePx), 0, 1);
    // Rauschen bewusst UNGEDÄMPFT addiert (anders als bei den Schichtwolken):
    // es soll die Kante verschieben -- Beulen nach außen, Kerben nach innen,
    // Reichweite +-noiseAmp * 2 * fringePx Pixel. Das Innere schützt nicht
    // eine Dämpfung, sondern die gain-Kopplung (s. CB_TUNING): selbst beim
    // ungünstigsten Rauschwert bleibt die Annahme dort bei 1. Fetzen im
    // Nichts kann es ebenfalls nicht geben, solange noiseAmp < threshold.
    const v = ramp + T.noiseAmp * regionNoise(seed, cx, cy, T.noiseScale, salt);
    if (v <= T.threshold) continue;
    if (rng() >= Math.min(1, (v - T.threshold) * T.gain)) continue;

    const ew = T.wMin + rng() * (T.wMax - T.wMin);
    const eh = T.hMin + rng() * (T.hMax - T.hMin);
    ctx.beginPath();
    ctx.ellipse(cx, cy, ew / 2, eh / 2, 0, 0, Math.PI * 2);
    ctx.fill();   // fill -> stroke je Ellipse, wie bei den Schichtwolken.
    ctx.stroke();
  }
  ctx.restore();
}

/** Aufeinanderfolgende Stunden mit `pred` zu Läufen `[i, j]` zusammenfassen. */
function runsOf(arr, pred) {
  const runs = [];
  for (let i = 0; i < arr.length; i++) {
    if (!pred(arr[i])) continue;
    let j = i;
    while (j + 1 < arr.length && pred(arr[j + 1])) j++;
    runs.push([i, j]);
    i = j;
  }
  return runs;
}

/** Stützwert `key` an der Stelle `cx`, linear; außerhalb konstant. */
function edgeAt(pts, key, cx) {
  if (cx <= pts[0].cx) return pts[0][key];
  for (let k = 1; k < pts.length; k++) {
    if (pts[k].cx >= cx) {
      const a = pts[k - 1], b = pts[k];
      return a[key] + (cx - a.cx) / (b.cx - a.cx) * (b[key] - a[key]);
    }
  }
  return pts[pts.length - 1][key];
}

function clipChart(ctx, x, y) {
  ctx.beginPath();
  ctx.rect(x.left, y.top, x.right - x.left, y.bot - y.top);
  ctx.clip();
}

function setSpotStyle(ctx, T) {
  ctx.fillStyle = T.fill;
  ctx.strokeStyle = `rgba(${T.gray},${T.gray},${T.gray},${T.grayAlpha})`;
  ctx.lineWidth = T.strokeWidth;
}

// Eigene Oktav-Salts je Region (Schaft 2/3, Amboss 4/5), damit die Rauschfelder
// desselben Seeds nicht miteinander korrelieren.
function regionNoise(seed, px, py, s, salt) {
  const a = valueNoise(seed, px * s, py * s, salt[0]);
  const b = valueNoise(seed, px * s * FBM_OCTAVE, py * s * FBM_OCTAVE, salt[1]);
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
