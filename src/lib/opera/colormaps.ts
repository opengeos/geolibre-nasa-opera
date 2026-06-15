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
 * Return an explicit titiler `colormap` (JSON string) for a categorical band,
 * or `undefined` to let the caller fall back to rescale/grayscale rendering.
 */
export function colormapForBand(
  shortName: string,
  band?: string,
): string | undefined {
  if (!band) return undefined;
  // DSWx water bands: WTR, BWTR, WTR-1, WTR-2 all share the WTR class colormap.
  if (/DSWX/i.test(shortName) && /WTR/i.test(band)) {
    return JSON.stringify(DSWX_WTR_COLORMAP);
  }
  return undefined;
}
