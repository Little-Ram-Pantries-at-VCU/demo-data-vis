#!/usr/bin/env python3
"""
fetch_buildings.py — download building footprints inside data/campus_bbox.json
from OpenStreetMap (via the Overpass API) and save them as

    data/buildings.geojson

Run it once, commit the result, and re-run only when the study area changes or
you want fresher OSM data.  Standard library only.

    python3 scripts/fetch_buildings.py

OpenStreetMap data is © OpenStreetMap contributors, ODbL — the attribution
already shown on the map covers it.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BBOX_PATH = os.path.join(ROOT, "data", "campus_bbox.json")
OUT_PATH = os.path.join(ROOT, "data", "buildings.geojson")

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# OSM tags copied onto each feature (if present).
KEEP_TAGS = ["name", "building", "operator", "addr:housenumber", "addr:street", "wikidata"]


def query_overpass(bbox: dict) -> dict:
    s, w, n, e = bbox["min_lat"], bbox["min_lon"], bbox["max_lat"], bbox["max_lon"]
    q = f"""
[out:json][timeout:90];
(
  way["building"]({s},{w},{n},{e});
  relation["building"]["type"="multipolygon"]({s},{w},{n},{e});
);
out body;
>;
out skel qt;
"""
    data = urllib.parse.urlencode({"data": q}).encode()
    last_err = None
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "vcu-wifi-coverage-map/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            print(f"  ! {url}: {exc}", file=sys.stderr)
    sys.exit(f"Could not reach Overpass: {last_err}")


def ring_coords(way_ids, ways, nodes):
    """Join way segments into closed rings (needed for multipolygon relations)."""
    segs = [[nodes[n] for n in ways[w]] for w in way_ids if w in ways]
    rings = []
    while segs:
        ring = segs.pop(0)
        while ring[0] != ring[-1] and segs:
            for i, seg in enumerate(segs):
                if seg[0] == ring[-1]:
                    ring += seg[1:]; segs.pop(i); break
                if seg[-1] == ring[-1]:
                    ring += seg[-2::-1]; segs.pop(i); break
            else:
                break  # unclosed — give up on this ring
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def to_geojson(osm: dict) -> dict:
    nodes = {el["id"]: [el["lon"], el["lat"]] for el in osm["elements"] if el["type"] == "node"}
    ways = {el["id"]: el["nodes"] for el in osm["elements"] if el["type"] == "way"}
    used_in_relation = set()
    features = []

    for el in osm["elements"]:
        if el["type"] != "relation":
            continue
        outer = [m["ref"] for m in el.get("members", []) if m["type"] == "way" and m.get("role") in ("outer", "")]
        inner = [m["ref"] for m in el.get("members", []) if m["type"] == "way" and m.get("role") == "inner"]
        used_in_relation.update(outer); used_in_relation.update(inner)
        outers = ring_coords(outer, ways, nodes)
        inners = ring_coords(inner, ways, nodes)
        if not outers:
            continue
        polys = [[ring] + inners for ring in outers]  # inner rings attached to every outer (good enough)
        geom = {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": polys}
        features.append(_feature(f"r{el['id']}", geom, el.get("tags", {})))

    for wid, node_ids in ways.items():
        if wid in used_in_relation:
            continue
        tags = next((el.get("tags", {}) for el in osm["elements"] if el["type"] == "way" and el["id"] == wid), {})
        if "building" not in tags:
            continue
        coords = [nodes[n] for n in node_ids if n in nodes]
        if len(coords) < 4 or coords[0] != coords[-1]:
            continue
        features.append(_feature(f"w{wid}", {"type": "Polygon", "coordinates": [coords]}, tags))

    return {"type": "FeatureCollection",
            "attribution": "© OpenStreetMap contributors, ODbL",
            "features": features}


def _feature(fid, geom, tags):
    props = {"id": fid}
    for k in KEEP_TAGS:
        if k in tags:
            props[k.replace("addr:", "")] = tags[k]
    return {"type": "Feature", "id": fid, "geometry": geom, "properties": props}


def main():
    with open(BBOX_PATH) as f:
        bbox = json.load(f)
    print("Querying Overpass for buildings in", bbox.get("name", "bbox"))
    osm = query_overpass(bbox)
    gj = to_geojson(osm)
    named = sum(1 for f in gj["features"] if f["properties"].get("name"))
    with open(OUT_PATH, "w") as f:
        json.dump(gj, f, separators=(",", ":"))
    print(f"Wrote {len(gj['features'])} buildings ({named} named) -> {OUT_PATH}")


if __name__ == "__main__":
    main()
