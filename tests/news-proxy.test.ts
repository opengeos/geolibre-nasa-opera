import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGptSearchRequest,
  handleRequest,
  normalizeGptSearchResponse,
} from "../workers/news-proxy";

const ENV = { OPENAI_API_KEY: "test-key" };

function searchRequest(path = "/search"): Request {
  return new Request(`https://news.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Nepal floods August 2026" }),
  });
}

describe("GPT news proxy Worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards POST /search to the Responses API web-search tool", async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        output_text: JSON.stringify({ answer: "Summary", results: [] }),
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await handleRequest(searchRequest(), ENV);
    const [, init] = upstream.mock.calls[0];
    const body = JSON.parse(String(init?.body));

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.any(Object),
    );
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.tool_choice).toBe("required");
    expect(body.max_tool_calls).toBe(1);
    expect(body.max_output_tokens).toBe(2048);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
  });

  it("builds a retrospective prompt for a dated event", () => {
    const request = buildGptSearchRequest(
      { topic: "general", max_results: 8 },
      "Nepal floods August 2026",
    );
    expect(request.input).toContain("Search that exact period");
    expect(request.text.format.schema.properties.results.maxItems).toBe(8);
  });

  it("uses a broad authoritative scope for an undated general query", () => {
    const request = buildGptSearchRequest({}, "major Nepal disasters");

    expect(request.input).toContain("Search broadly");
    expect(request.input).not.toContain("exact period");
    expect(request.input).not.toContain("last 14 days");
  });

  it("normalizes an OpenAI-compatible base URL ending in /v1", async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        output_text: JSON.stringify({ answer: "Summary", results: [] }),
      }),
    );
    vi.stubGlobal("fetch", upstream);

    await handleRequest(searchRequest(), {
      ...ENV,
      OPENAI_BASE_URL: "https://cli.example.com/v1/",
    });

    expect(upstream).toHaveBeenCalledWith(
      "https://cli.example.com/v1/responses",
      expect.any(Object),
    );
  });

  it("returns a structured 502 for a non-JSON upstream success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    const response = await handleRequest(searchRequest(), ENV);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(body).toMatchObject({
      ok: false,
      error: "GPT web search returned invalid JSON.",
    });
  });

  it("keeps only results grounded in returned web-search sources", () => {
    const payload = {
      output: [
        {
          type: "web_search_call",
          action: {
            sources: [{ url: "https://example.com/nepal-flood" }],
          },
        },
      ],
      output_text: JSON.stringify({
        answer: "Flooding affected Nepal.",
        results: [
          {
            title: "Nepal flood report",
            url: "https://example.com/nepal-flood",
            content: "Flooding was reported.",
            published_date: "2026-08-20",
          },
          {
            title: "Invented",
            url: "https://invented.example/flood",
            content: "Not grounded.",
            published_date: "2026-08-20",
          },
        ],
      }),
    };

    expect(normalizeGptSearchResponse(payload).results).toHaveLength(1);
  });

  it("returns no results when GPT supplies no verified source URLs", () => {
    const payload = {
      output: [],
      output_text: JSON.stringify({
        answer: "Flooding affected Nepal.",
        results: [
          {
            title: "Unverified report",
            url: "https://invented.example/flood",
            content: "An unsupported claim.",
            published_date: "2026-08-20",
          },
        ],
      }),
    };

    expect(normalizeGptSearchResponse(payload)).toEqual({
      answer: "",
      results: [],
    });
  });

  it("rejects malformed URLs even when listed as web-search sources", () => {
    const payload = {
      output: [
        {
          type: "web_search_call",
          action: { sources: [{ url: "not-a-url" }] },
        },
      ],
      output_text: JSON.stringify({
        answer: "Unsupported summary.",
        results: [
          {
            title: "Invalid result",
            url: "not-a-url",
            content: "Not citable.",
            published_date: "2026-08-20",
          },
        ],
      }),
    };

    expect(normalizeGptSearchResponse(payload)).toEqual({
      answer: "",
      results: [],
    });
  });

  it("rejects unknown paths", async () => {
    const response = await handleRequest(searchRequest("/other"), ENV);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ ok: false });
  });
});
