"""Build the NASA OPERA gallery projects as GeoLibre ``.geolibre.json`` files.

Each function below writes one project to ``OUT``. Rasters come either from
NASA GIBS (pre-rendered OPERA mosaics, fast) or from titiler-cmr (renders any
OPERA granule from CMR with a custom colormap and a transparent background).
The coverage map is a vector layer built from a CMR granule count; run
``count_dswx_hls_looks`` first or let it use the cached count.

Run with the GeoLibre Python package installed::

    python gallery/build_projects.py            # every project
    python gallery/build_projects.py kakhovka   # projects whose slug matches
"""

import json
import pathlib
import re
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import geolibre.geolibre as _gl
import requests
from geolibre import Map

# Headless authoring only: skip starting the bundled app server.
_gl.serve_app = lambda *_a, **_k: "http://localhost/"
from geolibre.project import ensure_plugins_block  # noqa: E402

OUT = pathlib.Path("~/Downloads/geolibre-opera-maps").expanduser()
CACHE = OUT / "cache"

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
GIBS_ATTR = "NASA OPERA (JPL) via NASA GIBS; contains modified Copernicus Sentinel data"
TITILER_CMR = "https://titiler-cmr.opengeos.org"
TITILER_ATTR = (
    "NASA OPERA (JPL) via titiler-cmr; contains modified Copernicus Sentinel data"
)
ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
ESRI_ATTR = "Esri, Maxar, Earthstar Geographics, and the GIS User Community"

# CMR collection concept ids.
DSWX_HLS = "C2617126679-POCLOUD"
DSWX_S1 = "C2949811996-POCLOUD"
DISP_S1 = "C3294057315-ASF"
BAND_REGEX = r"B[0-9]{2}_[A-Z]+"

# Class colors shared by the GIBS mosaics and the titiler-cmr colormaps.
WATER = "#0000ff"
PARTIAL_WATER = "#b4d5f4"
INUNDATED_VEG = "#00a884"
CLOUD = "#afafaf"
TRANSPARENT = [0, 0, 0, 0]
DSWX_HLS_COLORMAP = {
    "0": TRANSPARENT,  # not water
    "1": [0, 0, 255, 255],  # open water
    "2": [180, 213, 244, 255],  # partial surface water
    "252": [0, 255, 255, 255],  # snow/ice
    "253": [175, 175, 175, 255],  # cloud/cloud shadow
    "254": TRANSPARENT,  # ocean masked
    "255": TRANSPARENT,  # fill
}
DSWX_S1_COLORMAP = {
    "0": TRANSPARENT,  # not water
    "1": [0, 0, 255, 255],  # open water
    "3": [0, 168, 132, 255],  # inundated vegetation
    "250": TRANSPARENT,  # HAND masked
    "251": TRANSPARENT,  # layover/shadow masked
    "255": TRANSPARENT,  # fill
}
# Matplotlib RdBu, which titiler-cmr's "rdbu" colormap uses.
RDBU = ["#67001f", "#d6604d", "#f7f7f7", "#4393c3", "#053061"]


def gibs(layer, day):
    """Return a GIBS WMTS tile URL template for an OPERA layer on one day.

    Args:
        layer: GIBS layer identifier.
        day: Date as ``YYYY-MM-DD``.

    Returns:
        An XYZ tile URL template.
    """
    return f"{GIBS}/{layer}/default/{day}/GoogleMapsCompatible_Level12/{{z}}/{{y}}/{{x}}.png"


def titiler(backend, **params):
    """Return a titiler-cmr XYZ tile URL template.

    Args:
        backend: ``"rasterio"`` for COG products, ``"xarray"`` for NetCDF ones.
        **params: Query parameters; a ``colormap`` dict is JSON-encoded.

    Returns:
        An XYZ tile URL template.
    """
    if isinstance(params.get("colormap"), dict):
        params["colormap"] = json.dumps(params["colormap"], separators=(",", ":"))
    query = urllib.parse.urlencode(params)
    return f"{TITILER_CMR}/{backend}/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}?{query}"


