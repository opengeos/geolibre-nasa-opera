/**
 * News/impact retrieval for the constrained flood workflow.
 *
 * Impact figures (deaths, damages, people displaced, economic loss) must be
 * traceable to a reputable source, so the agent never free-recalls them: it
 * calls a real search API (Tavily by default) and cites the returned URLs. The
 * Tavily API key must stay server-side, so requests go through a small
 * Cloudflare Worker (`workers/news-proxy.js`) that injects the secret and adds
 * CORS headers. This module only knows the Worker URL, resolved the same way
 * `titiler.ts` resolves its endpoint (build var / global / override).
 */

/**
 * Endpoint precedence: explicit override, window global, Docker deployment
 * environment, then the `VITE_NEWS_PROXY_ENDPOINT` build variable.
 */
const NEWS_PROXY_GLOBAL = "GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT";

export function resolveNewsProxyEndpoint(override?: string): string {
  return (
    clean(override) ||
    clean(readGlobal()) ||
    clean(readDeploymentEnv()) ||
    clean(readBuildEnv()) ||
    ""
  );
}

const TRAILING_SLASH_RE = /\/+$/;
const LEADING_WWW_RE = /^www\./;

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(TRAILING_SLASH_RE, "") : undefined;
}

function readGlobal(): string | undefined {
  return (globalThis as Record<string, unknown>)[NEWS_PROXY_GLOBAL] as
    | string
    | undefined;
}

function readDeploymentEnv(): string | undefined {
  const deployment = (
    globalThis as typeof globalThis & {
      __GEOLIBRE_DEPLOYMENT_ENV__?: Record<string, string | undefined>;
    }
  ).__GEOLIBRE_DEPLOYMENT_ENV__;
  return (
    deployment?.GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT ??
    deployment?.VITE_NASA_OPERA_NEWS_PROXY_ENDPOINT
  );
}

function readBuildEnv(): string | undefined {
  return (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  ).env?.VITE_NEWS_PROXY_ENDPOINT;
}

/** A normalized, citable news result. */
export interface NewsResult {
  title: string;
  /** Canonical article URL (what the agent must cite). */
  sourceUrl: string;
  /** Publisher/host derived from the URL, e.g. "reuters.com". */
  publisher: string;
  /** Publication date when the provider supplies one (ISO or free text). */
  date?: string;
  /** Extracted snippet/content used to ground quantified figures. */
  snippet: string;
}

export interface SearchNewsOptions {
  maxResults?: number;
  /** Override the Worker endpoint (otherwise resolved from build/global). */
  endpoint?: string;
  /**
   * Tavily search topic. Defaults to "general" so retrospective flood events
   * (a benchmark is QAed after the event) remain reachable; "news" restricts to
   * recent journalistic coverage (see `days`).
   */
  topic?: "general" | "news";
  /** For the "news" topic, how many days back to search (Worker default 3650). */
  days?: number;
  /** GPT-native web search by default; Tavily only for an explicit request. */
  engine?: "gpt" | "tavily";
  /** Direct GPT search settings used by controlled local builds. */
  gptApiKey?: string;
  gptBaseUrl?: string;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Timeout in ms (default 15s). */
  timeoutMs?: number;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}
interface TavilyResponse {
  results?: TavilyResult[];
  answer?: string;
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
}

function publisherFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(LEADING_WWW_RE, "");
  } catch {
    return "";
  }
}

/**
 * Search reputable news for quantified impact figures via the Tavily-backed
 * Worker. Throws a descriptive Error when no proxy endpoint is configured.
 */
export async function searchNews(
  query: string,
  options: SearchNewsOptions = {},
): Promise<{ results: NewsResult[]; answer?: string; endpoint: string }> {
  const endpoint = resolveNewsProxyEndpoint(options.endpoint);
  if (!endpoint) {
    const apiKey =
      options.gptApiKey ??
      (typeof __OPERA_CLI_PROXY_API_KEY__ === "string"
        ? __OPERA_CLI_PROXY_API_KEY__.trim()
        : "");
    const baseUrl =
      options.gptBaseUrl ??
      (typeof __OPERA_CLI_PROXY_URL__ === "string"
        ? __OPERA_CLI_PROXY_URL__.trim()
        : "");
    if (options.engine !== "tavily" && apiKey && baseUrl) {
      return searchWithGptMessages(query, { ...options, apiKey, baseUrl });
    }
    throw new Error(
      "News proxy is not configured. Set VITE_NEWS_PROXY_ENDPOINT (or the " +
        "GeoLibre Docker news proxy runtime setting) to the deployed news Worker URL.",
    );
  }
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15000,
  );
  try {
    const route = options.engine === "tavily" ? "tavily" : "search";
    const response = await doFetch(`${endpoint}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        max_results: Math.min(Math.max(options.maxResults ?? 6, 1), 20),
        ...(options.topic ? { topic: options.topic } : {}),
        ...(options.days ? { days: options.days } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const errBody = (await response.json()) as { error?: unknown };
        detail = typeof errBody?.error === "string" ? `: ${errBody.error}` : "";
      } catch {
        /* non-JSON error body — fall back to the status alone */
      }
      throw new Error(`News proxy responded ${response.status}${detail}`);
    }
    const data = (await response.json()) as TavilyResponse;
    const results: NewsResult[] = (data.results ?? [])
      .filter(
        (r): r is TavilyResult & { url: string } => typeof r.url === "string",
      )
      .map((r) => ({
        title: r.title ?? "",
        sourceUrl: r.url,
        publisher: publisherFromUrl(r.url),
        date: r.published_date,
        snippet: r.content ?? "",
      }));
    return { results, answer: data.answer, endpoint };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWithGptMessages(
  query: string,
  options: SearchNewsOptions & { apiKey: string; baseUrl: string },
): Promise<{ results: NewsResult[]; answer?: string; endpoint: string }> {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15000,
  );
  const maxResults = Math.min(Math.max(options.maxResults ?? 6, 1), 20);
  const recency =
    options.topic === "news"
      ? ` Only use sources published within the last ${options.days ?? 14} days.`
      : "";
  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        max_tokens: 4096,
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 4 },
        ],
        system:
          "Use web_search and return one JSON object only with schema " +
          '{"answer":string,"results":[{"title":string,"url":string,"content":string,"published_date":string}]}. ' +
          `Return at most ${maxResults} citable results and never invent URLs.`,
        messages: [{ role: "user", content: `${query}${recency}` }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`GPT web search responded ${response.status}`);
  const payload = (await response.json()) as MessagesResponse;
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("GPT web search returned no structured results");
  }
  const data = JSON.parse(text.slice(start, end + 1)) as TavilyResponse;
  const results = (data.results ?? [])
    .filter((item): item is TavilyResult & { url: string } => Boolean(item.url))
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title ?? "",
      sourceUrl: item.url,
      publisher: publisherFromUrl(item.url),
      date: item.published_date,
      snippet: item.content ?? "",
    }));
  return { results, answer: data.answer, endpoint };
}
