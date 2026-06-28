const CORS_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "range",
  "x-requested-with",
];

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
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Allow-Headers":
          request.headers.get("Access-Control-Request-Headers") ||
          CORS_HEADERS.join(", "),
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const incomingUrl = new URL(request.url);
  if (incomingUrl.pathname === "/" || incomingUrl.pathname === "/health") {
    return jsonResponse(
      {
        ok: true,
        upstream: upstreamBase(env),
        usage: "Set the OPERA titiler-cmr endpoint to this Worker URL.",
      },
      cors,
    );
  }

  if (!isAllowedPath(incomingUrl.pathname)) {
    return jsonResponse(
      {
        ok: false,
        error: "Only titiler-cmr /rasterio and /xarray paths are proxied.",
      },
      cors,
      404,
    );
  }

  const upstream = new URL(upstreamBase(env));
  const upstreamPath = `${upstream.pathname.replace(/\/+$/, "")}${incomingUrl.pathname}`;
  const target = new URL(upstreamPath, upstream.origin);
  target.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("Host");
  headers.delete("Origin");
  headers.delete("Referer");

  const upstreamResponse = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    redirect: "follow",
  });

  return rewriteResponse(upstreamResponse, {
    cors,
    incomingBase: incomingUrl.origin,
    upstreamBase: upstream.href.replace(/\/+$/, ""),
  });
}

function upstreamBase(env) {
  const upstream = String(env.TITILER_CMR_UPSTREAM || "").trim();
  if (!upstream) {
    throw new Error("TITILER_CMR_UPSTREAM is required.");
  }
  return upstream.replace(/\/+$/, "");
}

function isAllowedPath(pathname) {
  return /^\/(?:rasterio|xarray)(?:\/|$)/.test(pathname);
}

function corsHeaders(origin, allowedOrigins = "*") {
  const allowed = String(allowedOrigins || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin =
    allowed.includes("*") || !origin
      ? "*"
      : allowed.includes(origin)
        ? origin
        : allowed[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Expose-Headers": "Content-Length, Content-Type, ETag",
    Vary: "Origin",
  };
}

async function rewriteResponse(response, options) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(options.cors)) {
    headers.set(key, value);
  }

  const contentType = headers.get("Content-Type") ?? "";
  const shouldRewrite =
    contentType.includes("application/json") ||
    contentType.includes("text/json") ||
    contentType.includes("geo+json");
  if (!shouldRewrite) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const text = await response.text();
  headers.delete("Content-Length");
  return new Response(
    text.split(options.upstreamBase).join(options.incomingBase),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
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
