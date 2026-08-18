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
  },
  // meteokit ist ein Quellpaket, kein vorgebautes Bundle: Vite würde es sonst
  // mit esbuild vorbündeln, das Vite-eigene Import-Suffixe wie `?inline`
  // (gramet-panel.js lädt so sein CSS) nicht kennt.
  optimizeDeps: { exclude: ["meteokit"] },
});
