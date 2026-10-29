#!/usr/bin/env python3
"""Build the North America territory geometry for the Theatre board.

Source: Natural Earth 10m admin-1 states/provinces (public domain),
filtered to United States (50 states + DC) and Canada (10 provinces +
3 territories), simplified with Douglas-Peucker, coordinate-rounded,
and emitted as a compact GeoJSON bundle with label anchors.

Also emits a Great Lakes + major NA lakes layer so the board's water
reads as water against territory fill.

Outputs:
  public/geo/us-ca-territories.json  — 64 territory features
  public/geo/na-lakes.json           — major lakes overlay
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import transform as shp_transform

ROOT = Path("/home/z/my-project")
SRC = ROOT / "scripts/tmp/ne_10m_admin1.geojson"
LAKES_SRC = ROOT / "scripts/tmp/ne_10m_lakes.geojson"
OUT_DIR = ROOT / "public/geo"

ROUND_DP = 3          # ~111 m precision
MIN_PART_AREA = 0.0005  # deg^2 — keep PEI, drop rocks

def adaptive_tol(area_deg2: float) -> float:
    """Area-adaptive Douglas-Peucker tolerance (degrees).

    Small eastern states keep near-full detail (they zoom deep and are
    dense with boundary); the arctic giants get coarser treatment where
    board-scale rendering never notices.
    """
    if area_deg2 < 3:
        return 0.002   # ~220 m — RI, DE, CT, NJ, DC, PEI ...
    if area_deg2 < 30:
        return 0.006   # ~650 m — most eastern/southern states, NB, NS
    if area_deg2 < 150:
        return 0.012   # ~1.3 km — TX, CA, MT ...
    return 0.025       # ~2.8 km — AK, NU, NWT, QC, YT, BC, MB, SK, AB, ON


def adaptive_round_dp(area_deg2: float) -> int:
    """Coordinate text precision: 3 dp normally, 2 dp for the giants."""
    return 2 if area_deg2 >= 150 else 3


def adaptive_min_part(area_deg2: float) -> float:
    """Island floor: keep PEI everywhere; drop sub-pixel arctic rocks."""
    return 0.003 if area_deg2 >= 150 else 0.0005

US_POSTALS = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
    "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
    "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
    "TX","UT","VT","VA","WA","WV","WI","WY","DC",
}

# Major NA lakes worth drawing (name -> keep). NE names as-is.
KEEP_LAKES = {
    "Lake Superior", "Lake Michigan", "Lake Huron", "Lake Erie", "Lake Ontario",
    "Great Bear Lake", "Great Slave Lake", "Lake Winnipeg", "Lake Athabasca",
    "Reindeer Lake", "Lake Nipigon", "Lake of the Woods", "Lake Manitoba",
    "Lake Nipissing", "Lake Simcoe", "Lake Champlain", "Great Salt Lake",
    "Lake Okeechobee",
}


def round_geom(g, dp: int):
    def _r(x, y, z=None):
        return (round(x, dp), round(y, dp))
    return shp_transform(_r, g)


def clean_multipolygon(geom, min_area=MIN_PART_AREA):
    """Drop sliver parts below the area floor; never return empty."""
    if geom.is_empty:
        return geom
    if geom.geom_type == "Polygon":
        return geom if geom.area >= min_area else geom
    parts = [p for p in geom.geoms if p.area >= min_area]
    if not parts:
        parts = [max(geom.geoms, key=lambda p: p.area)]
    from shapely.geometry import MultiPolygon
    return MultiPolygon(parts) if len(parts) > 1 else parts[0]


def vertex_count(geom) -> int:
    if geom.is_empty:
        return 0
    n = 0
    if geom.geom_type == "Polygon":
        n += len(geom.exterior.coords) + sum(len(r.coords) for r in geom.interiors)
    elif geom.geom_type == "MultiPolygon":
        for p in geom.geoms:
            n += len(p.exterior.coords) + sum(len(r.coords) for r in p.interiors)
    elif geom.geom_type == "LineString":
        n += len(geom.coords)
    elif geom.geom_type == "MultiLineString":
        for l in geom.geoms:
            n += len(l.coords)
    return n


def largest_part(geom):
    if geom.geom_type == "MultiPolygon":
        return max(geom.geoms, key=lambda p: p.area)
    return geom


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(SRC) as f:
        src = json.load(f)

    features = []
    total_v_before = total_v_after = 0
    ak_west = 0.0  # Alaska bbox check for antimeridian handling

    for f in src["features"]:
        p = f["properties"]
        admin, postal, name = p.get("admin"), p.get("postal"), p.get("name")
        if admin == "United States of America" and postal in US_POSTALS:
            country, code = "US", f"US-{postal}"
            ttype = "District" if postal == "DC" else "State"
        elif admin == "Canada":
            country, code = "CA", f"CA-{postal}"
            ttype = "Territory" if postal in {"YT", "NT", "NU"} else "Province"
        else:
            continue

        geom = shape(f["geometry"])
        total_v_before += vertex_count(geom)
        if postal == "AK":
            ak_west, _, _, ak_east = geom.bounds

        tol = adaptive_tol(geom.area)
        dp = adaptive_round_dp(geom.area)
        simp = round_geom(clean_multipolygon(geom.simplify(tol, preserve_topology=True), adaptive_min_part(geom.area)), dp)
        total_v_after += vertex_count(simp)
        anchor = largest_part(simp).representative_point()

        features.append({
            "type": "Feature",
            "properties": {
                "code": code,
                "name": name,
                "country": country,
                "postal": postal,
                "type": ttype,
                "labelPos": [round(anchor.x, 3), round(anchor.y, 3)],
            },
            "geometry": mapping(simp),
        })

    us_n = sum(1 for x in features if x["properties"]["country"] == "US")
    ca_n = sum(1 for x in features if x["properties"]["country"] == "CA")
    assert us_n == 51, f"expected 51 US features, got {us_n}"
    assert ca_n == 13, f"expected 13 CA features, got {ca_n}"

    territories = {
        "type": "FeatureCollection",
        "meta": {
            "source": "Natural Earth 10m admin-1 states/provinces (public domain)",
            "scope": "United States (50 states + DC) and Canada (10 provinces + 3 territories)",
            "simplify": "adaptive DP 0.002-0.018 deg by area",
            "generated": "2026-10-30",
        },
        "features": features,
    }
    out_t = OUT_DIR / "us-ca-territories.json"
    with open(out_t, "w") as f:
        json.dump(territories, f, separators=(",", ":"))

    # ---- lakes layer ----
    lakes = []
    if LAKES_SRC.exists():
        with open(LAKES_SRC) as f:
            lsrc = json.load(f)
        for f in lsrc["features"]:
            name = f["properties"].get("name", "")
            if name not in KEEP_LAKES:
                continue
            geom = shape(f["geometry"])
            simp = round_geom(geom.simplify(0.02, preserve_topology=True), 3)
            lakes.append({
                "type": "Feature",
                "properties": {"name": name},
                "geometry": mapping(simp),
            })
    out_l = OUT_DIR / "na-lakes.json"
    with open(out_l, "w") as f:
        json.dump({"type": "FeatureCollection", "features": lakes}, f, separators=(",", ":"))

    print(f"territories: {len(features)} ({us_n} US + {ca_n} CA)")
    print(f"lakes kept : {len(lakes)} — {[l['properties']['name'] for l in lakes]}")
    print(f"vertices   : {total_v_before:,} -> {total_v_after:,} "
          f"({100 * total_v_after / max(1, total_v_before):.1f}%)")
    print(f"alaska lng span: {ak_west:.2f} .. {ak_east:.2f}")
    print(f"out: {out_t} {out_t.stat().st_size/1024:.0f} KB | {out_l} {out_l.stat().st_size/1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
