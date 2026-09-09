import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Builds the standalone demo (root index.html -> examples/main.ts) into
// dist-examples for GitHub Pages. The dev server (`npm run dev`) serves the same
// index.html directly.
export default defineConfig({
  // GitHub Pages serves the landing page at the site root and this demo under
  // /demo/, so the deploy workflow overrides the base with PAGES_BASE.
  base: process.env.PAGES_BASE ?? "/geolibre-nasa-opera/",
  // Optionally bundle the OpenAI key from the build environment (opt-in) so the
  // deployed demo starts without a manual key prompt. See src/vite-env.d.ts for
  // the security caveat.
  define: {
    __OPERA_OPENAI_API_KEY__: JSON.stringify(process.env.OPENAI_API_KEY ?? ""),
  },
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
