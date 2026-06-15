import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Builds the standalone demo (root index.html -> examples/main.ts) into
// dist-examples for GitHub Pages. The dev server (`npm run dev`) serves the same
// index.html directly.
export default defineConfig({
  base: "/geolibre-nasa-opera/",
  build: {
    outDir: "dist-examples",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