def dswx_day(concept_id, day, colormap):
    """Return a titiler-cmr URL that mosaics one day of DSWx water classes.

    Args:
        concept_id: DSWx-HLS or DSWx-S1 collection concept id.
        day: Date as ``YYYY-MM-DD``.
        colormap: Class value to RGBA mapping.

    Returns:
        An XYZ tile URL template.
    """
    return titiler(
        "rasterio",
        collection_concept_id=concept_id,
        assets="B01_WTR",
        assets_regex=BAND_REGEX,
        temporal=f"{day}T00:00:00Z/{day}T23:59:59Z",
        colormap=colormap,
    )


def disp(granule_ur, limit_m):
    """Return a titiler-cmr URL that renders a DISP-S1 displacement grid.

    Args:
        granule_ur: The DISP-S1 granule to render.
        limit_m: Symmetric color stretch in meters, e.g. ``0.15`` for +/-15 cm.

    Returns:
        An XYZ tile URL template.
    """
    return titiler(
        "xarray",
        collection_concept_id=DISP_S1,
        granule_ur=granule_ur,
        variables="displacement",
        rescale=f"{-limit_m},{limit_m}",
        colormap_name="rdbu",
    )


def items(pairs, shape="square"):
    """Build hand-written legend items.

    Args:
        pairs: Mapping of label to CSS color, in display order.
        shape: Swatch shape: ``"square"``, ``"circle"`` or ``"line"``.

    Returns:
        A list of legend item dicts.
    """
    return [{"label": k, "color": v, "shape": shape} for k, v in pairs.items()]


def map_legend(m, title, *, custom=None, hide=(), position="bottom-left"):
    """Show the map legend, with hand-written rows for raster layers.

    Args:
        m: The map to update.
        title: Legend heading (keep it under ~22 characters).
        custom: Mapping of layer name to ``{"title": ..., "items": [...]}``.
        hide: Names of layers to leave out of the legend.
        position: Map corner for the legend panel.
    """
    m.set_map_legend(title, position=position)
    legend = m.project["legend"]
    ids = {layer.name: layer.id for layer in m.layers}
    if custom:
        legend["customEntries"] = {ids[name]: entry for name, entry in custom.items()}
    for name in hide:
        legend["overrides"][ids[name]] = {"hidden": True}


def swipe(m, left, right):
    """Compare two layers with the swipe slider.

    Args:
        m: The map to update.
        left: Name of the layer on the left of the slider.
        right: Name of the layer on the right.
    """
    # The right side draws on an overlay map; giving it the basemap too makes it
    # opaque, so the left layer does not show through on the right.
    m.split_map(
        left_layers=["__basemap__", m.find_layer(left)],
        right_layers=["__basemap__", m.find_layer(right)],
    )


def save(m, slug, title, description, tags):
    """Name the project, attach metadata and write a compact project file.

    Args:
        m: The map to save.
        slug: File name stem; also the published asset name.
        title: Project display name (ASCII, no apostrophes).
        description: Description naming the data source.
        tags: Share-gallery tags for ``metadata.tags``.
    """
    m.project["name"] = title
    metadata = m.project.setdefault("metadata", {})
    metadata["description"] = description
    metadata["tags"] = sorted(set(tags) | {"nasa-opera", "open-data"})
    project = m.to_project()  # credentials stripped
    # Pin the plugin set so the map opens the same whichever panels the viewer
    # last had open (otherwise an OPERA panel may appear on load).
    ensure_plugins_block(project)
    path = OUT / f"{slug}.geolibre.json"
    path.write_text(
        json.dumps(project, separators=(",", ":"), ensure_ascii=False), "utf-8"
    )
    Map().load_project(str(path))  # validates
    print(f"wrote {path.name} ({path.stat().st_size / 1e3:.0f} kB)")


def water_legend(sentinel1=False):
    """Return legend items for DSWx water classes.

    Args:
        sentinel1: Use the DSWx-S1 classes instead of the DSWx-HLS ones.

    Returns:
        A list of legend item dicts.
    """
    if sentinel1:
        return items({"Open water": WATER, "Inundated vegetation": INUNDATED_VEG})
    return items(
        {
            "Open water": WATER,
            "Partial surface water": PARTIAL_WATER,
            "Cloud or shadow": CLOUD,
        }
    )


