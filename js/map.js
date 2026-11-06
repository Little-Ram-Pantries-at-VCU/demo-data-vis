/* VCU Campus Wi-Fi coverage map
 *
 * Loads data/processed/summary.json and data/processed/fixes.geojson (both
 * produced by scripts/build.py), then aggregates fixes into grid cells in the
 * browser so every filter (network, band, date, device) re-computes the medians
 * live.  grid.geojson is the same aggregation with no filters applied; it is
 * offered for download / GIS use but not needed by this page.
 */
(function () {
  "use strict";

  const TIER_COLORS = {
    excellent: cssVar("--tier-excellent"),
    good: cssVar("--tier-good"),
    fair: cssVar("--tier-fair"),
    poor: cssVar("--tier-poor"),
    none: cssVar("--tier-none"),
    nodata: cssVar("--tier-nodata"),
  };

  let SUMMARY, FIXES, GRID, BUILDINGS = null;
  let lastSurveyed = new Set();
  const NODATA_MAX_CELLS = 40000; // beyond this the gray layer is skipped until you zoom in
  let map, canvas, cellLayer, noDataLayer, fixLayer, buildingLayer;
  const cellShapes = new Map(); // "ix,iy" -> L.Rectangle (reused across re-renders)

  // ------------------------------------------------------------------ boot
  Promise.all([
    fetch("data/processed/summary.json").then(r => r.json()),
    fetch("data/processed/fixes.geojson").then(r => r.json()),
    // Optional: only present once scripts/fetch_buildings.py has been run.
    fetch("data/processed/buildings.geojson").then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]).then(([summary, fixes, buildings]) => {
    SUMMARY = summary;
    GRID = summary.grid;
    BUILDINGS = buildings && buildings.features.length ? buildings : null;
    FIXES = fixes.features.map(f => Object.assign({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }, f.properties));
    initMap();
    initControls();
    render();
  }).catch(err => {
    document.getElementById("subtitle").textContent =
      "Could not load data/processed/*.json — run scripts/build.py (or check the GitHub Action). " + err;
  });

  // ------------------------------------------------------------------ map
  function initMap() {
    const b = SUMMARY.bbox;
    map = L.map("map", { preferCanvas: true });
    map.fitBounds([[b.min_lat, b.min_lon], [b.max_lat, b.max_lon]]);

    // OpenStreetMap standard tiles: free, no key.  Please keep the attribution.
    // (CARTO's basemaps now require an API key.)
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    if (!SUMMARY.bbox_auto) {
      L.rectangle([[b.min_lat, b.min_lon], [b.max_lat, b.max_lon]],
        { color: "#52514e", weight: 1, dashArray: "4 4", fill: false, interactive: false }).addTo(map);
    }

    canvas = L.canvas({ padding: 0.3 });
    noDataLayer = L.layerGroup().addTo(map);
    cellLayer = L.layerGroup().addTo(map);
    buildingLayer = L.layerGroup().addTo(map);
    fixLayer = L.layerGroup();
    // Unsurveyed cells are drawn only for the visible viewport, so any study-area size is fine.
    map.on("moveend", () => renderNoData(lastSurveyed));

    document.getElementById("cell-size").textContent = GRID.cell_size_m;
    document.getElementById("subtitle").textContent =
      `${SUMMARY.n_fixes.toLocaleString()} GPS fixes · ${SUMMARY.dates.length} survey days ` +
      `(${SUMMARY.date_range[0]} → ${SUMMARY.date_range[1]}) · ` +
      `${SUMMARY.devices.length} device${SUMMARY.devices.length === 1 ? "" : "s"} · built ${SUMMARY.generated_at.slice(0, 10)}`;
  }

  // ------------------------------------------------------------------ controls
  function initControls() {
    const ssid = el("f-ssid");
    for (const label of Object.keys(SUMMARY.campus_ssids)) {
      ssid.append(new Option(`${label} (${SUMMARY.campus_ssids[label]})`, label));
    }
    const from = el("f-from"), to = el("f-to");
    const first = SUMMARY.dates[0], last = SUMMARY.dates[SUMMARY.dates.length - 1];
    from.min = to.min = first; from.max = to.max = last;
    from.value = first; to.value = last;

    const devs = el("f-devices");
    for (const d of SUMMARY.devices) {
      const lab = document.createElement("label");
      const cb = Object.assign(document.createElement("input"), { type: "checkbox", value: d, checked: true });
      lab.append(cb, " " + d);
      devs.append(lab);
    }
    if (SUMMARY.devices.length < 2) devs.style.display = "none";

    const bsec = document.getElementById("buildings-section");
    if (!BUILDINGS) {
      el("l-buildings").closest("label").style.display = "none";
      bsec.querySelector("p.muted").textContent =
        "No building layer yet — run scripts/fetch_buildings.py, commit data/buildings.geojson and push.";
      bsec.querySelector("table").style.display = "none";
    }

    for (const id of ["f-ssid", "f-band", "f-from", "f-to", "f-min", "l-nodata", "l-fixes", "l-buildings"]) {
      el(id).addEventListener("change", render);
    }
    devs.addEventListener("change", render);
    el("f-reset").addEventListener("click", () => {
      ssid.value = "any"; el("f-band").value = "any"; el("f-min").value = 1;
      from.value = SUMMARY.dates[0]; to.value = SUMMARY.dates[SUMMARY.dates.length - 1];
      devs.querySelectorAll("input").forEach(c => (c.checked = true));
      el("l-nodata").checked = true; el("l-fixes").checked = false; el("l-buildings").checked = true;
      render();
    });

    // Legend (static)
    const leg = el("legend");
    const items = SUMMARY.tiers.map(t => [t.id, t.label]);
    items.push(["none", "Surveyed, no campus Wi‑Fi observed"], ["nodata", "Not yet surveyed"]);
    for (const [id, label] of items) {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "swatch " + id;
      if (id !== "none") sw.style.background = TIER_COLORS[id];
      if (id === "nodata") sw.style.opacity = 0.6;
      const cnt = document.createElement("span");
      cnt.className = "count"; cnt.dataset.tier = id;
      li.append(sw, label, cnt);
      leg.append(li);
    }
  }

  // ------------------------------------------------------------------ filtering + aggregation
  function currentFilter() {
    const devs = [...document.querySelectorAll("#f-devices input:checked")].map(c => c.value);
    // An empty/cleared date input means "no bound".
    return {
      ssid: el("f-ssid").value,
      band: el("f-band").value,
      from: el("f-from").value || "0000-00-00",
      to: el("f-to").value || "9999-99-99",
      min: Math.max(1, parseInt(el("f-min").value, 10) || 1),
      devices: new Set(devs),
    };
  }

  /** Best campus RSSI for a fix under the current network/band filter, or null. */
  function bestFor(fix, f) {
    let best = null;
    for (const [label, bands] of Object.entries(fix.sig)) {
      if (f.ssid !== "any" && label !== f.ssid) continue;
      for (const [band, rssi] of Object.entries(bands)) {
        if (f.band !== "any" && band !== f.band) continue;
        if (best === null || rssi > best) best = rssi;
      }
    }
    return best;
  }

  function aggregate(f) {
    const cells = new Map();
    for (const fx of FIXES) {
      if (fx.date && (fx.date < f.from || fx.date > f.to)) continue;
      if (!f.devices.has(fx.device)) continue;
      const key = fx.cell[0] + "," + fx.cell[1];
      let c = cells.get(key);
      if (!c) {
        c = { ix: fx.cell[0], iy: fx.cell[1], fixes: [], bests: [], dates: new Set(), devices: new Set() };
        cells.set(key, c);
      }
      c.fixes.push(fx);
      const b = bestFor(fx, f);
      if (b !== null) c.bests.push(b);
      if (fx.date) c.dates.add(fx.date);
      c.devices.add(fx.device);
    }
    const out = [];
    for (const c of cells.values()) {
      if (c.fixes.length < f.min) continue;
      c.median = c.bests.length ? median(c.bests) : null;
      c.max = c.bests.length ? Math.max(...c.bests) : null;
      c.tier = tierFor(c.median);
      out.push(c);
    }
    return out;
  }

  function tierFor(m) {
    if (m === null) return "none";
    for (const t of SUMMARY.tiers) if (m >= t.min) return t.id;
    return SUMMARY.tiers[SUMMARY.tiers.length - 1].id;
  }

  /** Per-building perimeter stats under the current filters (fix.bld is set by build.py). */
  function aggregateBuildings(f) {
    const by = new Map();
    for (const fx of FIXES) {
      if (!fx.bld || !fx.bld.length) continue;
      if (fx.date && (fx.date < f.from || fx.date > f.to)) continue;
      if (!f.devices.has(fx.device)) continue;
      const b = bestFor(fx, f);
      for (const id of fx.bld) {
        let s = by.get(id);
        if (!s) { s = { n: 0, bests: [], dates: new Set() }; by.set(id, s); }
        s.n++;
        if (b !== null) s.bests.push(b);
        if (fx.date) s.dates.add(fx.date);
      }
    }
    const out = [];
    for (const feat of BUILDINGS.features) {
      const s = by.get(feat.id || feat.properties.id);
      const st = { feat, name: feat.properties.name || `(unnamed ${feat.properties.building || "building"})`,
                   n: s ? s.n : 0, nSig: s ? s.bests.length : 0,
                   median: s && s.bests.length ? median(s.bests) : null,
                   min: s && s.bests.length ? Math.min(...s.bests) : null,
                   dates: s ? [...s.dates].sort() : [] };
      st.tier = st.n ? tierFor(st.median) : "nodata";
      out.push(st);
    }
    return out;
  }

  // ------------------------------------------------------------------ render
  function render() {
    const f = currentFilter();
    const cells = aggregate(f);
    const surveyed = new Set(cells.map(c => c.ix + "," + c.iy));

    cellLayer.clearLayers();
    for (const c of cells) {
      const shape = L.rectangle(cellBounds(c.ix, c.iy), styleFor(c));
      shape.bindTooltip(tooltipFor(c), { className: "cell-tip", sticky: true });
      shape.on("click", () => map.fitBounds(cellBounds(c.ix, c.iy), { maxZoom: 19 }));
      cellLayer.addLayer(shape);
    }

    lastSurveyed = surveyed;
    renderNoData(surveyed);

    fixLayer.clearLayers();
    if (el("l-fixes").checked) {
      for (const fx of FIXES) {
        if (fx.date && (fx.date < f.from || fx.date > f.to)) continue;
        if (!f.devices.has(fx.device)) continue;
        const b = bestFor(fx, f);
        const m = L.circleMarker([fx.lat, fx.lon], {
          renderer: canvas, radius: 4, weight: 1, color: "#fff",
          fillColor: b === null ? TIER_COLORS.none : TIER_COLORS[tierFor(b)], fillOpacity: 0.9,
        });
        m.bindTooltip(
          `<b>${fx.date || "date unknown"} ${fx.time || ""}</b><br>` +
          (b === null ? "No campus network logged" : `Best campus RSSI: ${b} dBm (${fx.best_ssid}, ${fx.best_band} GHz)`) +
          `<br>${fx.n_aps} networks logged · ±${fx.acc ?? "?"} m · ${fx.device}`,
          { className: "cell-tip" });
        fixLayer.addLayer(m);
      }
      if (!map.hasLayer(fixLayer)) fixLayer.addTo(map);
    } else if (map.hasLayer(fixLayer)) {
      map.removeLayer(fixLayer);
    }

    buildingLayer.clearLayers();
    let bstats = null;
    if (BUILDINGS && el("l-buildings").checked) {
      bstats = aggregateBuildings(f);
      for (const st of bstats) {
        const color = st.tier === "nodata" ? "#52514e" : TIER_COLORS[st.tier];
        // White casing underneath so the outline reads over same-colored cells.
        buildingLayer.addLayer(L.geoJSON(st.feat, { interactive: false, style: {
          renderer: canvas, color: "#ffffff", weight: st.tier === "nodata" ? 3 : 5, opacity: 0.9, fill: false,
        }}));
        const poly = L.geoJSON(st.feat, { style: {
          renderer: canvas, color, weight: st.tier === "nodata" ? 1 : 2.5, opacity: 1,
          fillColor: "#ffffff", fillOpacity: st.tier === "nodata" ? 0.15 : 0.35,
          dashArray: st.tier === "none" ? "4 3" : null,
        }});
        poly.bindTooltip(buildingTooltip(st), { className: "cell-tip", sticky: true });
        poly.on("click", () => map.fitBounds(poly.getBounds().pad(1.5), { maxZoom: 18 }));
        buildingLayer.addLayer(poly);
      }
    }

    updateStats(cells, f);
    if (BUILDINGS) updateBuildingTable(bstats || aggregateBuildings(f));
  }

  function buildingTooltip(st) {
    const tier = SUMMARY.tiers.find(t => t.id === st.tier);
    const lines = [`<b>${st.name}</b>`];
    if (st.tier === "nodata") { lines.push(`No fixes within ${SUMMARY.perimeter_m} m of this building yet`); return lines.join("<br>"); }
    lines.push(tier ? tier.label : "Surveyed perimeter — no campus Wi‑Fi observed");
    if (st.median !== null) lines.push(`Median best RSSI: <b>${st.median} dBm</b> (weakest ${st.min})`);
    lines.push(`${st.n} fixes within ${SUMMARY.perimeter_m} m, ${st.nSig} with campus Wi‑Fi`);
    lines.push(`Dates: ${st.dates.join(", ") || "unknown"}`);
    return lines.join("<br>");
  }

  function updateBuildingTable(bstats) {
    const surveyed = bstats.filter(s => s.n > 0);
    const sec = el("buildings-section");
    sec.querySelector("p.muted").textContent =
      `${surveyed.length} of ${bstats.length} OSM footprints have fixes within ${SUMMARY.perimeter_m} m. ` +
      `Weakest median first; rows with no campus Wi‑Fi at all come last. Click to zoom.`;
    const tbody = sec.querySelector("tbody");
    tbody.innerHTML = "";
    surveyed.sort((a, b) => {
      if (a.median === null && b.median === null) return b.n - a.n;
      if (a.median === null) return 1;
      if (b.median === null) return -1;
      return a.median - b.median;
    }).slice(0, 15).forEach(st => {
      const tr = document.createElement("tr");
      const sw = `<span class="swatch-inline" style="background:${st.tier === "none" ? TIER_COLORS.none : TIER_COLORS[st.tier]}"></span>`;
      tr.innerHTML = `<td>${sw}${escapeHtml(st.name)}</td><td>${st.median === null ? "—" : st.median}</td><td>${st.n}</td>`;
      tr.addEventListener("click", () => map.fitBounds(L.geoJSON(st.feat).getBounds().pad(1.5), { maxZoom: 18 }));
      tbody.append(tr);
    });
  }

  /** Draw unsurveyed cells, but only those inside the current viewport. */
  function renderNoData(surveyed) {
    noDataLayer.clearLayers();
    if (!el("l-nodata").checked || !map) return;
    const vb = map.getBounds();
    const ix0 = Math.max(0, Math.floor((vb.getWest() - GRID.origin_lon) / GRID.dlon));
    const ix1 = Math.min(GRID.nx - 1, Math.ceil((vb.getEast() - GRID.origin_lon) / GRID.dlon));
    const iy0 = Math.max(0, Math.floor((vb.getSouth() - GRID.origin_lat) / GRID.dlat));
    const iy1 = Math.min(GRID.ny - 1, Math.ceil((vb.getNorth() - GRID.origin_lat) / GRID.dlat));
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > NODATA_MAX_CELLS) return; // zoomed too far out
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        if (surveyed.has(ix + "," + iy)) continue;
        noDataLayer.addLayer(L.rectangle(cellBounds(ix, iy), {
          renderer: canvas, stroke: false, fillColor: TIER_COLORS.nodata, fillOpacity: 0.18, interactive: false,
        }));
      }
    }
  }

  function styleFor(c) {
    const base = { renderer: canvas, weight: 0.5, color: "#ffffff", opacity: 0.8, fillOpacity: 0.75 };
    if (c.tier === "none") {
      return Object.assign(base, { fillColor: TIER_COLORS.none, fillOpacity: 0.55, color: TIER_COLORS.none, weight: 1, dashArray: "3 3" });
    }
    return Object.assign(base, { fillColor: TIER_COLORS[c.tier] });
  }

  function tooltipFor(c) {
    const tier = SUMMARY.tiers.find(t => t.id === c.tier);
    const lines = [`<b>${tier ? tier.label : "Surveyed — no campus Wi‑Fi observed"}</b>`];
    if (c.median !== null) lines.push(`Median best RSSI: <b>${c.median} dBm</b> (max ${c.max})`);
    lines.push(`${c.fixes.length} fix${c.fixes.length === 1 ? "" : "es"}, ${c.bests.length} with campus Wi‑Fi`);
    lines.push(`Dates: ${[...c.dates].sort().join(", ") || "unknown"}`);
    if (SUMMARY.devices.length > 1) lines.push(`Devices: ${[...c.devices].join(", ")}`);
    return lines.join("<br>");
  }

  function updateStats(cells, f) {
    const byTier = {};
    for (const c of cells) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
    const total = GRID.nx * GRID.ny;
    document.querySelectorAll("#legend .count").forEach(span => {
      const t = span.dataset.tier;
      // In auto-fit mode the extent is just "where the data happens to reach", so an unsurveyed count means little.
      span.textContent = t === "nodata"
        ? (SUMMARY.bbox_auto ? "" : (total - cells.length).toLocaleString())
        : (byTier[t] || 0).toLocaleString();
    });

    const withSig = cells.filter(c => c.median !== null);
    const strong = cells.filter(c => c.tier === "excellent" || c.tier === "good").length;
    const stats = SUMMARY.bbox_auto
      ? [["Cells surveyed", cells.length.toLocaleString()]]
      : [["Grid cells in study area", total.toLocaleString()],
         ["Cells surveyed", `${cells.length.toLocaleString()} (${pct(cells.length, total)})`]];
    stats.push(
      ["…with campus Wi‑Fi observed", `${withSig.length.toLocaleString()} (${pct(withSig.length, cells.length)})`],
      ["…good or excellent", `${strong.toLocaleString()} (${pct(strong, withSig.length)})`],
      ["…no campus Wi‑Fi observed", `${(byTier.none || 0).toLocaleString()} (${pct(byTier.none || 0, cells.length)})`],
      ["Overall median RSSI", withSig.length ? `${median(withSig.map(c => c.median))} dBm` : "—"],
    );
    const dl = el("stats");
    dl.innerHTML = "";
    for (const [k, v] of stats) {
      dl.append(Object.assign(document.createElement("dt"), { textContent: k }),
                Object.assign(document.createElement("dd"), { textContent: v }));
    }

    const tbody = document.querySelector("#worst tbody");
    tbody.innerHTML = "";
    withSig.sort((a, b) => a.median - b.median).slice(0, 12).forEach(c => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${c.median}</td><td>${c.fixes.length}</td><td>${[...c.dates].sort().join(", ")}</td>`;
      tr.addEventListener("click", () => map.fitBounds(cellBounds(c.ix, c.iy), { maxZoom: 19 }));
      tbody.append(tr);
    });
  }

  // ------------------------------------------------------------------ helpers
  function cellBounds(ix, iy) {
    const s = GRID.origin_lat + iy * GRID.dlat, w = GRID.origin_lon + ix * GRID.dlon;
    return [[s, w], [s + GRID.dlat, w + GRID.dlon]];
  }
  function median(a) {
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function escapeHtml(t) { return String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function pct(n, d) { return d ? Math.round(100 * n / d) + "%" : "—"; }
  function el(id) { return document.getElementById(id); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
})();
