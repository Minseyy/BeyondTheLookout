"""
prepare_data.py - builds the extra files in data/ that the charts read.

Some charts need work that Vega-Lite can't do on its own (fixing map shapes,
finding which region a lookout is in, rounding a waffle to exactly 100
squares, cutting map layers to a frame). This script does that work once and
saves the results, so every chart can be a plain .vg.json file.

Files it makes (each goes in the folder set in data_layout.py; everything else is an original):
    nsw_fixed.json, branches_fixed.json   map shapes, fixed (regions simplified for statewide maps)
    parks_map.json              park outlines, simplified for the statewide top-20 map
    region_share_maps.json      share maps (one shape per region per year)
    lookouts_by_region.json     each lookout + the region it is in
    region_lookouts.json        visits, lookouts and visits per lookout by region
    track_waffle.json           the 100 waffle squares
    park_track_difficulty.json  km of track by difficulty for each top-20 park
    park_map_shapes.json, park_map_lookouts.json, park_list.json   park map
    park_info.json              one row per top-20 park (rank bars, info panel)
    park_circles.json           the coral circles: on the NSW map and in the Sydney lens
    sydney_lens.json, sydney_lens_label.json   the magnified Sydney "lens"
    page_numbers.json           numbers for the page text

Run it again whenever one of the original data files changes:
    python prepare_data.py

Needs only Python 3 (no extra packages); data_layout.py must sit next to this file.
"""

import csv
import json
import math
import os

import data_layout

DATA = "data"
OUT = DATA  # each file is saved in the folder set in data_layout.py

# Track difficulty groups (NPWS track classes)
DIFFICULTY = [
    {"classes": [1, 2], "label": "Easy (Class 1–2)"},
    {"classes": [3, 4], "label": "Moderate (Class 3–4)"},
    {"classes": [5, 6], "label": "Hard (Class 5–6)"},
]

# Some top-20 names cover several NPWS reserves
PARK_ALIASES = {"Worimi Conservation Lands": ["Worimi NP", "Worimi RP", "Worimi SCA"]}

# The park map's drawing area in pixels (used to give each park's frame the
# same shape as the map, so land fills the whole view)
PARK_MAP_WIDTH = 568
PARK_MAP_HEIGHT = 468

# The Sydney "lens" in the top-20 chart: a magnified circle drawn out in the Tasman Sea.
# Map units are degrees on the Mercator map (x = longitude, y = Mercator latitude).
LENS_SPOT = (150.85, -33.87)   # centre of the area that is magnified (lon, lat)
LENS_SPOT_RADIUS = 0.85        # size of that area
LENS_CENTRE = (158.3, -33.0)   # where the lens is drawn (lon, lat), out to sea
LENS_RADIUS = 4.5              # size of the lens; magnification = LENS_RADIUS / LENS_SPOT_RADIUS

ZOOM_LABELS = {1: (0.0, -0.09), 2: (0.03, -0.06), 3: (0.05, 0.03), 4: (-0.07, 0.0), 6: (0.05, 0.0),
               7: (0.05, 0.03), 9: (0.05, 0.0), 12: (0.05, -0.02), 13: (0.05, 0.0), 15: (-0.06, 0.03),
               17: (-0.04, -0.05), 20: (-0.04, -0.04)}