DIST_LEGEND = items(
    {
        "Confirmed, 50% or more loss": "#e01b07",
        "Confirmed, under 50% loss": "#dee043",
        "Provisional, 50% or more": "#e48727",
        "First detection": "#008888",
        "Finished": "#dddddd",
    }
)


# ------------------------------------------------------------------ water
def kakhovka():
    """Kakhovka reservoir before and after the dam breach of 6 June 2023."""
    m = Map(center=(34.3, 47.45), zoom=8.7, basemap="positron")
    layer = "OPERA_L3_Dynamic_Surface_Water_Extent-HLS"
    before, after = "Water 5 Jun 2023 (before)", "Water 5 Jul 2023 (after)"
    m.add_tile_layer(
        gibs(layer, "2023-06-05"),
        name=before,
        attribution=GIBS_ATTR,
        maxZoom=12,
        blendMode="multiply",
    )
    m.add_tile_layer(
        gibs(layer, "2023-07-05"),
        name=after,
        attribution=GIBS_ATTR,
        maxZoom=12,
        blendMode="multiply",
    )
    swipe(m, before, after)
    map_legend(
        m,
        "Kakhovka reservoir",
        hide=[before],
        custom={after: {"title": "OPERA DSWx-HLS", "items": water_legend()}},
    )
    save(
        m,
        "kakhovka-reservoir-drains-2023",
        "Kakhovka Reservoir Drains, 2023",
        "Swipe the NASA OPERA DSWx-HLS surface water maps of the Kakhovka reservoir on the "
        "Dnipro, Ukraine, on 5 June 2023, the day before the dam was destroyed, and a month "
        "later, when the reservoir had drained to a braided river. Source: NASA OPERA (JPL) "
        "via NASA GIBS; Harmonized Landsat and Sentinel-2.",
        ["natural-hazards", "swipe", "imagery", "dswx-hls"],
    )


def thessaly():
    """Storm Daniel flooding in Thessaly, Greece, September 2023."""
    m = Map(center=(22.78, 39.55), zoom=9.6, basemap="positron")
    layer = "OPERA_L3_Dynamic_Surface_Water_Extent-HLS"
    before, after = "Water 23 Aug 2023 (before)", "Water 10 Sep 2023 (after)"
    m.add_tile_layer(
        gibs(layer, "2023-08-23"),
        name=before,
        attribution=GIBS_ATTR,
        maxZoom=12,
        blendMode="multiply",
    )
    m.add_tile_layer(
        gibs(layer, "2023-09-10"),
        name=after,
        attribution=GIBS_ATTR,
        maxZoom=12,
        blendMode="multiply",
    )
    swipe(m, before, after)
    map_legend(
        m,
        "Thessaly floods",
        hide=[before],
        custom={
            after: {
                "title": "OPERA DSWx-HLS",
                "items": items(
                    {
                        "Open water": WATER,
                        "Flagged as snow or ice": "#00ffff",
                        "Cloud or shadow": CLOUD,
                    }
                ),
            }
        },
    )
    save(
        m,
        "thessaly-floods-september-2023",
        "Thessaly Floods, September 2023",
        "Swipe the NASA OPERA DSWx-HLS surface water maps of the Thessaly plain, Greece, "
        "before (23 August 2023) and after (10 September 2023) Storm Daniel, which flooded "
        "the Pineios river basin and briefly refilled the former Lake Karla. Some of the "
        "floodwater is flagged in the snow-or-ice class (cyan). Source: NASA "
        "OPERA (JPL) via NASA GIBS; Harmonized Landsat and Sentinel-2.",
        ["natural-hazards", "swipe", "imagery", "dswx-hls"],
    )


