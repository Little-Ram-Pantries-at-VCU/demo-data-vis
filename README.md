# VCU Campus Wi-Fi Coverage Map

[PUBLIC] A static GitHub Pages site that maps Wi-Fi signal strength (RSSI) across the VCU
Monroe Park and MCV campuses from surveys the senior-design team collects with the
[WiGLE](https://wigle.net) Android app. The goal is to find weak spots and dead spots in
campus coverage.

**Live site:** https://little-ram-pantries-at-vcu.github.io/demo-data-vis/

No server, no build tools, no API keys: Leaflet + OpenStreetMap tiles in the browser,
a 150-line Python script to turn raw CSVs into GeoJSON, and a GitHub Action that runs it.

## Repository layout

```
demo-data-vis/
├── index.html              # the map (Leaflet + OpenStreetMap tiles, free, no key)
├── js/map.js, css/style.css
├── data/
│   ├── README.md           # column dictionary + "how to add a survey" instructions
│   ├── raw/                # team drops WiGLE CSV exports here, one per session
│   │   ├── 2026-10-21_monroe-park.csv
│   │   └── 2026-11-04_mcv.csv
│   ├── campus_bbox.json    # the filter box (auto-fit to data by default)
│   ├── buildings.geojson   # OSM building footprints (fetched once by scripts/fetch_buildings.py)
│   └── processed/          # generated — never hand-edited
│       ├── fixes.geojson   # one point per GPS fix: best VCU RSSI, SSIDs seen, date
│       ├── grid.geojson    # ~25 m hex/grid cells: median RSSI, sample count
│       └── buildings.geojson  # footprints + per-building perimeter signal stats
├── scripts/build.py        # raw/*.csv → processed/*.geojson (dedupes, filters bbox)
├── scripts/fetch_buildings.py    # Overpass query → data/buildings.geojson
└── .github/workflows/build.yml   # runs build.py on any push to data/raw/, commits output
```

Two small additions to that plan in V1:

- `data/processed/summary.json` — counts, date list, device list and the tier/SSID
  configuration; the page reads this first.
- Raw file names carry a **device** tag (`YYYY-MM-DD_<area>_<device>.csv`) because the team
  collects with several phones and Meshtastic nodes. The map can filter by device.

## Adding data (the short version)

1. Export the WiGLE run as CSV.
2. Rename to `YYYY-MM-DD_<area>_<device>.csv` and put it in `data/raw/`.
3. Push to `main`. The Action regenerates `data/processed/` and Pages redeploys.

Full details, the column dictionary and the caveats are in [`data/README.md`](data/README.md).

## What the map shows

| layer | meaning |
|---|---|
| Blue squares | 25 m grid cells, shaded by the **median** of the strongest campus signal (VCU SafeNet / eduroam / VCU Guest) at each GPS fix in the cell. Darker = stronger. |
| Red dashed squares | Cells the team walked through where WiGLE logged **no** campus network — candidate dead spots (see caveat in `data/README.md`). |
| Gray squares | Cells inside the study area that have never been surveyed. The team's to-do list. |
| Dots (toggle) | Individual GPS fixes, colored the same way, with a tooltip of what was seen. |
| Building outlines | OpenStreetMap footprints, outlined in the tier color of the median signal from all fixes inside or within 30 m of the footprint. Hollow gray = no nearby fixes yet. The side panel ranks surveyed buildings weakest-first. |

Filters: network, band (2.4 / 5 GHz), date range, device, minimum fixes per cell. The side
panel shows coverage statistics for the current filters and a list of the weakest surveyed
cells (click to zoom).

## Running locally

```bash
python3 scripts/build.py          # regenerate data/processed/ from data/raw/
python3 -m http.server 8000       # then open http://localhost:8000
```

`fetch()` needs a web server; opening `index.html` straight from disk will not load the data.

## One-time GitHub setup

1. **Settings → Pages →** Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
2. **Settings → Actions → General → Workflow permissions →** *Read and write permissions*
   (so the Action can commit the regenerated files).
3. Push. The first Action run populates `data/processed/`; Pages goes live a minute later.

## Building footprints

`data/buildings.geojson` comes from OpenStreetMap via the Overpass API and is committed so the
site never depends on Overpass at build time. The Action fetches it automatically the first time
it is missing; to refresh it (new buildings, bigger study area) run the workflow manually with
**Re-download building footprints** ticked, or locally:

```bash
python3 scripts/fetch_buildings.py && python3 scripts/build.py
```

Buildings are matched to fixes by distance (`PERIMETER_M` in `scripts/build.py`, 30 m), so a
building's score is really "the sidewalk around it". OSM names many VCU buildings but not all;
unnamed ones show as *(unnamed university)* — editing the name in OpenStreetMap fixes it for everyone.

## Changing the study area or thresholds

- Study area: `data/campus_bbox.json`. By default `"auto": true` fits the box to all the data
  (plus `pad_m`), so nothing is ever cut off. Set `"auto": false` to use the fixed corners
  instead — useful to drop a commute and keep the map and the gray "unsurveyed" layer on campus.
  The current corners cover Monroe Park + MCV.
- Campus SSID list, grid size, RSSI tiers: edit the constants at the top of
  `scripts/build.py`. The map reads them from `summary.json`, so nothing else needs changing.

## Roadmap ideas

- Per-building *indoor* readings (a different collection method is needed).
- Time-of-day view once there are enough repeated surveys.
- Denser sampling (per-scan RSSI logging) so red cells become true dead spots rather than candidates.
