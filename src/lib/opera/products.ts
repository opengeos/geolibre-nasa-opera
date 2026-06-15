/**
 * Registry of NASA OPERA products the plugin can search and visualize.
 *
 * Ported from the QGIS NASA OPERA plugin's `OPERA_DATASETS`
 * (nasa_opera/dialogs/opera_dock.py). Each entry adds default titiler-cmr render
 * parameters (backend/bands/rescale/colormap) used to build the tile request.
 * The defaults below are starting points; tune `bands`/`bandsRegex`/`rescale`/
 * `colormapName` per product against the live titiler-cmr endpoint.
 */

import type { OperaProduct } from "./types";

export const OPERA_PRODUCTS: OperaProduct[] = [
  {
    shortName: "OPERA_L3_DSWX-HLS_V1",
    title:
      "Dynamic Surface Water Extent from Harmonized Landsat Sentinel-2 (Version 1)",
    shortTitle: "DSWX-HLS",
    description: "Surface water extent derived from HLS data",
    render: {
      backend: "rasterio",
      bands: ["B01_WTR"],
      bandsRegex: "B[0-9]{2}_[A-Z]+",
      // WTR bands render via an explicit categorical colormap (see colormaps.ts).
    },
  },
  {
    shortName: "OPERA_L3_DSWX-S1_V1",
    title: "Dynamic Surface Water Extent from Sentinel-1 (Version 1)",
    shortTitle: "DSWX-S1",
    description: "Surface water extent derived from Sentinel-1 SAR data",
    render: {
      backend: "rasterio",
      bands: ["B01_WTR"],
      bandsRegex: "B[0-9]{2}_[A-Z]+",
      // WTR bands render via an explicit categorical colormap (see colormaps.ts).
    },
  },
  {
    shortName: "OPERA_L3_DIST-ALERT-HLS_V1",
    title: "Land Surface Disturbance Alert from HLS (Version 1)",
    shortTitle: "DIST-ALERT",
    description: "Near real-time disturbance alerts",
    render: {
      backend: "rasterio",
      bands: ["VEG-DIST-STATUS"],
      bandsRegex: "[A-Z-]+",
      rescale: "0,4",
    },
  },
  {
    shortName: "OPERA_L3_DIST-ANN-HLS_V1",
    title: "Land Surface Disturbance Annual from HLS (Version 1)",
    shortTitle: "DIST-ANN",
    description: "Annual land surface disturbance product",
    render: {
      backend: "rasterio",
      bands: ["VEG-DIST-STATUS"],
      bandsRegex: "[A-Z-]+",
      rescale: "0,4",
    },
  },
  {
    shortName: "OPERA_L2_RTC-S1_V1",
    title:
      "Radiometric Terrain Corrected SAR Backscatter from Sentinel-1 (Version 1)",
    shortTitle: "RTC-S1",
    description: "Analysis-ready SAR backscatter data",
    render: {
      backend: "rasterio",
      bands: ["VV"],
      bandsRegex: "(VV|VH|HH|HV)",
      rescale: "0,0.4",
      colormapName: "gray",
    },
  },
  {
    shortName: "OPERA_L2_RTC-S1-STATIC_V1",
    title: "RTC-S1 Static Layers (Version 1)",
    shortTitle: "RTC-S1-STATIC",
    description: "Static layers for RTC-S1 product",
    render: {
      backend: "rasterio",
      bandsRegex: "[A-Za-z_]+",
    },
  },
  {
    shortName: "OPERA_L2_CSLC-S1_V1",
    title: "Coregistered Single-Look Complex from Sentinel-1 (Version 1)",
    shortTitle: "CSLC-S1",
    description: "SLC data coregistered to a common reference",
    render: {
      backend: "rasterio",
      bandsRegex: "[A-Za-z_]+",
    },
  },
  {
    shortName: "OPERA_L2_CSLC-S1-STATIC_V1",
    title: "CSLC-S1 Static Layers (Version 1)",
    shortTitle: "CSLC-S1-STATIC",
    description: "Static layers for CSLC-S1 product",
    render: {
      backend: "rasterio",
      bandsRegex: "[A-Za-z_]+",
    },
  },
];

/** Look up a product by its CMR short_name. */
export function getProduct(shortName: string): OperaProduct | undefined {
  return OPERA_PRODUCTS.find((p) => p.shortName === shortName);
}
