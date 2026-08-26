import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
// Komponentenbibliothek meteokit: als `file:`-Abhängigkeit eingebunden
// (s. package.json), npm legt dafür einen Symlink in node_modules an. Das
// Ziel liegt also außerhalb des Projekt-Roots -- daher die beiden
// Sonderbehandlungen unten. Voraussetzung: beide Repos nebeneinander
// ausgecheckt (auch beim Deploy-Build, der lokal läuft).
const meteokit = fileURLToPath(new URL("../meteokit", import.meta.url));

// Relative Basis, damit das Tool auch in einem Unterpfad (z. B. /apps/…)
// ausgeliefert werden kann.
export default defineConfig({
  base: "./",
  server: {
    host: true,
    // Ohne diese Freigabe verweigert der Dev-Server das Ausliefern der
    // Bibliotheksmodule, weil der Symlink aus dem Root herausführt.
    fs: { allow: [root, meteokit] },
    // Michaels Modelllevel-Server (open-meteo.mah.priv.at) lässt per
    // Caddy-CORS-Allowlist nur bekannte Produktions-Origins durch (u.a.
    // https://dronecast.wetterheidi.de), sonst 403 -- auch ganz ohne
    // Origin-Header. Im Dev-Betrieb läuft der Request über diesen
    // Node-Proxy statt direkt aus dem Browser -- daher unterliegt er
    // keinem Browser-CORS und die Origin lässt sich hier gefahrlos auf die
    // eigene Produktions-Origin setzen, damit Michaels Server ihn
    // durchlässt (s. src/config.js für die Umschaltung von `API_BASE` und
    // der Modell-`apiBase`-Einträge im Dev-Betrieb).
    //
    // GRAMET/Meteogramm fragen pro Säule ALLE Modelllevel × mehrere
    // Variablen in einem Request ab -- die Query-String allein sprengt
    // Nodes Default-Limit für Request-Header (8/16 KB), an dem Caddy/nginx
    // in Produktion vorbeigehen. Deshalb hebt der `dev`-Skript-Eintrag in
    // package.json Nodes Limit per `NODE_OPTIONS=--max-http-header-size`
    // an -- ohne das liefert genau dieser Proxy-Pfad 431 (Request Header
    // Fields Too Large).
    proxy: {
      "/api-proxy": {
        target: "https://open-meteo.mah.priv.at",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-proxy/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Origin", "https://dronecast.wetterheidi.de");
          });
        },
      },
    },
  },
  // meteokit ist ein Quellpaket, kein vorgebautes Bundle: Vite würde es sonst
  // mit esbuild vorbündeln, das Vite-eigene Import-Suffixe wie `?inline`
  // (gramet-panel.js lädt so sein CSS) nicht kennt.
  optimizeDeps: { exclude: ["meteokit"] },
});