def tulare():
    """Tulare Lake refilled in 2023 and was farmland again a year later."""
    m = Map(center=(-119.72, 36.02), zoom=10.2, basemap="positron")
    bounds = [-120.1, 35.75, -119.35, 36.3]
    before, after = "Water 17 Jun 2023", "Water 19 Jun 2024"
    for name, day in ((before, "2023-06-17"), (after, "2024-06-19")):
        m.add_tile_layer(
            dswx_day(DSWX_HLS, day, DSWX_HLS_COLORMAP),
            name=name,
            attribution=TITILER_ATTR,
            bounds=bounds,
            maxZoom=13,
        )
    swipe(m, before, after)
    map_legend(
        m,
        "Tulare Lake",
        hide=[after],
        custom={before: {"title": "OPERA DSWx-HLS", "items": water_legend()}},
    )
    save(
        m,
        "tulare-lake-returns-2023",
        "Tulare Lake Returns, 2023",
        "Swipe NASA OPERA DSWx-HLS surface water in June 2023, when the record Sierra "
        "snowpack refilled the dry bed of Tulare Lake in California's Central Valley, against "
        "June 2024, when it was farmland again. Rendered from the original granules by "
        "titiler-cmr. Source: NASA OPERA (JPL); Harmonized Landsat and Sentinel-2.",
        ["natural-hazards", "swipe", "imagery", "dswx-hls"],
    )


def punjab():
    """Monsoon floods on the Ravi, Sutlej and Chenab rivers in Punjab, 2025."""
    m = Map(center=(73.9, 31.0), zoom=7.6, basemap="positron")
    bounds = [72.0, 29.0, 75.8, 32.6]
    before, after = "Water 16 Aug 2025 (before)", "Water 28 Aug 2025 (flood)"
    for name, day in ((before, "2025-08-16"), (after, "2025-08-28")):
        m.add_tile_layer(
            dswx_day(DSWX_S1, day, DSWX_S1_COLORMAP),
            name=name,
            attribution=TITILER_ATTR,
            bounds=bounds,
            maxZoom=12,
        )
    swipe(m, before, after)
    map_legend(
        m,
        "Punjab floods",
        hide=[before],
        custom={after: {"title": "OPERA DSWx-S1 (radar)", "items": water_legend(True)}},
    )
    save(
        m,
        "punjab-floods-august-2025",
        "Punjab Floods, August 2025",
        "Swipe NASA OPERA DSWx-S1 radar surface water over Punjab, Pakistan and India, on "
        "16 August 2025 and on 28 August 2025, when monsoon floods spread the Ravi, Sutlej "
        "and Chenab rivers across their floodplains. Radar maps water through monsoon cloud. "
        "Rendered from the original granules by titiler-cmr. Source: NASA OPERA (JPL); "
        "contains modified Copernicus Sentinel data.",
        ["natural-hazards", "swipe", "imagery", "dswx-s1"],
    )


def mozambique():
    """Limpopo and Incomati floods in southern Mozambique, January 2026."""
    m = Map(center=(33.15, -24.75), zoom=8.6, basemap="positron")
    bounds = [32.3, -25.5, 34.1, -23.8]
    before, after = "Water 13 Dec 2025 (before)", "Water 16 Jan 2026 (flood)"
    for name, day in ((before, "2025-12-13"), (after, "2026-01-16")):
        m.add_tile_layer(
            dswx_day(DSWX_S1, day, DSWX_S1_COLORMAP),
            name=name,
            attribution=TITILER_ATTR,
            bounds=bounds,
            maxZoom=12,
        )
    swipe(m, before, after)
    map_legend(
        m,
        "Mozambique floods",
        hide=[before],
        custom={after: {"title": "OPERA DSWx-S1 (radar)", "items": water_legend(True)}},
    )
    save(
        m,
        "mozambique-floods-january-2026",
        "Mozambique Floods, January 2026",
        "Swipe NASA OPERA DSWx-S1 radar surface water over southern Mozambique on "
        "13 December 2025 and on 16 January 2026, after heavy rain flooded the lower "
        "Limpopo valley and coastal wetlands. Radar maps water through the storm cloud. "
        "Rendered from the original granules by titiler-cmr. Source: NASA OPERA (JPL); "
        "contains modified Copernicus Sentinel data.",
        ["natural-hazards", "swipe", "imagery", "dswx-s1"],
    )


