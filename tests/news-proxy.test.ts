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

  it("rejects unknown paths", async () => {
    const response = await handleRequest(searchRequest("/other"), ENV);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ ok: false });
  });
});
