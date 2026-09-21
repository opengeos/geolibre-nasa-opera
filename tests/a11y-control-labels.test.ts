import { describe, expect, it, vi } from "vitest";
import { OperaControl } from "../src/lib/core/OperaControl";

/**
 * Minimal MapLibre surface: `onAdd` only needs a container to mount into plus
 * the event and style hooks it wires up on the way.
 */
function stubMap(container: HTMLElement) {
  return {
    getContainer: () => container,
    getCanvas: () => ({ style: {} }),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    project: vi.fn(() => ({ x: 0, y: 0 })),
    getCenter: () => ({ lng: 0, lat: 0 }),
    getBounds: () => ({
      getWest: () => -10,
      getSouth: () => -10,
      getEast: () => 10,
      getNorth: () => 10,
    }),
    getZoom: () => 3,
    getBearing: () => 0,
    getPitch: () => 0,
    getLayer: vi.fn(() => undefined),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    getSource: vi.fn(() => undefined),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    moveLayer: vi.fn(),
    getStyle: () => ({ layers: [] }),
    queryRenderedFeatures: vi.fn(() => []),
  };
}

/**
 * The accessible name axe looks for on a form control: an associated `<label>`,
 * or one of the ARIA/title fallbacks. A `placeholder` deliberately does not
 * count here — axe accepts it, but it disappears as soon as the field has a
 * value, so it is not a name a screen reader user can rely on.
 */
function accessibleName(el: HTMLInputElement | HTMLSelectElement): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;

  const labelledBy = el.getAttribute("aria-labelledby")?.trim();
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map(
        (id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "",
      )
      .join(" ")
      .trim();
    if (text) return text;
  }

  // `labels` covers both `<label for>` and a wrapping `<label>`.
  const labelled = [...(el.labels ?? [])]
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
  if (labelled) return labelled;

  return el.getAttribute("title")?.trim() ?? "";
}

function mountPanel(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const control = new OperaControl();
  control.onAdd(stubMap(container) as never);
  return container;
}

describe("panel control labelling", () => {
  it("gives every form control an accessible name", () => {
    const container = mountPanel();
    const controls = [
      ...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "input, select",
      ),
    ];

    expect(controls.length).toBeGreaterThan(0);

    const unnamed = controls
      .filter((el) => el.type !== "hidden" && !accessibleName(el))
      .map(
        (el) =>
          `${el.tagName.toLowerCase()} type=${el.type} class="${el.className}" id="${el.id}"`,
      );

    expect(unnamed).toEqual([]);
  });

  it("names each end of the date range separately", () => {
    // Regression: both inputs sat under one "Date range" caption, which cannot
    // name either of them, so axe reported a critical `label` violation on each.
    const container = mountPanel();
    const start = container.querySelector<HTMLInputElement>(
      'input[data-field="start"]',
    );
    const end = container.querySelector<HTMLInputElement>(
      'input[data-field="end"]',
    );

    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    expect(accessibleName(start!)).toBe("Start date");
    expect(accessibleName(end!)).toBe("End date");
  });

  it("keeps label ids unique across two mounts", () => {
    // Two panels on one page must not share ids, or every `<label for>` would
    // resolve to the first panel's control.
    const first = mountPanel();
    const second = mountPanel();
    const idsOf = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLElement>("[id]")].map((el) => el.id);

    const overlap = idsOf(first).filter((id) => idsOf(second).includes(id));
    expect(overlap).toEqual([]);
  });
});
