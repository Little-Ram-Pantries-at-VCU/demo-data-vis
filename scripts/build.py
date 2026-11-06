#!/usr/bin/env python3
"""
build.py — turn raw WiGLE CSV exports into the GeoJSON the map reads.

    data/raw/*.csv  ->  data/processed/fixes.geojson
                        data/processed/grid.geojson
                        data/processed/summary.json

Standard library only (no pip installs) so it runs anywhere, including the
GitHub Action.  Run from anywhere:

    python3 scripts/build.py

What it does
------------
1. Reads every CSV in data/raw/ (WiGLE's native export schema, see data/README.md).
   The file name supplies metadata:  YYYY-MM-DD_<area>_<device>.csv
2. Drops exact-duplicate observations (the same AP at the same place and time can
   appear in several exports when the team re-exports an overlapping period).
3. Keeps only observations inside data/campus_bbox.json.
4. Groups observations into GPS *fixes* (same lat, lon and timestamp) and records,
   for each fix, the strongest RSSI seen for each campus SSID on each band.
5. Snaps fixes to a square grid (CELL_SIZE_M metres) and summarises each cell.
"""

from __future__ import annotations

import csv
import glob
import json
import math
import os
import re
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone

# --------------------------------------------------------------------------- #
# Configuration — edit here, the map reads these values from summary.json
# --------------------------------------------------------------------------- #

# Campus networks.  Key = short label used in the UI, value = exact SSID string.
CAMPUS_SSIDS = {
    "SafeNet": "VCU SafeNet Wireless",
    "eduroam": "eduroam",
    "Guest": "VCU Guest Wireless",
}

# Grid cell edge length, metres.  GPS accuracy in the data is ~7-9 m, so going
# much below 25 m produces a false sense of precision.
CELL_SIZE_M = 25

# RSSI (dBm) tiers.  A cell's median best-RSSI falls into the first tier whose
# "min" it meets or exceeds.  "none" is used when the cell was surveyed but no
# campus SSID was ever observed there.
TIERS = [
    {"id": "excellent", "label": "Excellent (≥ −65 dBm)", "min": -65},
    {"id": "good",      "label": "Good (−65 to −75)",     "min": -75},
    {"id": "fair",      "label": "Fair (−75 to −85)",     "min": -85},
    {"id": "poor",      "label": "Poor (< −85)",          "min": -999},
]

# Rows with a FirstSeen date before this are GPS/clock glitches (1970-01-01).
# They are kept (the location is still valid) but their date is set to null.
MIN_VALID_YEAR = 2000

# --------------------------------------------------------------------------- #

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data", "raw")
OUT_DIR = os.path.join(ROOT, "data", "processed")
BBOX_PATH = os.path.join(ROOT, "data", "campus_bbox.json")

REQUIRED_COLS = {"MAC", "SSID", "FirstSeen", "Frequency", "RSSI",
                 "CurrentLatitude", "CurrentLongitude"}

FILENAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})_([^_]+)_(.+)\.csv$", re.IGNORECASE)


def parse_filename(path: str) -> tuple[str | None, str, str]:
    """YYYY-MM-DD_area_device.csv -> (export_date, area, device)."""
    name = os.path.basename(path)
    m = FILENAME_RE.match(name)
    if not m:
        print(f"  ! {name}: does not match YYYY-MM-DD_area_device.csv — "
              f"area/device recorded as 'unknown'", file=sys.stderr)
        return None, "unknown", "unknown"
    return m.group(1), m.group(2), m.group(3)


def band_of(freq_mhz: int) -> str:
    if freq_mhz < 3000:
        return "2.4"
    if freq_mhz < 5925:
        return "5"
    return "6"


def load_bbox() -> dict:
    with open(BBOX_PATH) as f:
        b = json.load(f)
    for k in ("min_lat", "max_lat", "min_lon", "max_lon"):
        if k not in b:
            sys.exit(f"campus_bbox.json is missing '{k}'")
    return b