def thailand():
    """Monsoon floods across Prachin Buri, eastern Thailand, October 2026."""
    m = Map(center=(101.35, 14.05), zoom=9.2, basemap="positron")
    bounds = [100.6, 13.5, 102.2, 14.6]
    before, after = "Water 15 Aug 2026 (before)", "Water 2 Oct 2026 (flood)"
    for name, day in ((before, "2026-08-15"), (after, "2026-10-02")):
        m.add_tile_layer(
            dswx_day(DSWX_S1, day, DSWX_S1_COLORMAP),
            name=name,
            attribution=TITILER_ATTR,
            bounds=bounds,
            maxZoom=12,
        )
    swipe(m, before, after)
    map_legend(
        m,
        "Thailand floods",
        hide=[before],
        custom={after: {"title": "OPERA DSWx-S1 (radar)", "items": water_legend(True)}},
    )
    save(
        m,
        "thailand-floods-october-2026",
        "Thailand Floods, October 2026",
        "Swipe NASA OPERA DSWx-S1 radar surface water over Prachin Buri, eastern Thailand, "
        "on 15 August 2026 and on 2 October 2026, after weeks of heavy rain from mid-September "
        "flooded rice fields, orchards and aquaculture ponds. Rendered from the original "
        "granules by titiler-cmr. Source: NASA OPERA (JPL); contains modified Copernicus "
        "Sentinel data.",
        ["natural-hazards", "swipe", "imagery", "dswx-s1"],
    )


# ------------------------------------------------------------ disturbance
def jasper():
    """Vegetation loss from the Jasper wildfire, July 2024."""
    m = Map(center=(-118.05, 52.83), zoom=10.3, basemap="positron")
    m.add_tile_layer(ESRI_IMAGERY, name="Esri World Imagery", attribution=ESRI_ATTR)
    name = "Disturbance status 20 Aug 2024"
    m.add_tile_layer(
        gibs("OPERA_L3_DIST-ALERT-HLS_Color_Index", "2024-08-20"),
        name=name,
        attribution=GIBS_ATTR,
        maxZoom=12,
        blendMode="screen",
    )
    map_legend(
        m,
        "Jasper wildfire",
        hide=["Esri World Imagery"],
        custom={name: {"title": "OPERA DIST-ALERT", "items": DIST_LEGEND}},
    )
    save(
        m,
        "jasper-wildfire-2024",
        "Jasper Wildfire, 2024",
        "NASA OPERA DIST-ALERT vegetation disturbance on 20 August 2024, a month after the "
        "wildfire that burned about a third of the town of Jasper and 32,000 hectares of "
        "Jasper National Park, Alberta, over Esri satellite imagery. Source: NASA OPERA (JPL) "
        "via NASA GIBS; Harmonized Landsat and Sentinel-2.",
        ["natural-hazards", "imagery", "dist-alert"],
    )


def park_fire():
    """The Park Fire, California's fourth-largest wildfire, summer 2024."""
    m = Map(center=(-121.73, 40.02), zoom=9.4, basemap="positron")
    m.add_tile_layer(ESRI_IMAGERY, name="Esri World Imagery", attribution=ESRI_ATTR)
    name = "Disturbance status 28 Aug 2024"
    m.add_tile_layer(
        gibs("OPERA_L3_DIST-ALERT-HLS_Color_Index", "2024-08-28"),
        name=name,
        attribution=GIBS_ATTR,
        maxZoom=12,
        blendMode="screen",
    )
    map_legend(
        m,
        "Park Fire",
        hide=["Esri World Imagery"],
        custom={name: {"title": "OPERA DIST-ALERT", "items": DIST_LEGEND}},
    )
    save(
        m,
        "park-fire-california-2024",
        "Park Fire, California 2024",
        "NASA OPERA DIST-ALERT vegetation disturbance on 28 August 2024 across the scar of the "
        "Park Fire, which burned more than 160,000 hectares north of Chico, California, from "
        "late July 2024, over Esri satellite imagery. Source: NASA OPERA (JPL) via NASA GIBS; "
        "Harmonized Landsat and Sentinel-2.",
        ["natural-hazards", "imagery", "dist-alert"],
    )


