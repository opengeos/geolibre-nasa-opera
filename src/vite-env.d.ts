/// <reference types="vite/client" />

/**
 * OpenAI API key optionally bundled at build time from the `OPENAI_API_KEY`
 * environment variable (via a Vite `define`). Empty string when not set, in
 * which case the GeoAgent panel falls back to manual key entry. Bundling a key
 * exposes it to anyone who loads the page — use only for controlled/sponsor
 * demo deployments; prefer a server-side proxy for public deployments.
 */
declare const __OPERA_OPENAI_API_KEY__: string;
