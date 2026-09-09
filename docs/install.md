---
title: Build and install
icon: lucide/package
---

# Build and install

```bash
npm install

# Build the GeoLibre bundle -> geolibre-plugin/dist/{index.js,style.css}
npm run build:geolibre

# Package a distributable zip
npm run package:geolibre
```

The package consumes the published `maplibre-gl-geoagent` dependency from npm.
Use version `0.5.4` or newer so the plugin can inject its custom agent tools and
system prompt.

## Install into GeoLibre

=== "Local checkout"

    Copies the bundle into
    `apps/geolibre-desktop/public/plugins/geolibre-nasa-opera/`, covering both
    the web and desktop builds.

    ```bash
    node scripts/install-geolibre-plugin.mjs --web /path/to/GeoLibre
    ```

=== "Desktop app data dir"

    ```bash
    npm run install:geolibre
    ```

=== "Web app by manifest URL"

    Needs CORS. Serve the bundle, then paste `http://localhost:8000/plugin.json`
    into GeoLibre Settings &rarr; Plugins.

    ```bash
    npm run serve:geolibre
    ```

## Development

```bash
npm run test    # unit tests (vitest)
npm run build   # full build (npm library + GeoLibre bundle)
npm run lint
```

Key source files:

`src/geolibre.ts`
:   Plugin entry point and GeoLibre lifecycle wiring.

`src/lib/core/OperaControl.ts`
:   The MapLibre control and search panel.

`src/lib/opera/products.ts`
:   OPERA product registry and render defaults.

`src/lib/opera/cmr.ts`
:   CMR granule and collection search, footprint parsing.

`src/lib/opera/titiler.ts`
:   titiler-cmr TileJSON URL builder.

`src/lib/geolibre/host-api.ts`
:   The GeoLibre host-plugin contract.

## Cloudflare Worker proxies

Two optional Workers ship with the repository.

=== "Statistics proxy"

    Forwards only `/rasterio/...` and `/xarray/...` titiler-cmr paths to the
    `TITILER_CMR_UPSTREAM` configured in `wrangler.toml`, adding browser CORS
    headers. Point the panel's endpoint field at the deployed URL.

    ```bash
    npm run proxy:dev      # local, port 8787
    npm run proxy:deploy
    ```

=== "News proxy"

    Accepts `POST /search` for `search_disasters` and `news_impact_search`.
    Point the plugin at it with the `VITE_NEWS_PROXY_ENDPOINT` build variable,
    the `GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT` window global, or GeoLibre's
    Docker variable of the same name.

    ```bash
    npx wrangler secret put OPENAI_API_KEY --config wrangler.news.toml
    npm run news-proxy:deploy
    ```

The news Worker fails closed: `ALLOWED_ORIGINS` defaults to local development
origins, so set it to your deployed origins. To keep it from becoming an open
search relay for non-browser clients, set a `CLIENT_SECRET` and have callers
send a matching `X-Client-Secret` header.

## Optional: bundling an LLM key

So end users do not have to enter an API key, the OpenAI key can be baked into
the build:

```bash
export OPENAI_API_KEY=sk-...
npm run build:geolibre
```

When set, the key is passed to the GeoAgent's `apiKeys` option and the panel
starts ready to chat. A key the user enters later still takes precedence. When
`OPENAI_API_KEY` is unset, which is the default, nothing is bundled.

!!! danger "This ships the key to every browser that loads the app"

    Use it only for controlled sponsor or demo deployments. For public
    deployments, leave it unset and put the key behind a server-side proxy.

## Limitations

- Per-product render defaults in `products.ts` are starting points and may need
  tuning per product against your titiler-cmr endpoint.
- Browser-side model credentials suit trusted sessions. For public deployments,
  configure provider access through a backend proxy.

See [ROADMAP.md](https://github.com/opengeos/geolibre-nasa-opera/blob/main/ROADMAP.md)
for shipped capabilities and what is under consideration next.