def ontario_fires():
    """Burn scars of northwestern Ontario's record 2026 fire season."""
    m = Map(center=(-89.65, 50.2), zoom=8.3, basemap="positron")
    m.add_tile_layer(ESRI_IMAGERY, name="Esri World Imagery", attribution=ESRI_ATTR)
    name = "Disturbance status 5 Oct 2026"
    m.add_tile_layer(
        gibs("OPERA_L3_DIST-ALERT-HLS_Color_Index", "2026-10-05"),
        name=name,
        attribution=GIBS_ATTR,
        maxZoom=12,
        blendMode="screen",
    )
    map_legend(
        m,
        "Ontario wildfires",
        hide=["Esri World Imagery"],
        custom={name: {"title": "OPERA DIST-ALERT", "items": DIST_LEGEND}},
    )
    save(
        m,
        "northwestern-ontario-wildfires-2026",
        "Northwestern Ontario Wildfires, 2026",
        "NASA OPERA DIST-ALERT vegetation disturbance on 5 October 2026 across the boreal "
        "forest of northwestern Ontario, where the 2026 season produced the largest fire on "
        "record in the province (Thunder Bay 36), over Esri satellite imagery. Red marks "
        "confirmed loss of half or more of the vegetation cover. Source: NASA OPERA (JPL) "
        "via NASA GIBS; Harmonized Landsat and Sentinel-2.",
        ["natural-hazards", "imagery", "dist-alert"],
    )


# ------------------------------------------------------------------ radar
def columbia_basin():
    """Center-pivot farms of the Columbia Basin in Sentinel-1 radar."""
    m = Map(center=(-119.2, 46.45), zoom=9.6, basemap="dark")
    name = "Sentinel-1 radar backscatter, 21 Jul 2025"
    m.add_tile_layer(
        gibs("OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1", "2025-07-21"),
        name=name,
        attribution=GIBS_ATTR,
        maxZoom=12,
    )
    map_legend(
        m,
        "Columbia Basin radar",
        custom={
            name: {
                "title": "False-color SAR backscatter",
                "items": items(
                    {
                        "Black: water, smooth ground": "#000000",
                        "Magenta: weak return": "#c020c0",
                        "Green: moderate return": "#78b878",
                        "White: strong return": "#f0f0f0",
                    }
                ),
            }
        },
    )
    save(
        m,
        "columbia-basin-crop-circles-in-radar",
        "Columbia Basin Crop Circles in Radar",
        "Sentinel-1 radar view of the irrigated Columbia Basin around the Tri-Cities, "
        "Washington, from the NASA OPERA RTC-S1 product (radiometrically terrain-corrected "
        "backscatter, false color), 21 July 2025. Each round center-pivot field returns a "
        "different signal as its crop grows. Source: NASA OPERA (JPL/ASF) via NASA GIBS; "
        "contains modified Copernicus Sentinel data.",
        ["space", "imagery", "rtc-s1"],
    )


# ------------------------------------------------------------ ground motion
def displacement_legend(limit_cm):
    """Return legend items for a symmetric RdBu displacement stretch.

    Args:
        limit_cm: The stretch limit in centimeters.

    Returns:
        A list of legend item dicts, sinking first.
    """
    half = f"{limit_cm / 2:g}"
    return items(
        {
            f"{limit_cm} cm or more away (sinking)": RDBU[0],
            f"{half} cm away": RDBU[1],
            "No motion": RDBU[2],
            f"{half} cm toward": RDBU[3],
            f"{limit_cm} cm or more toward (rising)": RDBU[4],
        }
    )


