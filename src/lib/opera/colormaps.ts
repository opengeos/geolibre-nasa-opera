/**
 * Categorical colormaps for OPERA layers.
 *
 * titiler-cmr's multi-asset rasterio backend returns the raw class values and
 * does not apply a COG's embedded color table, so categorical layers (e.g. the
 * DSWx water classification) render as grayscale unless we pass an explicit
 * `colormap`. These map class value -> [R, G, B, A].
 */

/**
 * OPERA DSWx WTR / BWTR / WTR-1 / WTR-2 water-classification colormap.
 *
 * Class colors follow the official DSWx-HLS legend (white = not water, blue =
 * open water, lightskyblue = partial surface water, cyan = snow/ice, grey =
 * cloud/cloud shadow). "Not water" and fill are made transparent so the water
 * classes overlay the basemap instead of painting the land solid white.
 */
export const DSWX_WTR_COLORMAP: Record<string, [number, number, number, number]> =
  {
    "0": [0, 0, 0, 0], // not water -> transparent
    "1": [0, 0, 255, 255], // open water -> blue
    "2": [135, 206, 250, 255], // partial surface water -> lightskyblue
    "252": [0, 255, 255, 255], // snow/ice -> cyan
    "253": [128, 128, 128, 255], // cloud/cloud shadow -> grey
    "254": [0, 0, 128, 255], // ocean masked -> navy
    "255": [0, 0, 0, 0], // fill / no data -> transparent
  };

/**
 * Water-only variant of {@link DSWX_WTR_COLORMAP}: keeps open water (1) and
 * partial surface water (2), and makes every other class — including
 * cloud/cloud-shadow, snow/ice, and ocean-masked — transparent. Useful for
 * flood snapshots (e.g. the one-pager) where stacking several post-event scenes
 * would otherwise paint opaque grey cloud and navy ocean over the AOI.
 */
export const DSWX_WTR_WATER_ONLY_COLORMAP: Record<
  string,
  [number, number, number, number]
> = {
  "0": [0, 0, 0, 0], // not water -> transparent
  "1": [0, 0, 255, 255], // open water -> blue
  "2": [135, 206, 250, 255], // partial surface water -> lightskyblue
  "252": [0, 0, 0, 0], // snow/ice -> transparent
  "253": [0, 0, 0, 0], // cloud/cloud shadow -> transparent
  "254": [0, 0, 0, 0], // ocean masked -> transparent
  "255": [0, 0, 0, 0], // fill / no data -> transparent
};

/** The water-only DSWx colormap as a titiler `colormap` JSON string. */
export function dswxWaterOnlyColormap(): string {
  return JSON.stringify(DSWX_WTR_WATER_ONLY_COLORMAP);
}

/** Human-readable labels for DSWx WTR class values, used in stats breakdowns. */
export const DSWX_WTR_CLASS_LABELS: Record<string, string> = {
  "0": "Not water",
  "1": "Open water",
  "2": "Partial surface water",
  "252": "Snow/ice",
  "253": "Cloud/cloud shadow",
  "254": "Ocean masked",
  "255": "Fill",
};

/** DSWx WTR class value (1) counted as open water for area calculations. */
export const DSWX_OPEN_WATER_CLASS = 1;
/** DSWx WTR class value (2) counted as partial surface water. */
export const DSWX_PARTIAL_WATER_CLASS = 2;

/**
 * Return an explicit titiler `colormap` (JSON string) for a categorical band,
 * or `undefined` to let the caller fall back to rescale/grayscale rendering.
 */
export function colormapForBand(
  shortName: string,
  band?: string,
  opts: { waterOnly?: boolean } = {},
): string | undefined {
  if (!band) return undefined;
  // DSWx water bands: WTR, BWTR, WTR-1, WTR-2 all share the WTR class colormap.
  if (/DSWX/i.test(shortName) && /WTR/i.test(band)) {
    return opts.waterOnly
      ? dswxWaterOnlyColormap()
      : JSON.stringify(DSWX_WTR_COLORMAP);
  }
  return undefined;
}

/**
 * Whether a band holds discrete class values, so zonal statistics should
 * request a per-class (categorical) histogram rather than continuous bins.
 */
export function isCategoricalBand(shortName: string, band?: string): boolean {
  if (!band) return false;
  if (/DSWX/i.test(shortName) && /WTR/i.test(band)) return true;
  if (/DIST/i.test(shortName) && /STATUS/i.test(band)) return true;
  return false;
}

/** Whether a band is a DSWx water-classification layer (open-water areas). */
export function isDswxWaterBand(shortName: string, band?: string): boolean {
  return !!band && /DSWX/i.test(shortName) && /WTR/i.test(band);
}