# ---------------------------------------------------------------- helpers
def read_csv(name):
    with open(data_layout.in_path(name), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def read_features(name):
    with open(data_layout.in_path(name), encoding="utf-8") as f:
        return json.load(f).get("features", [])


def round_coordinates(value, places=4):
    """Rounds every map coordinate to 4 decimal places (about 10 m), which keeps files small."""
    if isinstance(value, dict):
        return {k: (round_coordinates(v, places) if k != "coordinates" else _round(v, places))
                for k, v in value.items()}
    if isinstance(value, list):
        return [round_coordinates(v, places) for v in value]
    return value


def _round(c, places):
    return [_round(x, places) for x in c] if isinstance(c, list) else round(c, places)


def write_json(name, value):
    path = data_layout.out_path(name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(round_coordinates(value), f, ensure_ascii=False, separators=(",", ":"))
    print("wrote", path)


def num(text):
    """Like JavaScript's +text: '' -> 0, bad text -> nan."""
    try:
        return float(text) if text.strip() else 0.0
    except ValueError:
        return math.nan


def js_round(x):
    """JavaScript Math.round (halves round up, not to even)."""
    return math.floor(x + 0.5)


def percent(x):
    return f"{js_round(x * 100)}%"


def commas(n):
    return f"{js_round(n):,}"


def millions(n):
    return f"{n / 1e6:.1f}"


# ---------------------------------------------------------------- map-shape fixing
# Vega-Lite needs polygon outlines drawn clockwise. Files from mapshaper,
# ArcGIS or geojson.io are usually anti-clockwise, which makes a shape fill
# the whole world. Tiny slivers (< ~1 hectare) cause the same problem.
MIN_AREA = 1e-6  # square degrees


def ring_area(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return a / 2  # negative = clockwise


def clean_polygon(rings):
    outer = rings[0] if rings else None
    if not outer or len(outer) < 4 or abs(ring_area(outer)) < MIN_AREA:
        return None
    outer_area = abs(ring_area(outer))
    holes = [h for h in rings[1:]
             if len(h) >= 4 and MIN_AREA <= abs(ring_area(h)) < outer_area]
    fixed = []
    for i, ring in enumerate([outer] + holes):
        want_clockwise = i == 0  # outer clockwise, holes anti-clockwise
        fixed.append(ring if (ring_area(ring) < 0) == want_clockwise else ring[::-1])
    return fixed


def rewind(feature):
    g = feature.get("geometry")
    if g and g["type"] in ("Polygon", "MultiPolygon"):
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        parts = [p for p in (clean_polygon(poly) for poly in polys) if p]
        feature["geometry"] = {"type": "MultiPolygon", "coordinates": parts} if parts else None
    return feature


def fixed_features(name):
    return [f for f in (rewind(f) for f in read_features(name)) if f["geometry"]]


def map_rings(polygons, fn):
    out = []
    for poly in polygons:
        rings = [fn(r) for r in poly]
        if rings[0]:
            out.append([rings[0]] + [r for r in rings[1:] if r])
    return out


def thin(feature, tol):
    """Drops outline points closer than tol degrees (small maps don't need the detail)."""
    def thin_ring(ring):
        out = [ring[0]]
        for p in ring[1:-1]:
            if abs(p[0] - out[-1][0]) > tol or abs(p[1] - out[-1][1]) > tol:
                out.append(p)
        out.append(ring[-1])
        return out if len(out) >= 4 else None
    coords = map_rings(feature["geometry"]["coordinates"], thin_ring)
    return {"type": "Feature", "properties": feature["properties"],
            "geometry": {"type": "MultiPolygon", "coordinates": coords}}


def clip_ring(ring, box):
    """Cuts a ring to a box (Sutherland-Hodgman)."""
    w, e, s, n = box["west"], box["east"], box["south"], box["north"]
    edges = [
        (lambda p: p[0] >= w, lambda a, b: [w, a[1] + (b[1] - a[1]) * (w - a[0]) / (b[0] - a[0])]),
        (lambda p: p[0] <= e, lambda a, b: [e, a[1] + (b[1] - a[1]) * (e - a[0]) / (b[0] - a[0])]),
        (lambda p: p[1] >= s, lambda a, b: [a[0] + (b[0] - a[0]) * (s - a[1]) / (b[1] - a[1]), s]),
        (lambda p: p[1] <= n, lambda a, b: [a[0] + (b[0] - a[0]) * (n - a[1]) / (b[1] - a[1]), n]),
    ]
    pts = ring[:-1]
    for inside, cross in edges:
        if not pts:
            break
        out, prev = [], pts[-1]
        for cur in pts:
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
            prev = cur
        pts = out
    return pts + [pts[0]] if len(pts) >= 3 else None


def clip_feature(feature, box):
    g = feature["geometry"]
    if not g or g["type"] != "MultiPolygon":
        return feature
    parts = map_rings(g["coordinates"], lambda r: clip_ring(r, box))
    if not parts:
        return None
    return {**feature, "geometry": {"type": "MultiPolygon", "coordinates": parts}}


def in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


MERC_Y = lambda lat: math.log(math.tan(math.pi / 4 + lat * math.pi / 360))
LAT_FROM_Y = lambda y: (2 * math.atan(math.exp(y)) - math.pi / 2) * 180 / math.pi


def fit_box(box, width, height):
    """Widens a lon/lat box to the shape of a width x height map (Mercator), so land fills the view."""
    box = dict(box)
    box_w = (box["east"] - box["west"]) * math.pi / 180
    box_h = MERC_Y(box["north"]) - MERC_Y(box["south"])
    wanted = width / height
    if box_w / box_h < wanted:
        extra = (box_h * wanted - box_w) / 2 * 180 / math.pi
        box["west"] -= extra
        box["east"] += extra
    else:
        extra = (box_w / wanted - box_h) / 2
        box["north"] = LAT_FROM_Y(MERC_Y(box["north"]) + extra)
        box["south"] = LAT_FROM_Y(MERC_Y(box["south"]) - extra)
    return box


def frame_feature(box, props):
    """The box as a polygon (corners clockwise: SW, NW, NE, SE)."""
    w, e, s, n = box["west"], box["east"], box["south"], box["north"]
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "Polygon", "coordinates": [[[w, s], [w, n], [e, n], [e, s], [w, s]]]}}


def in_box(lon, lat, box):
    return box["west"] <= lon <= box["east"] and box["south"] <= lat <= box["north"]


# ---- the lens: magnify the area around LENS_SPOT and draw it at LENS_CENTRE
def to_map(lon, lat):
    return lon, math.degrees(MERC_Y(lat))


def from_map(x, y):
    return [x, LAT_FROM_Y(math.radians(y))]


SPOT = to_map(*LENS_SPOT)
LENS = to_map(*LENS_CENTRE)
ZOOM = LENS_RADIUS / LENS_SPOT_RADIUS


def magnify(lon, lat):
    """Where a real place is drawn inside the lens."""
    x, y = to_map(lon, lat)
    return from_map(LENS[0] + ZOOM * (x - SPOT[0]), LENS[1] + ZOOM * (y - SPOT[1]))


def in_spot(lon, lat):
    x, y = to_map(lon, lat)
    return math.hypot(x - SPOT[0], y - SPOT[1]) <= LENS_SPOT_RADIUS


def circle(centre, radius, n=96):
    """A clockwise circle of map points (clockwise = what Vega-Lite needs for an outer ring)."""
    pts = [(centre[0] + radius * math.cos(-2 * math.pi * i / n), centre[1] + radius * math.sin(-2 * math.pi * i / n))
           for i in range(n)]
    return pts + [pts[0]]


def clip_to_circle(ring_lonlat):
    """Cuts a ring to the spot circle (Sutherland-Hodgman against a convex polygon), then magnifies it."""
    clip = circle(SPOT, LENS_SPOT_RADIUS)[::-1][:-1]  # anticlockwise, so "inside" = left of each edge
    pts = [to_map(x, y) for x, y in ring_lonlat[:-1]]
    for i in range(len(clip)):
        if not pts:
            break
        a, b = clip[i], clip[(i + 1) % len(clip)]
        inside = lambda q: (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) >= 0
        def cross(q, r):
            x1, y1, x2, y2 = q[0], q[1], r[0], r[1]
            x3, y3, x4, y4 = a[0], a[1], b[0], b[1]
            d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
            t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d
            return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
        out, prev = [], pts[-1]
        for cur in pts:
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
            prev = cur
        pts = out
    if len(pts) < 3:
        return None
    pts = pts + [pts[0]]
    return [from_map(LENS[0] + ZOOM * (x - SPOT[0]), LENS[1] + ZOOM * (y - SPOT[1])) for x, y in pts]


def ring_feature(points, layer):
    return {"type": "Feature", "properties": {"layer": layer},
            "geometry": {"type": "Polygon", "coordinates": [[from_map(x, y) for x, y in points]]}}


def line_feature(a, b, layer, n=20):
    pts = [from_map(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]
    return {"type": "Feature", "properties": {"layer": layer},
            "geometry": {"type": "LineString", "coordinates": pts}}


def in_feature(x, y, feature):
    return any(in_ring(x, y, poly[0]) and not any(in_ring(x, y, h) for h in poly[1:])
               for poly in feature["geometry"]["coordinates"])


# ---------------------------------------------------------------- build everything
def main():
    os.makedirs(OUT, exist_ok=True)

    # 1. Fixed copies of the map files the charts load directly
    #    (saved as *_fixed.json so the original files are never overwritten)
    #    (parks.geojson is already drawn the right way, so it is used as it is)
    nsw = fixed_features("nsw.json")
    parks = fixed_features("parks.geojson")
    branches = fixed_features("branches.json")
    # the region and park outlines are drawn on statewide maps, where detail finer than
    # ~0.5-1 km is smaller than a pixel, so save lighter copies (the maths below still
    # uses the full-detail shapes)
    light = lambda feats, tol: [f for f in (rewind(thin(f, tol)) for f in feats) if f["geometry"]]
    write_json("nsw_fixed.json", {"type": "FeatureCollection", "features": nsw})
    write_json("branches_fixed.json", {"type": "FeatureCollection", "features": light(branches, 0.005)})
    write_json("parks_map.json", {"type": "FeatureCollection", "features": light(parks, 0.01)})

    # 2. Region share maps: one shape per region per survey year
    shares = read_csv("branch_share_by_year.csv")
    outline = {f["properties"]["NAME"]: thin(f, 0.03) for f in branches}
    totals = {}
    for r in shares:
        totals[r["year"]] = totals.get(r["year"], 0) + num(r["share_pct"])
    share_maps = []
    for year in totals:  # survey order
        for r in shares:
            if r["year"] == year and r["branch"] in outline:
                f = rewind({"type": "Feature", "properties": {},
                             "geometry": outline[r["branch"]]["geometry"]})
                share_maps.append({**f, "branch": r["branch"], "year": year,
                                   "share": num(r["share_pct"]),
                                   "yearTotal": js_round(totals[year] * 10) / 10})
    write_json("region_share_maps.json", share_maps)

    # 3. Lookouts with the region each one is in, and visits per lookout
    regions = [f for f in branches if f["properties"]["NAME"] != "ACT"]
    lookouts = read_csv("lookouts.csv")
    points = []
    for r in lookouts:
        if r["type"] == "Other":  # "Other" = camping platforms
            continue
        x, y = num(r["lon"]), num(r["lat"])
        home = next((f for f in regions if in_feature(x, y, f)), None)
        points.append({"name": r["name"], "type": r["type"], "park": r["park_full"],
                       "lon": x, "lat": y,
                       "branch": home["properties"]["NAME"] if home else "Outside the regions"})
    write_json("lookouts_by_region.json", points)

    visits = read_csv("branch_visits_2024_25.csv")
    per_region = []
    for v in visits:
        count = sum(1 for p in points if p["branch"] == v["branch"])
        per_region.append({"branch": v["branch"], "visits": num(v["visits"]), "lookouts": count,
                           "perLookout": num(v["visits"]) / count if count else None})
    write_json("region_lookouts.json", per_region)

    # 4. Waffle: 100 squares, coloured by difficulty
    classes = read_csv("tracks_by_class.csv")
    groups = []
    for d in DIFFICULTY:
        km = 0.0
        for r in classes:
            if num(r["class_num"]) in d["classes"]:
                km += num(r["total_km"])
        groups.append({**d, "km": km})
    total_km = sum(g["km"] for g in groups)
    for g in groups:
        g["exact"] = g["km"] / total_km * 100
        g["squares"] = math.floor(g["exact"])
    left = 100 - sum(g["squares"] for g in groups)
    for g in sorted(groups, key=lambda g: -(g["exact"] - g["squares"])):  # largest remainder first
        if left > 0:
            g["squares"] += 1
            left -= 1
    squares = []
    for g in groups:
        for _ in range(g["squares"]):
            n = len(squares)
            squares.append({"col": n % 10, "row": n // 10, "group": g["label"],
                            "difficulty": f"{g['label']}: {g['squares']}%", "km": js_round(g["km"])})
    write_json("track_waffle.json", squares)

    # 5. Track difficulty for each top-20 park
    tracks = read_csv("tracks.csv")
    park_points = read_csv("park_points.csv")
    top20 = read_csv("top20_parks_located.csv")
    short_name = {p["park"]: p["park_short"] for p in park_points}
    km = {}
    for t in tracks:
        c = num(t["class_num"])
        group = next((d for d in DIFFICULTY if c in d["classes"]), None)
        if not group:
            continue
        km.setdefault(t["park"], {})
        km[t["park"]][group["label"]] = km[t["park"]].get(group["label"], 0) + num(t["length_km"])
    top_parks = []
    for p in top20:
        shorts = PARK_ALIASES.get(p["park"]) or [short_name.get(p["park_full"])]
        by_group = {}
        for d in DIFFICULTY:
            total = 0
            for s in shorts:
                total += km.get(s, {}).get(d["label"], 0)
            by_group[d["label"]] = total
        total = 0
        for v in by_group.values():
            total += v
        if total > 0:
            top_parks.append({"park": p["park"], "rank": int(num(p["rank"])),
                              "byGroup": by_group, "total": total, "shorts": shorts})
    rows = []
    for p in top_parks:
        for i, d in enumerate(DIFFICULTY):
            rows.append({"park": p["park"], "rank": p["rank"], "difficulty": d["label"], "order": i,
                         "km": js_round(p["byGroup"][d["label"]] * 10) / 10,
                         "share": p["byGroup"][d["label"]] / p["total"],
                         "totalKm": js_round(p["total"])})
    write_json("park_track_difficulty.json", rows)

    # 6. Park map: for each top-20 park, everything inside its frame
    track_lines = read_features("tracks.geojson")
    map_features, map_lookouts, park_list = [], [], []
    lookout_count = {}
    merc_y = lambda lat: math.log(math.tan(math.pi / 4 + lat * math.pi / 360))
    lat_from_y = lambda y: (2 * math.atan(math.exp(y)) - math.pi / 2) * 180 / math.pi
    for p in top_parks:
        shorts, name = p["shorts"], p["park"]
        park_outline = [f for f in parks if f["properties"]["park_short"] in shorts]
        here = [r for r in lookouts if r["type"] != "Other" and r["park"] in shorts]

        # frame = the outline plus a 10% margin, widened to the map's shape
        pts = [pt for f in park_outline for poly in f["geometry"]["coordinates"] for pt in poly[0]]
        xs, ys = [q[0] for q in pts], [q[1] for q in pts]
        pad_x = (max(xs) - min(xs)) * 0.1 + 0.01
        pad_y = (max(ys) - min(ys)) * 0.1 + 0.01
        box = {"west": min(xs) - pad_x, "east": max(xs) + pad_x,
               "south": min(ys) - pad_y, "north": max(ys) + pad_y}
        box_w = (box["east"] - box["west"]) * math.pi / 180
        box_h = merc_y(box["north"]) - merc_y(box["south"])
        wanted = PARK_MAP_WIDTH / PARK_MAP_HEIGHT
        if box_w / box_h < wanted:
            extra = (box_h * wanted - box_w) / 2 * 180 / math.pi
            box["west"] -= extra
            box["east"] += extra
        else:
            extra = (box_w / wanted - box_h) / 2
            box["north"] = lat_from_y(merc_y(box["north"]) + extra)
            box["south"] = lat_from_y(merc_y(box["south"]) - extra)

        # outline points closer than ~1/1500 of the frame are under a pixel on the map: drop them
        tol = (box["east"] - box["west"]) / 1500

        def add(layer, feature, props=None):
            g = feature["geometry"]
            if g and g["type"] == "MultiPolygon" and layer != "frame":
                feature = rewind(thin(feature, tol))
                if not feature["geometry"]:
                    return
            elif g and g["type"] == "LineString" and len(g["coordinates"]) > 2:
                pts = [g["coordinates"][0]]
                for q in g["coordinates"][1:-1]:
                    if abs(q[0] - pts[-1][0]) > tol or abs(q[1] - pts[-1][1]) > tol:
                        pts.append(q)
                pts.append(g["coordinates"][-1])
                feature = {**feature, "geometry": {"type": "LineString", "coordinates": pts}}
            map_features.append({"type": "Feature", "geometry": feature["geometry"],
                                 "properties": {**(props or {}), "map_park": name, "layer": layer}})

        w, e, s, n = box["west"], box["east"], box["south"], box["north"]
        # frame corners clockwise: SW, NW, NE, SE
        add("frame", {"geometry": {"type": "Polygon",
                                   "coordinates": [[[w, s], [w, n], [e, n], [e, s], [w, s]]]}})
        for f in nsw:
            c = clip_feature(f, box)
            if c:
                add("land", c)
        for f in parks:
            if f in park_outline:
                continue
            c = clip_feature(f, box)
            if c:
                add("other_park", c)
        for f in park_outline:
            add("outline", f, {"park": f["properties"]["park"]})
        for f in track_lines:
            props = f["properties"]
            if props.get("park") in shorts and props.get("class_num") is not None:
                c = props["class_num"]
                diff = DIFFICULTY[0 if c <= 2 else 1 if c <= 4 else 2]["label"]
                add("track", f, {"name": props["name"], "class": props["class"],
                                 "length_km": props["length_km"], "difficulty": diff})
        for r in here:
            map_lookouts.append({"map_park": name, "name": r["name"], "type": r["type"],
                                 "lon": num(r["lon"]), "lat": num(r["lat"])})
        lookout_count[name] = len(here)
        park_list.append({"park": name, "rank": p["rank"],
                          "summary": f"{commas(p['total'])} km of track, {len(here)} lookout"
                                     + ("" if len(here) == 1 else "s")})

    write_json("park_map_shapes.json", {"type": "FeatureCollection", "features": map_features})
    write_json("park_map_lookouts.json", map_lookouts)
    write_json("park_list.json", sorted(park_list, key=lambda p: p["rank"]))

    # 6b. Top-20 chart: one row per park (rank bars, info panel), the coral circles,
    #     and the Sydney lens: land, parks and points around Sydney, magnified
    tracks_of = {tp["park"]: tp for tp in top_parks}
    park_info = []
    for r in top20:
        rank, lon, lat = int(num(r["rank"])), num(r["lon"]), num(r["lat"])
        tp = tracks_of.get(r["park"])
        share = lambda label: js_round(tp["byGroup"][label] / tp["total"] * 100) if tp else None
        dx, dy = ZOOM_LABELS.get(rank, (0.05, 0.0))
        zlon, zlat = magnify(lon, lat)
        zx, zy = to_map(zlon, zlat)
        label = from_map(zx + dx * ZOOM * 0.85, zy + dy * ZOOM * 0.85)
        park_info.append({
            "rank": rank, "park": r["park"], "park_full": r["park_full"], "branch": r["branch"],
            "lon": lon, "lat": lat, "visits": num(r["visits_2024_25"]),
            "in_zoom": in_spot(lon, lat), "zlon": zlon, "zlat": zlat,
            "label_lon": label[0], "label_lat": label[1],
            "label_side": "left" if dx < 0 else "middle" if dx == 0 else "right",
            "track_km": js_round(tp["total"]) if tp else None,
            "easy_pct": share(DIFFICULTY[0]["label"]),
            "moderate_pct": share(DIFFICULTY[1]["label"]),
            "hard_pct": share(DIFFICULTY[2]["label"]),
            "lookouts": lookout_count.get(r["park"], 0),
        })
    write_json("park_info.json", park_info)

    # the coral circles: one row on the NSW map for every park, plus a second row
    # inside the lens for the parks near Sydney (one layer, so one click selection)
    circles = []
    for r in park_info:
        circles.append({**r, "where": "map", "plon": r["lon"], "plat": r["lat"]})
        if r["in_zoom"]:
            circles.append({**r, "where": "lens", "plon": r["zlon"], "plat": r["zlat"]})
    write_json("park_circles.json", circles)

    for pt in points:
        pt["in_zoom"] = in_spot(pt["lon"], pt["lat"])
        pt["zlon"], pt["zlat"] = magnify(pt["lon"], pt["lat"])
    write_json("lookouts_by_region.json", points)  # again, now with the lens positions

    # the lens itself: shadow, glass, land and parks inside it, and the lines to the spot on the map
    lens = [ring_feature(circle((LENS[0] + 0.3, LENS[1] - 0.3), LENS_RADIUS), "shadow"),
            ring_feature(circle(LENS, LENS_RADIUS), "glass")]
    for layer, feats in [("land", nsw), ("park", parks)]:
        for f in feats:
            for poly in f["geometry"]["coordinates"]:
                ring = clip_to_circle(poly[0])
                if ring:
                    lens.append({"type": "Feature", "properties": {"layer": layer},
                                 "geometry": {"type": "Polygon", "coordinates": [ring]}})
    lens.append(ring_feature(circle(SPOT, LENS_SPOT_RADIUS), "spot"))
    # the two outer tangent lines between the spot circle and the lens
    d = math.hypot(LENS[0] - SPOT[0], LENS[1] - SPOT[1])
    theta = math.atan2(LENS[1] - SPOT[1], LENS[0] - SPOT[0])
    for sign in (1, -1):
        a = theta + sign * math.acos((LENS_SPOT_RADIUS - LENS_RADIUS) / d)
        p1 = (SPOT[0] + LENS_SPOT_RADIUS * math.cos(a), SPOT[1] + LENS_SPOT_RADIUS * math.sin(a))
        p2 = (LENS[0] + LENS_RADIUS * math.cos(a), LENS[1] + LENS_RADIUS * math.sin(a))
        lens.append(line_feature(p1, p2, "connector"))
    write_json("sydney_lens.json", {"type": "FeatureCollection", "features": lens})
    title = from_map(LENS[0], LENS[1] + LENS_RADIUS + 0.55)
    write_json("sydney_lens_label.json", [{"lon": title[0], "lat": title[1], "text": f"Sydney, {ZOOM:.0f}× closer"}])

    # 7. Numbers for the page text (<span data-stat="...">)
    years = read_csv("visits_by_year.csv")
    satisfaction = read_csv("satisfaction_2024_25.csv")
    first, latest = years[0], years[-1]

    def visits_in(year):
        row = next((r for r in years if r["year"] == year), None)
        return num(row["total_visits"]) if row else math.nan

    def km_for(cls):
        total = 0
        for r in classes:
            if num(r["class_num"]) in cls:
                total += num(r["total_km"])
        return total

    graded = km_for([1, 2, 3, 4, 5, 6])
    track_km = 0
    for r in classes:
        track_km += num(r["total_km"]) or 0
    sydney = next(r for r in visits if r["branch"] == "Greater Sydney")
    syd_shares = [r for r in shares if r["branch"] == "Greater Sydney"]
    with_lookouts = [r for r in per_region if r["lookouts"] > 0]
    by_count = sorted(with_lookouts, key=lambda r: -r["lookouts"])
    by_crowd = sorted(with_lookouts, key=lambda r: -r["perLookout"])
    crowded, quiet = by_crowd[0], by_crowd[-1]
    EASY, HARD = DIFFICULTY[0]["label"], DIFFICULTY[2]["label"]
    big = [p for p in top_parks if p["total"] >= 5]  # ignore parks with under 5 km of track
    share_of = lambda p, label: p["byGroup"][label] / p["total"]
    easiest = sorted(big, key=lambda p: -share_of(p, EASY))[0]
    hardest = sorted(big, key=lambda p: -share_of(p, HARD))[0]
    busiest = sorted(big, key=lambda p: p["rank"])[0]
    type_share = lambda t: percent(sum(1 for p in points if p["type"] == t) / len(points))
    branch_total = 0
    for r in visits:
        branch_total += num(r["visits"])

    stats = {
        "firstYear": first["year"],
        "latestYear": latest["year"],
        "visitsLatest": millions(num(latest["total_visits"])) + "M",
        "visitsLatestWords": millions(num(latest["total_visits"])) + " million",
        "firstVisitsWords": millions(num(first["total_visits"])) + " million",
        "covidDrop": f"{js_round((visits_in('2018') - visits_in('2020')) / 1e6)} million",
        "lookouts": commas(len([r for r in lookouts if r["type"] != "Other"])),
        "trackKm": commas(js_round(track_km / 100) * 100),
        "satisfied": next(r for r in satisfaction if r["group"] == "Overall")["net_satisfied_pct"] + "%",
        "sydneyVisits": f"{js_round(num(sydney['visits']) / 1e6)} million",
        "sydneyShare": percent(num(sydney["visits"]) / branch_total),
        "sydneyShareFirstYear": syd_shares[0]["year"],
        "sydneyShareFirst": f"{js_round(num(syd_shares[0]['share_pct']))}%",
        "sydneyShareLast": f"{js_round(num(syd_shares[-1]['share_pct']))}%",
        "sydneyTop20": str(sum(1 for r in top20 if r.get("branch") == "Greater Sydney")),
        "platformShare": type_share("Viewing platform"),
        "onGroundShare": type_share("On-ground lookout"),
        "mostLookoutsRegion": by_count[0]["branch"],
        "mostLookouts": str(by_count[0]["lookouts"]),
        "sydneyLookouts": str(next(r for r in with_lookouts if r["branch"] == "Greater Sydney")["lookouts"]),
        "crowdedRegion": crowded["branch"],
        "crowdedPerLookout": commas(js_round(crowded["perLookout"] / 1000) * 1000),
        "quietRegion": quiet["branch"],
        "quietPerLookout": commas(js_round(quiet["perLookout"] / 1000) * 1000),
        "crowdRatio": str(js_round(crowded["perLookout"] / quiet["perLookout"])),
        "easyShare": percent(km_for([1, 2]) / graded),
        "class1Km": commas(km_for([1])),
        "moderateShare": percent(km_for([3, 4]) / graded),
        "hardShare": percent(km_for([5, 6]) / graded),
        "easiestPark": easiest["park"],
        "easiestShare": percent(share_of(easiest, EASY)),
        "hardestPark": hardest["park"],
        "hardestShare": percent(share_of(hardest, HARD)),
        "busiestPark": busiest["park"],
        "busiestHard": percent(share_of(busiest, HARD)),
        "busiestEasy": percent(share_of(busiest, EASY)),
    }
    write_json("page_numbers.json", stats)


if __name__ == "__main__":
    main()
