---
title: NASA OPERA for GeoLibre
hide:
  - navigation
  - toc
---

<div class="hero" markdown>
  <canvas id="opera-mosaic" aria-hidden="true"></canvas>
  <div class="hero-inner" markdown>

<p class="eyebrow">GeoLibre plugin &middot; v0.3.1 &middot; MIT</p>

# NASA OPERA for GeoLibre

<p class="hero-lede">Search NASA's OPERA products, put them on a MapLibre map, and ask an agent
to turn a place and a date range into a flood impact one-pager. No Earthdata
login in the browser.</p>

[Source on GitHub](https://github.com/opengeos/geolibre-nasa-opera){ .md-button .md-button--primary }
[Live demo](demo/){ .md-button }
[GeoLibre](https://github.com/opengeos/GeoLibre){ .md-button }
[OPERA mission](https://www.jpl.nasa.gov/go/opera){ .md-button }

<p class="chips">
<span class="chip">OPERA_L3_DSWX-HLS_V1</span>
<span class="chip">OPERA_L3_DSWX-S1_V1</span>
<span class="chip">OPERA_L3_DIST-ALERT-HLS_V1</span>
<span class="chip">OPERA_L3_DIST-ANN-HLS_V1</span>
<span class="chip">OPERA_L2_RTC-S1_V1</span>
<span class="chip">OPERA_L2_CSLC-S1_V1</span>
<span class="chip">+ static layers</span>
</p>

  </div>
</div>

## Video demos

Four walkthroughs on real disasters: granule search and display, agent-driven
flood mapping, land disturbance, and the plugin running inside GeoLibre.

<div class="demos">

  <article class="demo">
    <div class="frame">
      <a class="facade" href="https://youtu.be/XMhVJYyvfVY" data-id="XMhVJYyvfVY"
         target="_blank" rel="noopener"
         aria-label="Play: Mapping the October 2024 Valencia DANA flood">
        <img src="https://i.ytimg.com/vi/XMhVJYyvfVY/maxresdefault.jpg"
             onerror="this.src='https://i.ytimg.com/vi/XMhVJYyvfVY/hqdefault.jpg'"
             alt="" loading="lazy" />
        <span class="play" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 1.6 14 8 3 14.4Z" /></svg></span>
        <span class="cue">Play demo</span>
      </a>
    </div>
    <div class="demo-meta">
      <p class="stamp"><span>Valencia region, Spain</span><span>2024-10-27 &rarr; 2024-11-05</span><span>DSWx-HLS</span></p>
      <h3>Mapping the October 2024 Valencia DANA flood</h3>
      <p>The full constrained one-pager workflow from a single request: derive
      the observed water extent from OPERA DSWx, add pre- and post-event
      Sentinel-2, count flooded Overture buildings in 3D, estimate WorldPop
      exposure, and export a print-ready summary.</p>
      <div class="prompt"><em>Prompt</em>Map the flood in Valencia Region, Spain from 2024-10-27 to 2024-11-05.</div>
    </div>
  </article>

  <article class="demo">
    <div class="frame">
      <a class="facade" href="https://youtu.be/dg5bINQl2i8" data-id="dg5bINQl2i8"
         target="_blank" rel="noopener"
         aria-label="Play: Mapping the August 2026 Nepal floods">
        <img src="https://i.ytimg.com/vi/dg5bINQl2i8/maxresdefault.jpg"
             onerror="this.src='https://i.ytimg.com/vi/dg5bINQl2i8/hqdefault.jpg'"
             alt="" loading="lazy" />
        <span class="play" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 1.6 14 8 3 14.4Z" /></svg></span>
        <span class="cue">Play demo</span>
      </a>
    </div>
    <div class="demo-meta">
      <p class="stamp"><span>Nepal</span><span>August 2026</span><span>Surface water</span></p>
      <h3>Mapping the August 2026 Nepal floods</h3>
      <p>Search CMR for the event window, read the sortable granule table
      against its footprints on the map, and stack the selected scenes as
      titiler-cmr layers with the categorical water colormap.</p>
    </div>
  </article>

  <article class="demo">
    <div class="frame">
      <a class="facade" href="https://youtu.be/uovjoOTOu_4" data-id="uovjoOTOu_4"
         target="_blank" rel="noopener"
         aria-label="Play: Vegetation loss after the Nepal flash floods">
        <img src="https://i.ytimg.com/vi/uovjoOTOu_4/maxresdefault.jpg"
             onerror="this.src='https://i.ytimg.com/vi/uovjoOTOu_4/hqdefault.jpg'"
             alt="" loading="lazy" />
        <span class="play" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 1.6 14 8 3 14.4Z" /></svg></span>
        <span class="cue">Play demo</span>
      </a>
    </div>
    <div class="demo-meta">
      <p class="stamp"><span>Nepal</span><span>Post-flood</span><span>Land disturbance</span></p>
      <h3>Vegetation loss after the Nepal flash floods</h3>
      <p>Water recedes and the damage stays. OPERA's land disturbance products,
      DIST-ALERT for near-real-time change and DIST-ANN for the annual view, are
      what the plugin reaches for once the flood extent is no longer the story.</p>
    </div>
  </article>

  <article class="demo">
    <div class="frame">
      <a class="facade" href="https://youtu.be/GG7glFU5fAw" data-id="GG7glFU5fAw"
         target="_blank" rel="noopener"
         aria-label="Play: GeoLibre on the Nepal floods">
        <img src="https://i.ytimg.com/vi/GG7glFU5fAw/maxresdefault.jpg"
             onerror="this.src='https://i.ytimg.com/vi/GG7glFU5fAw/hqdefault.jpg'"
             alt="" loading="lazy" />
        <span class="play" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 1.6 14 8 3 14.4Z" /></svg></span>
        <span class="cue">Play demo</span>
      </a>
    </div>
    <div class="demo-meta">
      <p class="stamp"><span>Nepal</span><span>GeoLibre host</span><span>Docked panel</span></p>
      <h3>The plugin in its host: GeoLibre on the Nepal floods</h3>
      <p>How the pieces sit together in GeoLibre itself, with the OPERA panel
      docked in the right sidebar, OPERA rasters in the normal layer panel, and
      the GeoAgent chat floating over the map.</p>
    </div>
  </article>

</div>

## What the plugin does

`SEARCH`{ .tag }
:   Pick a product, set a bounding box by typing it, using the map extent, or
    drawing a box, choose a date range, and query the public NASA CMR API.
    Footprints land on the map as a GeoJSON layer beside a sortable results
    table, and selection runs both ways: click a row to highlight its footprint,
    click a footprint to select its row.

`DISPLAY`{ .tag }
:   Select one granule or many (++ctrl++-click to toggle, ++shift++-click for a
    range), pick a band, and render each granule as its own titiler-cmr layer
    pinned by `granule_ur`. Override rescale and colormap when a continuous band
    such as `B10_DEM` needs a stretch.

`ANALYZE`{ .tag }
:   Change detection between two dates, AOI statistics from a bbox or drawn
    geometry, point queries against raster pixels or xarray variables, and
    time-indexed TileJSON for temporal workflows.

`ASK`{ .tag }
:   The [OPERA GeoAgent](geoagent.md) operates the live map in plain language.
    It navigates, adds layers and markers, inspects what is visible, takes
    screenshots, and calls the OPERA-specific tools registered by this plugin.

`REPORT`{ .tag }
:   A self-contained, print- and PDF-ready
    [one-pager](flood-workflow.md) with the map snapshot, flood benchmark,
    building and transportation exposure, WorldPop population exposure, cited
    impact figures, and a generated background narrative.

## Where to go next

- [Supported products and the data path](products.md) - the eight OPERA
  collections, their render defaults, and how CMR and titiler-cmr fit together.
- [The OPERA GeoAgent](geoagent.md) - the domain tools the plugin registers and
  the prompts that drive them.
- [Flood one-pager workflow](flood-workflow.md) - from a place and a date range
  to a shareable impact summary.
- [Build and install](install.md) - into the GeoLibre web build or the Tauri
  desktop app.
