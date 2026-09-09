/* Page enhancements for the NASA OPERA plugin site.
   Wrapped in document$ so they re-run after instant navigation. */

document$.subscribe(function () {
  setupPlayers();
  drawMosaic();
});

/* Swap a thumbnail for the YouTube player on click. The anchor href is the
   no-JS fallback and stays reachable via middle-click. */
function setupPlayers() {
  document.querySelectorAll(".facade").forEach(function (link) {
    if (link.dataset.wired === "1") return;
    link.dataset.wired = "1";
    link.addEventListener("click", function (event) {
      event.preventDefault();
      var frame = document.createElement("iframe");
      frame.src =
        "https://www.youtube-nocookie.com/embed/" +
        link.getAttribute("data-id") +
        "?rel=0&autoplay=1";
      frame.title = link.getAttribute("aria-label") || "Demo video";
      frame.allow =
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      frame.allowFullscreen = true;
      link.parentNode.replaceChild(frame, link);
    });
  });
}

/* Hero backdrop: a coarse DSWx-style water classification mosaic. */
function drawMosaic() {
  var canvas = document.getElementById("opera-mosaic");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");

  function palette() {
    var slate =
      document.body.getAttribute("data-md-color-scheme") === "slate";
    return slate
      ? ["#0e1f28", "#123646", "#17566b", "#1f7d97", "#2ba3c4", "#00000000"]
      : ["#f9fbfb", "#dfeaed", "#bcd7de", "#8dbfcb", "#54a2b6", "#ffffff00"];
  }

  // Deterministic value noise, so the cells cluster the way a raster does.
  function hash(x, y) {
    var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function smooth(x, y) {
    var xi = Math.floor(x);
    var yi = Math.floor(y);
    var xf = x - xi;
    var yf = y - yi;
    var u = xf * xf * (3 - 2 * xf);
    var v = yf * yf * (3 - 2 * yf);
    return (
      hash(xi, yi) * (1 - u) * (1 - v) +
      hash(xi + 1, yi) * u * (1 - v) +
      hash(xi, yi + 1) * (1 - u) * v +
      hash(xi + 1, yi + 1) * u * v
    );
  }

  function draw() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var colors = palette();
    var cell = 14;
    for (var y = 0; y < h; y += cell) {
      for (var x = 0; x < w; x += cell) {
        var n = smooth(x / 90, y / 70) * 0.65 + smooth(x / 26, y / 22) * 0.35;
        var idx;
        if (n > 0.62) idx = 4;
        else if (n > 0.55) idx = 3;
        else if (n > 0.47) idx = 2;
        else if (n > 0.4) idx = 1;
        else if (n > 0.34) idx = 0;
        else idx = 5;
        ctx.fillStyle = colors[idx];
        ctx.fillRect(x, y, cell - 1, cell - 1);
      }
    }
  }

  draw();

  if (!canvas.dataset.wired) {
    canvas.dataset.wired = "1";
    var timer;
    window.addEventListener("resize", function () {
      clearTimeout(timer);
      timer = setTimeout(draw, 180);
    });
    // Repaint when the reader flips the palette toggle.
    new MutationObserver(draw).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-md-color-scheme"],
    });
  }
}
