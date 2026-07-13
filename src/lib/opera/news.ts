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

/** Build-time override: `VITE_NEWS_PROXY_ENDPOINT`. Runtime global below. */
const NEWS_PROXY_GLOBAL = "GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT";

export function resolveNewsProxyEndpoint(override?: string): string {
  return (
    clean(override) ||
    clean(readGlobal()) ||
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
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Timeout in ms (default 25s). */
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
    throw new Error(
      "News proxy is not configured. Set VITE_NEWS_PROXY_ENDPOINT (or the " +
        "GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT global) to the deployed news Worker URL.",
    );
  }
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);
  try {
    const response = await doFetch(`${endpoint}/tavily`, {
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
      .filter((r): r is TavilyResult & { url: string } => typeof r.url === "string")
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