def central_valley():
    """Groundwater-driven subsidence in the San Joaquin Valley, summer 2022."""
    m = Map(center=(-119.75, 36.05), zoom=8.3, basemap="positron")
    name = "Displacement 18 May - 14 Nov 2022"
    granule = "OPERA_L3_DISP-S1_IW_F36541_VV_20220518T015901Z_20221114T015908Z_v1.0_20250417T153203Z"
    m.add_tile_layer(
        disp(granule, 0.15),
        name=name,
        attribution=TITILER_ATTR,
        bounds=[-121.3, 35.0, -118.6, 37.0],
        maxZoom=12,
    )
    m.set_layer_opacity(name, 0.85)
    map_legend(
        m,
        "Ground motion, 2022",
        custom={
            name: {"title": "Line-of-sight motion", "items": displacement_legend(15)}
        },
    )
    save(
        m,
        "san-joaquin-valley-sinking-2022",
        "San Joaquin Valley Sinking, 2022",
        "NASA OPERA DISP-S1 ground displacement from Sentinel-1 radar interferometry between "
        "18 May and 14 November 2022, a drought year of heavy groundwater pumping. Red areas "
        "around Corcoran and the old Tulare Lake bed moved more than 15 cm away from the "
        "satellite, mostly by sinking. Rendered by titiler-cmr. Source: NASA OPERA (JPL/ASF); "
        "contains modified Copernicus Sentinel data.",
        ["natural-hazards", "imagery", "disp-s1"],
    )


def mexico_city():
    """Mexico City, one of the fastest-sinking cities on Earth."""
    m = Map(center=(-99.0, 19.4), zoom=10.3, basemap="positron")
    name = "Displacement 9 Nov 2023 - 26 May 2025"
    granule = "OPERA_L3_DISP-S1_IW_F38246_VV_20231109T122616Z_20250526T122605Z_v1.0_20260306T202711Z"
    m.add_tile_layer(
        disp(granule, 0.4),
        name=name,
        attribution=TITILER_ATTR,
        bounds=[-99.6, 18.9, -98.6, 19.9],
        maxZoom=13,
    )
    m.set_layer_opacity(name, 0.8)
    map_legend(
        m,
        "Mexico City sinking",
        custom={
            name: {"title": "Line-of-sight motion", "items": displacement_legend(40)}
        },
    )
    save(
        m,
        "mexico-city-sinking",
        "Mexico City Sinking",
        "NASA OPERA DISP-S1 ground displacement over Mexico City from Sentinel-1 radar "
        "interferometry, 9 November 2023 to 26 May 2025. The old lake bed east of the center, "
        "drained by centuries of groundwater pumping, moved up to 40 cm away from the "
        "satellite in 18 months. Rendered by titiler-cmr. Source: NASA OPERA (JPL/ASF); "
        "contains modified Copernicus Sentinel data.",
        ["natural-hazards", "imagery", "disp-s1"],
    )


# ------------------------------------------------------------------ coverage
def count_dswx_hls_looks(path):
    """Count DSWx-HLS granules per MGRS tile in July 2025 from NASA CMR.

    Runs one paged CMR query per day in parallel (about 380,000 granules).

    Args:
        path: Where to cache the per-tile counts as JSON.
    """
    url = "https://cmr.earthdata.nasa.gov/search/granules.json"

    def fetch_day(day):
        headers, rows = {}, []
        params = {
            "short_name": "OPERA_L3_DSWX-HLS_V1",
            "page_size": 2000,
            "temporal": f"2025-07-{day:02d}T00:00:00Z,2025-07-{day:02d}T23:59:59Z",
        }
        while True:
            for attempt in range(6):
                try:
                    r = requests.get(url, params=params, headers=headers, timeout=300)
                    r.raise_for_status()
                    break
                except requests.RequestException:
                    if attempt == 5:
                        raise
                    time.sleep(15)
            entries = r.json()["feed"]["entry"]
            rows += [(e["title"], (e.get("boxes") or [None])[0]) for e in entries]
            after = r.headers.get("CMR-Search-After")
            if not after or len(entries) < 2000:
                return rows
            headers["CMR-Search-After"] = after

    with ThreadPoolExecutor(10) as ex:
        days = list(ex.map(fetch_day, range(1, 32)))
    tiles = {}
    for rows in days:
        for title, box in rows:
            tile, day = re.search(r"_T(\d{2}[A-Z]{3})_(\d{8})T", title).groups()
            sensor = re.search(r"_(L8|L9|S2[A-D])_30_", title)
            t = tiles.setdefault(
                tile, {"n": 0, "days": set(), "box": None, "sensors": set()}
            )
            t["n"] += 1
            t["days"].add(day)
            t["sensors"].add(sensor.group(1) if sensor else "?")
            t["box"] = t["box"] or box
    path.write_text(
        json.dumps(
            {
                k: {
                    "n": v["n"],
                    "days": len(v["days"]),
                    "box": v["box"],
                    "sensors": sorted(v["sensors"]),
                }
                for k, v in tiles.items()
            }
        )
    )


