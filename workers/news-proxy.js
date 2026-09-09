/**
 * GPT web-search proxy for OPERA GeoAgent disaster searches.
 *
 * The browser posts a query to `POST /search`. This Worker keeps the OpenAI API
 * key server-side, invokes the Responses API web-search tool, and returns the
 * normalized result envelope consumed by `src/lib/opera/news.ts`.
 */

const CORS_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "x-client-secret",
];
const OPENAI_ENDPOINT = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-5.6-luna";

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
        usage: "POST /search { query, max_results, topic?, days? }",
        keyConfigured: Boolean(env.OPENAI_API_KEY),
      },
      cors,
    );
  }

  if (url.pathname !== "/search" || request.method !== "POST") {
    return jsonResponse(
      { ok: false, error: "Only POST /search is supported." },
      cors,
      404,
    );
  }

  const clientSecret = String(env.CLIENT_SECRET || "").trim();
  if (clientSecret && request.headers.get("X-Client-Secret") !== clientSecret) {
    return jsonResponse(
      { ok: false, error: "Missing or invalid X-Client-Secret header." },
      cors,
      401,
    );
  }

  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return jsonResponse(
      {
        ok: false,
        error: "OPENAI_API_KEY secret is not configured on the Worker.",
      },
      cors,
      500,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { ok: false, error: "Request body must be JSON." },
      cors,
      400,
    );
  }
  const query = String(body?.query || "").trim();
  if (!query) {
    return jsonResponse(
      { ok: false, error: "A non-empty 'query' is required." },
      cors,
      400,
    );
  }

  const requestBody = buildGptSearchRequest(body, query, env.OPENAI_MODEL);
  const baseUrl = String(env.OPENAI_BASE_URL || OPENAI_ENDPOINT)
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  let upstream;
  try {
    upstream = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: `GPT web search failed: ${error?.message ?? String(error)}`,
      },
      cors,
      502,
    );
  }

  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        ...cors,
        "Content-Type":
          upstream.headers.get("Content-Type") ??
          "application/json; charset=utf-8",
      },
    });
  }

  const payload = await upstream.json();
  try {
    return jsonResponse(normalizeGptSearchResponse(payload), cors);
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error?.message ?? "GPT web search returned invalid results.",
      },
      cors,
      502,
    );
  }
}

export function buildGptSearchRequest(body, query, model = DEFAULT_MODEL) {
  const requested = Number(body?.max_results);
  const maxResults = Math.min(
    Math.max(
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 6,
      1,
    ),
    20,
  );
  const recencyScope = body?.topic === "news";
  const datedScope = /\b(?:1[6-9]|20)\d{2}\b/.test(query);
  const days = Math.min(Math.max(Number(body?.days) || 14, 1), 3650);
  const scope = recencyScope
    ? `Prefer sources published within the last ${days} days.`
    : datedScope
      ? "The query identifies a dated event. Search that exact period and prefer authoritative sources."
      : "Search broadly across relevant time periods and prefer authoritative sources.";

  return {
    model: String(model || DEFAULT_MODEL),
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    max_tool_calls: 1,
    max_output_tokens: 2048,
    include: ["web_search_call.action.sources"],
    store: false,
    instructions:
      "Search the web before answering. Return a JSON object with an answer and citable results. " +
      "Use only URLs returned by web search and never invent a URL.",
    input: `${query}\n\n${scope}`,
    text: {
      format: {
        type: "json_schema",
        name: "disaster_search_results",
        strict: true,
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            results: {
              type: "array",
              maxItems: maxResults,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  url: { type: "string" },
                  content: { type: "string" },
                  published_date: { type: "string" },
                },
                required: ["title", "url", "content", "published_date"],
                additionalProperties: false,
              },
            },
          },
          required: ["answer", "results"],
          additionalProperties: false,
        },
      },
    },
  };
}

export function normalizeGptSearchResponse(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const text =
    (typeof payload?.output_text === "string" && payload.output_text) ||
    output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .filter(
        (item) => item?.type === "output_text" && typeof item.text === "string",
      )
      .map((item) => item.text)
      .join("\n");
  if (!text) throw new Error("GPT web search returned no structured results.");

  const parsed = JSON.parse(text);
  const searchedUrls = new Set();
  for (const item of output) {
    const sources = Array.isArray(item?.action?.sources)
      ? item.action.sources
      : [];
    for (const source of sources) {
      if (typeof source?.url === "string") searchedUrls.add(source.url);
    }
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part?.annotations)
        ? part.annotations
        : [];
      for (const annotation of annotations) {
        if (typeof annotation?.url === "string")
          searchedUrls.add(annotation.url);
      }
    }
  }

  const results = (Array.isArray(parsed?.results) ? parsed.results : []).filter(
    (item) => item && typeof item.url === "string" && searchedUrls.has(item.url),
  );
  return {
    answer: typeof parsed?.answer === "string" ? parsed.answer : "",
    results,
  };
}

function corsHeaders(origin, allowedOrigins = "*") {
  const allowed = String(allowedOrigins ?? "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
