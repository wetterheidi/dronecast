#!/usr/bin/env node
import { fetchColumn } from "meteokit/column";
import { fetchSurface } from "meteokit/weather";
import { gridFromColumn } from "meteokit/gramet";
import { metarWeather } from "meteokit/briefing";
import { deriveView } from "../../meteokit/src/gramet/derive.js";

const fetchWithOrigin = (url, opts) => fetch(url, {
  ...opts,
  headers: { ...(opts?.headers || {}), Origin: "https://dronecast.wetterheidi.de" },
});

const lat = 48.2320, lon = 15.7407, model = "icon_d2";
const [col, surface] = await Promise.all([
  fetchColumn(lat, lon, model, 3, fetchWithOrigin),
  fetchSurface(lat, lon, model, 3, fetchWithOrigin),
]);
const grid = gridFromColumn(col, surface, lat, lon);
const d = deriveView(grid);

const targetT = Date.UTC(2026, 8, 5, 9, 0, 0) / 1000;
let i = 0, best = Infinity;
for (let k = 0; k < grid.times.length; k++) {
  const diff = Math.abs(grid.times[k] - targetT);
  if (diff < best) { best = diff; i = k; }
}
console.log("Stunde:", new Date(grid.times[i] * 1000).toISOString(), "index", i);
console.log("cb-Spalte:", d.cb[i]);
const label = Number.isFinite(grid.surface?.wcode?.[i]) ? metarWeather(grid.surface.wcode[i]) : "N/A";
console.log("wx:", label);

console.log("\nz(m AGL)  cloudFrac  T(C)");
for (let k = 0; k < grid.nk; k++) {
  const ix = i * grid.nk + k;
  const z = grid.z[ix];
  if (!Number.isFinite(z)) continue;
  const cf = d.cloudFrac[ix] * 100;
  console.log(
    z.toFixed(0).padStart(6), " ",
    cf.toFixed(1).padStart(6) + "%", " ",
    (grid.T[ix] - 273.15).toFixed(1).padStart(5),
    cf >= 10 ? "  <-- CF_FEW" : ""
  );
}
