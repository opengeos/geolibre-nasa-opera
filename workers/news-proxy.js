/**
 * News search proxy Worker for the constrained flood one-pager.
 *
 * The browser cannot call the Tavily search API directly (the API key must stay
 * server-side, and CORS). This Worker exposes a single `POST /tavily` endpoint
 * that injects the `TAVILY_API_KEY` secret and forwards to Tavily, adding CORS
 * headers so the plugin's `news_impact_search` tool can reach it. Set the
 * secret with `wrangler secret put TAVILY_API_KEY --config wrangler.news.toml`;
 * it is never shipped in the browser bundle.
 */

const CORS_HEADERS = ["accept", "authorization", "content-type", "x-client-secret"];
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env = {}) {
  const origin = request.headers.get("Origin") ?? "";
  const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Access-Control-Allow-Headers":
          request.headers.get("Access-Control-Request-Headers") ||
          CORS_HEADERS.join(", "),
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/health") {
    return jsonResponse(
      {
        ok: true,
        usage: "POST /tavily { query, max_results } — set VITE_NEWS_PROXY_ENDPOINT to this Worker URL.",
        keyConfigured: Boolean(env.TAVILY_API_KEY),
      },
      cors,
    );
  }

  if (url.pathname !== "/tavily" || request.method !== "POST") {
    return jsonResponse(
      { ok: false, error: "Only POST /tavily is supported." },
      cors,
      404,
    );
  }

  // Optional shared-secret gate so the proxy is not an open Tavily relay. When
  // CLIENT_SECRET is set, callers must send a matching `X-Client-Secret` header;
  // when it is unset the check is skipped (backward compatible).
  const clientSecret = String(env.CLIENT_SECRET || "").trim();
  if (clientSecret && request.headers.get("X-Client-Secret") !== clientSecret) {
    return jsonResponse(
      { ok: false, error: "Missing or invalid X-Client-Secret header." },
      cors,
      401,
    );
  }

  const apiKey = String(env.TAVILY_API_KEY || "").trim();
  if (!apiKey) {
    return jsonResponse(
      { ok: false, error: "TAVILY_API_KEY secret is not configured on the Worker." },
      cors,
      500,
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Request body must be JSON." }, cors, 400);
  }
  const query = String(payload?.query || "").trim();
  if (!query) {
    return jsonResponse({ ok: false, error: "A non-empty 'query' is required." }, cors, 400);
  }
  const maxResults = Math.min(Math.max(Number(payload?.max_results) || 6, 1), 20);
  // A locked flood benchmark is retrospective (QAed after the event), so the
  // default must not be recency-limited: Tavily's "news" topic only returns the
  // last few days, which misses events older than that. "general" surfaces
  // authoritative retrospective sources (official reports, encyclopedic, and
  // news). Callers may still request "news" and pass a wide `days` window.
  const topic = payload?.topic === "news" ? "news" : "general";
  const tavilyBody = {
    query,
    max_results: maxResults,
    topic,
    search_depth: "advanced",
    include_answer: true,
  };
  if (topic === "news") {
    // Default to a wide window so older events remain reachable; clamp override.
    const days = Math.min(Math.max(Number(payload?.days) || 3650, 1), 3650);
    tavilyBody.days = days;
  }

  let upstream;
  try {
    upstream = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(tavilyBody),
    });
  } catch (error) {
    return jsonResponse(
      { ok: false, error: `Tavily request failed: ${error?.message ?? String(error)}` },
      cors,
      502,
    );
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...cors,
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    },
  });
}

function corsHeaders(origin, allowedOrigins = "*") {
  // `?? "*"` (not `|| "*"`): an explicitly empty ALLOWED_ORIGINS denies all
  // origins rather than silently falling back to the wildcard.
  const allowed = String(allowedOrigins ?? "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  // Only emit Access-Control-Allow-Origin for a matched (or explicit "*")
  // origin; for an unmatched origin omit it so the browser blocks the response.
  let allowOrigin;
  if (allowed.includes("*") || !origin) {
    allowOrigin = "*";
  } else if (allowed.includes(origin)) {
    allowOrigin = origin;
  }
  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    "Access-Control-Expose-Headers": "Content-Length, Content-Type",
    Vary: "Origin",
  };
}

function jsonResponse(body, cors, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