def coverage():
    """How often OPERA DSWx-HLS mapped each MGRS tile in July 2025."""
    path = CACHE / "dswx_hls_2025_07_tiles.json"
    if not path.exists():
        count_dswx_hls_looks(path)
    tiles = json.loads(path.read_text())
    features = []
    for tile, t in sorted(tiles.items()):
        if not t["box"]:
            continue
        s, w, n, e = (float(v) for v in t["box"].split())
        if e < w:  # skip the few tiles that cross the antimeridian
            continue
        ring = [
            [round(w, 3), round(s, 3)],
            [round(e, 3), round(s, 3)],
            [round(e, 3), round(n, 3)],
            [round(w, 3), round(n, 3)],
            [round(w, 3), round(s, 3)],
        ]
        sensors = ", ".join(
            x.replace("L8", "Landsat 8")
            .replace("L9", "Landsat 9")
            .replace("S2", "Sentinel-2")
            for x in t["sensors"]
        )
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [ring]},
                "properties": {
                    "MGRS tile": tile,
                    "Days observed": t["days"],
                    "granules": t["n"],
                    "sensors": sensors,
                },
            }
        )
    print(f"coverage: {len(features)} tiles")
    m = Map(center=(5, 22), zoom=1.35, basemap="positron")
    m.set_projection("mercator")
    stops = [
        (1, "#fde725", "1-7 days"),
        (8, "#5ec962", "8-11 days"),
        (12, "#21918c", "12-15 days"),
        (16, "#3b528b", "16-19 days"),
        (20, "#440154", "20 days or more"),
    ]
    m.add_geojson(
        {"type": "FeatureCollection", "features": features},
        name="DSWx-HLS looks, July 2025",
        vectorStyleMode="graduated",
        vectorStyleProperty="Days observed",
        vectorStyleClassCount=5,
        vectorStyleClassificationScheme="manual",
        vectorStyleStops=[
            {"value": v, "color": c, "label": lab} for v, c, lab in stops
        ],
        fillColor=stops[0][1],
        fillOpacity=0.75,
        strokeColor="#0b1322",
        strokeWidth=0.3,
        popup=[
            {"field": "MGRS tile", "label": "MGRS tile"},
            {
                "field": "Days observed",
                "label": "Days with a look",
                "kind": "number",
                "suffix": " of 31",
            },
            {"field": "granules", "label": "DSWx-HLS granules", "kind": "number"},
            {"field": "sensors", "label": "Satellites"},
        ],
        tooltip=True,
    )
    map_legend(m, "Days mapped, Jul 2025")
    save(
        m,
        "how-often-opera-maps-surface-water",
        "How Often OPERA Maps Surface Water",
        "Every 110 km MGRS tile that NASA OPERA's DSWx-HLS product mapped in July 2025, "
        "colored by the number of days with at least one DSWx-HLS granule from Landsat 8/9 or "
        "Sentinel-2, "
        "from 380,000 granules listed in NASA CMR. Overlapping polar orbits make high "
        "latitudes the most often mapped; South and Southeast Asia, under the July monsoon, "
        "the least. Source: NASA OPERA (JPL) granule metadata from NASA CMR.",
        ["space", "dswx-hls"],
    )


PROJECTS = [
    kakhovka,
    thessaly,
    tulare,
    punjab,
    mozambique,
    thailand,
    jasper,
    park_fire,
    ontario_fires,
    columbia_basin,
    central_valley,
    mexico_city,
    coverage,
]

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)
    wanted = sys.argv[1:]
    for build in PROJECTS:
        if not wanted or any(w in build.__name__ for w in wanted):
            build()