def read_raw(bbox: dict):
    """Yield cleaned observation dicts from every raw CSV."""
    files = sorted(glob.glob(os.path.join(RAW_DIR, "*.csv")))
    if not files:
        sys.exit("No CSV files found in data/raw/")
    seen = set()
    stats = {"files": [], "rows_read": 0, "duplicates": 0,
             "outside_bbox": 0, "bad_rows": 0, "kept": 0}
    for path in files:
        export_date, area, device = parse_filename(path)
        n_file = 0
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            # WiGLE sometimes writes a one-line "WigleWifi-1.4,..." preamble.
            first = f.readline()
            if not first.startswith("MAC"):
                header_line = f.readline()
            else:
                header_line = first
            cols = [c.strip() for c in header_line.strip().split(",")]
            missing = REQUIRED_COLS - set(cols)
            if missing:
                print(f"  ! {os.path.basename(path)}: missing columns {sorted(missing)}, skipped",
                      file=sys.stderr)
                continue
            reader = csv.DictReader(f, fieldnames=cols)
            for r in reader:
                stats["rows_read"] += 1
                try:
                    lat = float(r["CurrentLatitude"])
                    lon = float(r["CurrentLongitude"])
                    rssi = int(float(r["RSSI"]))
                    freq = int(float(r["Frequency"]))
                except (TypeError, ValueError):
                    stats["bad_rows"] += 1
                    continue
                if (r.get("Type") or "WIFI").upper() != "WIFI":
                    stats["bad_rows"] += 1  # BT / cell rows if someone exports them
                    continue
                key = (r["MAC"].lower(), r["FirstSeen"], round(lat, 6), round(lon, 6), rssi)
                if key in seen:
                    stats["duplicates"] += 1
                    continue
                seen.add(key)
                if not (bbox["min_lat"] <= lat <= bbox["max_lat"]
                        and bbox["min_lon"] <= lon <= bbox["max_lon"]):
                    stats["outside_bbox"] += 1
                    continue
                ts = r["FirstSeen"].strip()
                date = ts[:10]
                try:
                    if int(date[:4]) < MIN_VALID_YEAR:
                        date = None
                except ValueError:
                    date = None
                stats["kept"] += 1
                n_file += 1
                yield {
                    "mac": r["MAC"].lower(),
                    "ssid": r["SSID"],
                    "ts": ts,
                    "date": date,
                    "lat": lat,
                    "lon": lon,
                    "rssi": rssi,
                    "band": band_of(freq),
                    "acc": _float_or_none(r.get("AccuracyMeters")),
                    "area": area,
                    "device": device,
                }
        stats["files"].append({"file": os.path.basename(path), "export_date": export_date,
                               "area": area, "device": device, "rows_kept": n_file})
    read_raw.stats = stats  # type: ignore[attr-defined]


def _float_or_none(v):
    try:
        return round(float(v), 1)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Fixes
# --------------------------------------------------------------------------- #

def build_fixes(observations):
    """Group observations by (lat, lon, timestamp)."""
    ssid_to_label = {v: k for k, v in CAMPUS_SSIDS.items()}
    fixes: dict[tuple, dict] = {}
    for o in observations:
        key = (round(o["lat"], 6), round(o["lon"], 6), o["ts"])
        fx = fixes.get(key)
        if fx is None:
            fx = fixes[key] = {
                "lat": key[0], "lon": key[1], "ts": o["ts"], "date": o["date"],
                "time": o["ts"][11:19] if len(o["ts"]) >= 19 else None,
                "acc": o["acc"], "area": o["area"], "device": o["device"],
                "n_aps": 0, "n_campus_aps": 0,
                # sig[label] = {"2.4": best, "5": best, "6": best}
                "sig": {},
                "best": None, "best_ssid": None, "best_band": None,
            }
        fx["n_aps"] += 1
        label = ssid_to_label.get(o["ssid"])
        if label is None:
            continue
        fx["n_campus_aps"] += 1
        bands = fx["sig"].setdefault(label, {})
        if o["rssi"] > bands.get(o["band"], -999):
            bands[o["band"]] = o["rssi"]
        if fx["best"] is None or o["rssi"] > fx["best"]:
            fx["best"], fx["best_ssid"], fx["best_band"] = o["rssi"], label, o["band"]
    return list(fixes.values())


# --------------------------------------------------------------------------- #
# Grid
# --------------------------------------------------------------------------- #

def grid_meta(bbox: dict) -> dict:
    """Square cells of CELL_SIZE_M metres, anchored at the bbox SW corner."""
    mid_lat = (bbox["min_lat"] + bbox["max_lat"]) / 2
    dlat = CELL_SIZE_M / 111_320.0
    dlon = CELL_SIZE_M / (111_320.0 * math.cos(math.radians(mid_lat)))
    nx = math.ceil((bbox["max_lon"] - bbox["min_lon"]) / dlon)
    ny = math.ceil((bbox["max_lat"] - bbox["min_lat"]) / dlat)
    return {"cell_size_m": CELL_SIZE_M, "origin_lat": bbox["min_lat"],
            "origin_lon": bbox["min_lon"], "dlat": dlat, "dlon": dlon, "nx": nx, "ny": ny}


