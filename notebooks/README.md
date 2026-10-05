# Notebook examples

Jupyter notebooks that search and visualize NASA OPERA products with the
[GeoLibre](https://github.com/opengeos/GeoLibre) Python widget. They use the same
services as the GeoLibre OPERA plugin: the public NASA CMR API for search and
[titiler-cmr](https://github.com/developmentseed/titiler-cmr) for rendering, so
no Earthdata login is needed.

| Notebook                                                     | What it covers                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [01_search_opera_granules](01_search_opera_granules.ipynb)   | Search CMR for OPERA granules, inspect their bands, map footprints, compare products, export GeoJSON   |
| [02_visualize_opera_layers](02_visualize_opera_layers.ipynb) | Render DSWx-HLS, DSWx-S1, RTC-S1 (dB), DIST-ALERT, and DEM layers with colormaps, legends, and a swipe |
| [03_flood_mapping_dswx](03_flood_mapping_dswx.ipynb)         | Map the October 2024 Valencia flood with DSWx-S1: before/after swipe and water area over time          |

All three use Valencia, Spain, around the 29 October 2024 DANA flood.

## Run them

```bash
pip install geolibre geopandas requests matplotlib
jupyter lab
```

The notebooks render tiles through the shared demo endpoint
`https://titiler-cmr.opengeos.org`. For heavy use, set `TITILER_CMR` in the
helper cell to a titiler-cmr deployment you control.
