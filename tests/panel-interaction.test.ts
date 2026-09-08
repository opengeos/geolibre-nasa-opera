import { afterEach, describe, expect, it, vi } from "vitest";
import { OperaControl } from "../src/lib/core/OperaControl";

type MapListener = (event: {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
  originalEvent: MouseEvent;
}) => void;

/**
 * Build the minimum map surface needed to exercise a bubbling footprint click.
 *
 * @returns A map stub whose canvas dispatches registered MapLibre click handlers.
 */
function footprintMapStub() {
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  container.appendChild(canvas);
  document.body.appendChild(container);

  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const layers = new Set<string>();
  const domListeners = new Map<string, Map<MapListener, EventListener>>();
  const map = {
    getContainer: () => container,
    getCanvas: () => canvas,
    on: vi.fn((type: string, listener: MapListener) => {
      if (type !== "click") return;
      const wrapped: EventListener = (event) =>
        listener({
          point: { x: 10, y: 10 },
          lngLat: { lng: -80, lat: 30 },
          originalEvent: event as MouseEvent,
        });
      const listeners = domListeners.get(type) ?? new Map();
      listeners.set(listener, wrapped);
      domListeners.set(type, listeners);
      canvas.addEventListener(type, wrapped);
    }),
    off: vi.fn((type: string, listener: MapListener) => {
      const wrapped = domListeners.get(type)?.get(listener);
      if (wrapped) canvas.removeEventListener(type, wrapped);
    }),
    queryRenderedFeatures: vi.fn(() => [
      { properties: { _operaGranuleId: "OPERA_TEST_GRANULE" } },
    ]),
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string) => {
      sources.set(id, { setData: vi.fn() });
    }),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
    addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    moveLayer: vi.fn(),
  };

  return { canvas, map };
}

describe("OPERA panel map interactions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    document.body.innerHTML = "";
  });

  it("keeps the plugin panel open after selecting a footprint on the map", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              meta: { "collection-concept-id": "C123-TEST" },
              umm: {
                GranuleUR: "OPERA_TEST_GRANULE",
                SpatialExtent: {
                  HorizontalSpatialDomain: {
                    Geometry: {
                      BoundingRectangles: [
                        {
                          WestBoundingCoordinate: -81,
                          SouthBoundingCoordinate: 29,
                          EastBoundingCoordinate: -79,
                          NorthBoundingCoordinate: 31,
                        },
                      ],
                    },
                  },
                },
                RelatedUrls: [{ URL: "https://example.com/test_B01_WTR.tif" }],
              },
            },
          ],
        }),
      ),
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    let panelOpen = true;
    const control = new OperaControl({
      collapsed: false,
      onRequestReveal: () => {
        panelOpen = true;
      },
    });
    const { canvas, map } = footprintMapStub();
    control.renderDocked(document.createElement("div"), map as never);
    await control.searchForAgent({ addFootprints: false, fitBounds: false });

    const closeOnOutsideClick = () => {
      panelOpen = false;
    };
    document.addEventListener("click", closeOnOutsideClick, { once: true });
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.removeEventListener("click", closeOnOutsideClick);

    expect(panelOpen).toBe(true);
    expect(control.getAgentContext().selectedGranuleIds).toEqual([
      "OPERA_TEST_GRANULE",
    ]);
    control.teardownDocked();
  });
});
