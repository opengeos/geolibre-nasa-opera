---
title: Jupyter notebooks
icon: lucide/notebook
---

# Jupyter notebooks

These notebooks run the plugin's search and display workflow from Python with
the [GeoLibre](https://github.com/opengeos/GeoLibre) Jupyter widget. They call
the same services as the plugin: the public NASA CMR API for search and
titiler-cmr for rendering, so no Earthdata login is needed. All three use
Valencia, Spain, around the 29 October 2024 DANA flood.

| Notebook | What it covers |
| --- | --- |
| [Search OPERA granules](01_search_opera_granules.md) | Search CMR, inspect bands, map footprints, compare products, export GeoJSON |
| [Visualize OPERA layers](02_visualize_opera_layers.md) | DSWx-HLS, DSWx-S1, RTC-S1 (dB), DIST-ALERT, and DEM layers with colormaps, legends, and a swipe |
| [Map a flood with DSWx-S1](03_flood_mapping_dswx.md) | Before/after swipe and open-water area over time |

## Run them

```bash
pip install geolibre geopandas requests matplotlib
jupyter lab
```

Each notebook also opens in Google Colab from the badge at its top. Tiles come
from the shared demo endpoint `https://titiler-cmr.opengeos.org`; for heavy use,
set `TITILER_CMR` in the helper cell to a titiler-cmr deployment you control.
