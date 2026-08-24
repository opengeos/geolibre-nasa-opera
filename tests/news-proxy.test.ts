import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../workers/news-proxy";

const ENV = { TAVILY_API_KEY: "test-key" };

function searchRequest(path: string): Request {
  return new Request(`https://news.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Valencia flood deaths" }),
  });
}

describe("news proxy Worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["/search", "/tavily"])(
    "forwards POST %s to Tavily",
    async (path) => {
      const upstream = vi.fn(async () => Response.json({ results: [] }));
      vi.stubGlobal("fetch", upstream);

      const response = await handleRequest(searchRequest(path), ENV);

      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledWith(
        "https://api.tavily.com/search",
        expect.any(Object),
      );
    },
  );

  it("rejects unknown paths", async () => {
    const response = await handleRequest(
      new Request("https://news.example/other", { method: "POST" }),
      ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ ok: false });
  });
});
