import { defineConfig } from "vite";
import { bundledSecret } from "./scripts/bundled-secrets.mjs";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dts from "vite-plugin-dts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    // Emit declarations to dist/types (matching the package.json "exports"
    // map). CSS side-effect imports are stripped automatically. bundleTypes
    // rolls each entry into a single self-contained .d.ts so consumers under
    // Node16 module resolution have no unresolved relative imports, and the
    // cjs outDir adds matching .d.cts files for the "require" condition.
    dts({
      tsconfigPath: resolve(__dirname, "tsconfig.build.json"),
      entryRoot: resolve(__dirname, "src"),
      bundleTypes: true,
      outDirs: ["dist/types", { dir: "dist/types", moduleFormat: "cjs" }],
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  // Optionally bundle the OpenAI / CLIProxyAPI keys so end users of a
  // controlled demo build do not have to enter one. Gated behind
  // OPERA_BUNDLE_KEYS=1: an exported OPENAI_API_KEY or CLI_PROXY_API_KEY is NOT
  // enough on its own, because both are routinely exported in a developer's
  // shell and an ordinary build then ships a live credential to every browser
  // that loads the app. A build that opts in must not be published.
  // See scripts/bundled-secrets.mjs, src/vite-env.d.ts and src/geolibre.ts.
  define: {
    __OPERA_OPENAI_API_KEY__: JSON.stringify(bundledSecret("OPENAI_API_KEY")),
    __OPERA_CLI_PROXY_API_KEY__: JSON.stringify(
      bundledSecret("CLI_PROXY_API_KEY"),
    ),
    // Not a secret: an endpoint, safe to bundle unconditionally.
    __OPERA_CLI_PROXY_URL__: JSON.stringify(
      process.env.CLI_PROXY_UPSTREAM ?? "https://cli-proxy.opengeos.org",
    ),
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        react: resolve(__dirname, "src/react.ts"),
      },
      name: "GeoLibreNasaOpera",
      formats: ["es", "cjs"],
      fileName: (format, entryName) => {
        const ext = format === "es" ? "mjs" : "cjs";
        return `${entryName}.${ext}`;
      },
    },
    rollupOptions: {
      external: ["react", "react-dom", "maplibre-gl"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          "maplibre-gl": "maplibregl",
        },
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "style.css")
            return "geolibre-nasa-opera.css";
          return assetInfo.name || "";
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    minify: false,
  },
});
