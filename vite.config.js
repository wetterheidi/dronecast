import { defineConfig } from "vite";

// Relative Basis, damit das Tool auch in einem Unterpfad (z. B. /apps/…)
// ausgeliefert werden kann.
export default defineConfig({
  base: "./",
  server: { host: true },
});
