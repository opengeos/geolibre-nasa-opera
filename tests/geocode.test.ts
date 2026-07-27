import { describe, expect, it, vi } from "vitest";
import { geocodePlaceBounds } from "../src/lib/opera/geocode";

describe("geocodePlaceBounds", () => {
  it("resolves a region hint to the administrative regional candidate", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              display_name: "Parque Valencia, Murcia, Spain",
              category: "leisure",
              type: "park",
              importance: 0.08,
              boundingbox: [
                "38.0172513",
                "38.0177089",
                "-1.2400674",
                "-1.2394435",
              ],
            },
            {
              display_name: "Valencia, Valencian Community, Spain",
              category: "boundary",
              type: "administrative",
              importance: 0.73,
              boundingbox: [
                "39.2784496",
                "39.5666090",
                "-0.4325512",
                "-0.2725205",
              ],
            },
            {
              display_name: "Valencian Community, Spain",
              category: "boundary",
              type: "administrative",
              importance: 0.69,
              boundingbox: [
                "37.8437887",
                "40.7886312",
                "-1.5289448",
                "0.6903174",
              ],
            },
          ]),
          { status: 200 },
        ),
    );

    const result = await geocodePlaceBounds("Valencia Region, Spain", {
      fetchImpl: fetchImpl as never,
    });

    expect(result.bbox).toEqual([
      -1.5289448, 37.8437887, 0.6903174, 40.7886312,
    ]);
    expect(result.displayName).toBe("Valencian Community, Spain");
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe("Valencia, Spain");
  });

  it("expands a point-sized place result to a usable local AOI", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              display_name: "Small place",
              importance: 0.5,
              boundingbox: ["39", "39.001", "-0.4", "-0.399"],
            },
          ]),
          { status: 200 },
        ),
    );

    const result = await geocodePlaceBounds("Small place", {
      fetchImpl: fetchImpl as never,
    });

    expect(result.bbox[2] - result.bbox[0]).toBeCloseTo(0.1);
    expect(result.bbox[3] - result.bbox[1]).toBeCloseTo(0.1);
  });

  it("rejects responses without usable bounds", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify([{ display_name: "Unknown" }])),
    );

    await expect(
      geocodePlaceBounds("Unknown", { fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/No map bounds/);
  });
});