def cell_of(fx: dict, g: dict) -> tuple[int, int]:
    ix = int((fx["lon"] - g["origin_lon"]) // g["dlon"])
    iy = int((fx["lat"] - g["origin_lat"]) // g["dlat"])
    return ix, iy


def tier_for(median_rssi):
    if median_rssi is None:
        return "none"
    for t in TIERS:
        if median_rssi >= t["min"]:
            return t["id"]
    return TIERS[-1]["id"]


def build_grid(fixes, g: dict):
    cells: dict[tuple, list] = defaultdict(list)
    for fx in fixes:
        fx["cell"] = cell_of(fx, g)
        cells[fx["cell"]].append(fx)

    features = []
    for (ix, iy), fxs in sorted(cells.items()):
        bests = [f["best"] for f in fxs if f["best"] is not None]
        med = statistics.median(bests) if bests else None
        per_ssid = {}
        for label in CAMPUS_SSIDS:
            vals = [max(f["sig"][label].values()) for f in fxs if label in f["sig"]]
            if vals:
                per_ssid[label] = {"median": statistics.median(vals), "n": len(vals)}
        per_band = {}
        for band in ("2.4", "5", "6"):
            vals = [max(v[band] for v in f["sig"].values() if band in v)
                    for f in fxs if any(band in v for v in f["sig"].values())]
            if vals:
                per_band[band] = {"median": statistics.median(vals), "n": len(vals)}
        dates = sorted({f["date"] for f in fxs if f["date"]})
        w, s = g["origin_lon"] + ix * g["dlon"], g["origin_lat"] + iy * g["dlat"]
        e, n = w + g["dlon"], s + g["dlat"]
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon",
                         "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]},
            "properties": {
                "ix": ix, "iy": iy,
                "n_fixes": len(fxs),
                "n_with_campus": len(bests),
                "median_best": med,
                "max_best": max(bests) if bests else None,
                "tier": tier_for(med),
                "per_ssid": per_ssid,
                "per_band": per_band,
                "dates": dates,
                "devices": sorted({f["device"] for f in fxs}),
            },
        })
    return features


# --------------------------------------------------------------------------- #

def main():
    bbox = load_bbox()
    print(f"Reading {RAW_DIR}")
    observations = list(read_raw(bbox))
    stats = read_raw.stats  # type: ignore[attr-defined]
    for fi in stats["files"]:
        print(f"  {fi['file']}: {fi['rows_kept']} rows kept  (area={fi['area']}, device={fi['device']})")
    print(f"  rows read {stats['rows_read']}, duplicates {stats['duplicates']}, "
          f"outside bbox {stats['outside_bbox']}, bad {stats['bad_rows']}, kept {stats['kept']}")

    fixes = build_fixes(observations)
    g = grid_meta(bbox)
    grid = build_grid(fixes, g)

    os.makedirs(OUT_DIR, exist_ok=True)

    fix_features = []
    for fx in fixes:
        props = {k: v for k, v in fx.items() if k not in ("lat", "lon", "ts")}
        fix_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [fx["lon"], fx["lat"]]},
            "properties": props,
        })
    with open(os.path.join(OUT_DIR, "fixes.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": fix_features}, f, separators=(",", ":"))
    with open(os.path.join(OUT_DIR, "grid.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": grid}, f, separators=(",", ":"))

    tier_counts = defaultdict(int)
    for c in grid:
        tier_counts[c["properties"]["tier"]] += 1
    dates = sorted({fx["date"] for fx in fixes if fx["date"]})
    summary = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bbox": {k: bbox[k] for k in ("min_lat", "max_lat", "min_lon", "max_lon")},
        "bbox_name": bbox.get("name"),
        "grid": g,
        "campus_ssids": CAMPUS_SSIDS,
        "tiers": TIERS,
        "input": stats,
        "n_fixes": len(fixes),
        "n_fixes_with_campus": sum(1 for fx in fixes if fx["best"] is not None),
        "n_cells_surveyed": len(grid),
        "n_cells_total": g["nx"] * g["ny"],
        "cells_by_tier": dict(tier_counts),
        "date_range": [dates[0], dates[-1]] if dates else None,
        "dates": dates,
        "devices": sorted({fx["device"] for fx in fixes}),
        "areas": sorted({fx["area"] for fx in fixes}),
    }
    with open(os.path.join(OUT_DIR, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    print(f"Wrote {len(fix_features)} fixes, {len(grid)} grid cells "
          f"({g['nx']}x{g['ny']} grid, {CELL_SIZE_M} m) -> {OUT_DIR}")
    print("Cells by tier:", dict(tier_counts))


if __name__ == "__main__":
    main()
