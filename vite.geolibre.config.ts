import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * True when a build warning/log originates in the third-party GeoAgent
 * dependency chain (maplibre-gl-geoagent + @strands-agents/sdk) and is not
 * actionable from this repo: Node built-ins stubbed for the browser, and Google
 * Closure's direct `eval`. Used to keep those out of the build output while
 * still surfacing warnings from this plugin's own code.
 */
function isDependencyBuildNoise(entry: { message?: string } | string): boolean {
  const message = typeof entry === "string" ? entry : (entry?.message ?? "");
  return (
    message.includes("has been externalized for browser compatibility") ||
    message.includes("Use of direct `eval`") ||
    (message.includes("eval") && message.includes("maplibre-gl-geoagent"))
  );
}

// ---------------------------------------------------------------------------
// Recipe: bundle plugin-local assets into the GeoLibre dist/ folder
// ---------------------------------------------------------------------------
// If your plugin ships static assets (sample datasets, icons, JSON, etc.) that
// it loads over HTTP at runtime, copy them into the built bundle so a baked-in
// or URL-served GeoLibre install can fetch them next to the plugin entry. At
// runtime, resolve their URL with the host's `resolvePluginAssetUrl(pluginId,
// relativePath)` capability (see src/lib/geolibre/host-api.ts) and degrade
// gracefully when it returns null/undefined (e.g. a desktop filesystem install
// where the assets are not reachable over HTTP).
//
// To enable it, uncomment the imports and plugin below, point ASSET_SRC at your
// source directory, and add `bundlePluginAssets()` to the `plugins` array. Set
// `publicDir: false` so Vite does not also copy unrelated public/ files (e.g.
// robots.txt) into the plugin bundle.
//
// import { cp, rm } from "node:fs/promises";
// import type { Plugin } from "vite";
//
// const ASSET_SRC = resolve(__dirname, "public/sample-data");
// const ASSET_DEST = resolve(__dirname, "geolibre-plugin/dist/sample-data");
//
// function bundlePluginAssets(): Plugin {
//   return {
//     name: "geolibre-plugin:bundle-assets",
//     async closeBundle() {
//       await rm(ASSET_DEST, { recursive: true, force: true });
//       await cp(ASSET_SRC, ASSET_DEST, { recursive: true });
//     },
//   };
// }

export default defineConfig({
  // publicDir: false, // enable with the bundlePluginAssets() recipe above
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  // Optionally bundle the OpenAI key from the build environment so end users of
  // the shipped GeoLibre plugin do not have to enter one. OPT-IN: only set when
  // OPENAI_API_KEY is exported at build time; default OFF. Bundling exposes the
  // key to anyone who loads the app, so use only for controlled/sponsor demos.
  // See src/vite-env.d.ts and src/geolibre.ts.
  define: {
    __OPERA_OPENAI_API_KEY__: JSON.stringify(process.env.OPENAI_API_KEY ?? ""),
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/geolibre.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "geolibre-plugin/dist",
    emptyOutDir: true,
    rollupOptions: {
      external: [],
      // Silence build noise that originates entirely in third-party GeoAgent
      // dependencies we do not control and cannot fix here:
      //  - @strands-agents/sdk imports Node built-ins (fs/path/node:*) that Vite
      //    stubs for the browser; those code paths are never reached in the
      //    plugin, so the "externalized for browser compatibility" notes are
      //    expected.
      //  - maplibre-gl-geoagent bundles Google Closure, which uses direct
      //    `eval`, tripping the minifier's EVAL warning.
      // Warnings from this plugin's own sources still surface normally.
      onwarn(warning, defaultHandler) {
        if (isDependencyBuildNoise(warning)) return;
        defaultHandler(warning);
      },
      onLog(level, log, defaultHandler) {
        if (isDependencyBuildNoise(log)) return;
        defaultHandler(level, log);
      },
      output: {
        assetFileNames: () => "style.css",
        // GeoLibre imports registry plugins from a generated module URL, so
        // relative chunk imports such as ./GeoAgentControl-*.js cannot resolve.
        // Keep the external plugin entry self-contained.
        codeSplitting: false,
      },
    },
    cssCodeSplit: false,
    sourcemap: false,
    minify: "oxc",
  },
  // plugins: [bundlePluginAssets()], // enable with the recipe above
});
