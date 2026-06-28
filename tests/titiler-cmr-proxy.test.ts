import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../workers/titiler-cmr-proxy";

describe("titiler-cmr Worker proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles CORS preflight", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/rasterio/statistics", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "content-type",
    );
  });

  it("rejects non-titiler backend paths", async () => {
    const response = await handleRequest(
      new Request("https://proxy.example/cmr/search"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      ok: false,
      error: expect.stringContaining("/rasterio and /xarray"),
    });
  });

  it("forwards POST statistics requests to the configured upstream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ statistics: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await handleRequest(
      new Request("https://proxy.example/rasterio/statistics?categorical=true", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://geolibre.example",
        },
        body: JSON.stringify({ type: "Feature" }),
      }),
      {
        ALLOWED_ORIGINS: "https://geolibre.example",
        TITILER_CMR_UPSTREAM: "https://titiler.example/api/titiler-cmr",
      },
    );

    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "https://titiler.example/api/titiler-cmr/rasterio/statistics?categorical=true",
      ),
      expect.objectContaining({
        method: "POST",
        redirect: "follow",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://geolibre.example",
    );
  });

  it("requires an upstream endpoint for proxied requests", async () => {
    await expect(
      handleRequest(new Request("https://proxy.example/rasterio/statistics")),
    ).rejects.toThrow("TITILER_CMR_UPSTREAM is required");
  });

  it("rewrites TileJSON URLs to the proxy origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            tiles: [
              "https://titiler.example/api/titiler-cmr/rasterio/tiles/WebMercatorQuad/{z}/{x}/{y}",
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const response = await handleRequest(
      new Request("https://proxy.example/rasterio/WebMercatorQuad/tilejson.json"),
      {
        TITILER_CMR_UPSTREAM: "https://titiler.example/api/titiler-cmr",
      },
    );
    const body = await response.json();

    expect(body.tiles[0]).toBe(
      "https://proxy.example/rasterio/tiles/WebMercatorQuad/{z}/{x}/{y}",
    );
  });
});
