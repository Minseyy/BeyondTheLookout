"""
Download and clean NSW NPWS spatial data for the "Worth the Walk" DV2 project.

Run from your project folder (needs only Python 3.8+; no extra packages;
data_layout.py must sit next to this file):
    python get_npws_data.py

Creates in ./data/ (each file goes in the folder set in data_layout.py):
    (survey CSVs)              visits_by_year, top20_parks, visitor_origin, branch_*, satisfaction,
                               trip_role, visit_duration, top10_activities, monthly_index
                               -- only written if missing, so your edits are kept
    parks.geojson              NPWS estate polygons (simplified)      -> base map, choropleth
    park_points.csv            one lon/lat point per park
    top20_parks_located.csv    top-20 visited parks + lon/lat        -> proportional symbol map
    nsw_outline.geojson        NSW border (ABS)                      -> background for every map
    lookouts.geojson           every lookout, with its park          -> dot map
    lookouts.csv               same, as a table
    tracks.geojson             walking tracks & routes, with class   -> track map
    tracks.csv                 one row per track section (no geometry)
    lookouts_per_park.csv      lookout counts per park               -> bar chart
    tracks_by_class.csv        number + total km per track class     -> bar / waffle
    tracks_length_x_class.csv  count per length band x class         -> heatmap
    nsw_visitor_expenditure.csv (Data.NSW)                           -> connected scatter

Data: (c) State of NSW and NSW DCCEEW, CC BY 4.0. Data.NSW, CC BY.
"""

import csv
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

import data_layout

OUT = "data"

LOOKOUT_URL = "https://mapprod2.environment.nsw.gov.au/arcgis/rest/services/Assets/AMS_Assets/FeatureServer/14"
TRACK_URL = "https://mapprod2.environment.nsw.gov.au/arcgis/rest/services/Assets/AMS_Assets/FeatureServer/34"
ESTATE_URL = "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/EDP/Estate/MapServer/0"
ABS_STATE_URL = "https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/STE/MapServer/0"
EXPENDITURE_API = "https://data.nsw.gov.au/data/api/3/action/package_show?id=nsw-visitor-expenditure"

LOOKOUT_TYPES = {5301: "On-ground lookout", 5302: "Viewing platform", 5303: "Viewpoint"}
TRACK_SUBTYPES = {1101: "Walking track", 1102: "Walking route"}
TRACK_CLASS = {
    1: "Class 1 - All access",
    2: "Class 2 - Graded track",
    3: "Class 3 - Walking track",
    4: "Class 4 - Hiking track",
    5: "Class 5 - Marked route",
    6: "Class 6 - Unmarked route",
    9999: "Unknown",
}
LENGTH_BANDS = [(0, 0.5, "<0.5 km"), (0.5, 1, "0.5-1 km"), (1, 2, "1-2 km"),
                (2, 5, "2-5 km"), (5, 10, "5-10 km"), (10, 1e9, "10+ km")]

# Survey tables copied from the NPWS Park Visitor Survey webpage and FY24-25 annual report PDF.
# Written only if the file doesn't already exist, so your own edits are never overwritten.
SURVEY_TABLES = {
    'branch_share_by_year.csv': 'branch,year,share_pct\nGreater Sydney,2008,29.9\nGreater Sydney,2010,28.8\nGreater Sydney,2012,33.0\nGreater Sydney,2014,33.4\nGreater Sydney,2016,30.9\nGreater Sydney,2018,32.6\nGreater Sydney,2020,39.2\nGreater Sydney,2022,38.4\nGreater Sydney,2024/25,43.1\nBlue Mountains,2008,14.4\nBlue Mountains,2010,12.6\nBlue Mountains,2012,11.1\nBlue Mountains,2014,14.0\nBlue Mountains,2016,11.0\nBlue Mountains,2018,16.0\nBlue Mountains,2020,14.4\nBlue Mountains,2022,14.8\nBlue Mountains,2024/25,13.2\nHunter Central Coast,2008,13.7\nHunter Central Coast,2010,13.8\nHunter Central Coast,2012,9.8\nHunter Central Coast,2014,14.5\nHunter Central Coast,2016,15.1\nHunter Central Coast,2018,13.7\nHunter Central Coast,2020,16.4\nHunter Central Coast,2022,9.5\nHunter Central Coast,2024/25,12.4\nSouth Coast,2008,13.1\nSouth Coast,2010,11.1\nSouth Coast,2012,9.8\nSouth Coast,2014,10.5\nSouth Coast,2016,11.1\nSouth Coast,2018,10.6\nSouth Coast,2020,7.7\nSouth Coast,2022,11.2\nSouth Coast,2024/25,11.4\nNorth Coast,2008,13.3\nNorth Coast,2010,15.5\nNorth Coast,2012,15.9\nNorth Coast,2014,6.2\nNorth Coast,2016,17.7\nNorth Coast,2018,12.1\nNorth Coast,2020,10.7\nNorth Coast,2022,11.7\nNorth Coast,2024/25,10.4\nWest,2008,0.7\nWest,2010,1.4\nWest,2012,0.8\nWest,2014,1.8\nWest,2016,2.5\nWest,2018,2.5\nWest,2020,2.0\nWest,2022,2.2\nWest,2024/25,3.9\nSouthern Ranges,2008,4.3\nSouthern Ranges,2010,5.7\nSouthern Ranges,2012,5.2\nSouthern Ranges,2014,4.3\nSouthern Ranges,2016,5.2\nSouthern Ranges,2018,6.2\nSouthern Ranges,2020,4.0\nSouthern Ranges,2022,5.4\nSouthern Ranges,2024/25,3.5\nNorthern Inland,2008,2.4\nNorthern Inland,2010,2.4\nNorthern Inland,2012,3.3\nNorthern Inland,2014,2.2\nNorthern Inland,2016,2.7\nNorthern Inland,2018,2.6\nNorthern Inland,2020,1.8\nNorthern Inland,2022,2.4\nNorthern Inland,2024/25,2.2\n',
    'branch_visits_2024_25.csv': 'branch,visits\nGreater Sydney,28242772\nBlue Mountains,8690619\nHunter Central Coast,8104462\nSouth Coast,7504389\nNorth Coast,6814841\nWest,2530504\nSouthern Ranges,2282771\nNorthern Inland,1419754\n',
    'monthly_index_2024_25.csv': 'month,visit_index\nJul-24,95\nAug-24,101\nSep-24,94\nOct-24,99\nNov-24,97\nDec-24,111\nJan-25,109\nFeb-25,97\nMar-25,95\nApr-25,103\nMay-25,99\nJun-25,101\n',
    'satisfaction_2024_25.csv': 'group_type,group,net_satisfied_pct\nOverall,Overall,89\nOrigin,Intrastate (NSW residents),90\nOrigin,Interstate,85\nAge,18-34,85\nAge,35-49,89\nAge,50-64,94\nAge,65+,90\n',
    'top10_activities_2024_25.csv': 'rank,activity\n1,Walking\n2,Touring & sightseeing\n3,Picnicking & dining\n4,Rest & relaxation\n5,Water-based recreation\n6,Enjoyment & appreciation of nature\n7,Camping & accommodation\n8,Exercise & sport\n9,Socialising\n10,Photography\n',
    'top20_parks.csv': 'rank,park,visits_2024_25\n1,Blue Mountains,7828608\n2,Royal,4907255\n3,Ku-ring-gai Chase,4302126\n4,Lane Cove,2399260\n5,Kosciuszko,2355402\n6,Sydney Harbour,2208696\n7,Brisbane Water,2068192\n8,Morton,1889384\n9,Bouddi,1573516\n10,Glenrock,1564384\n11,Tomaree,1442481\n12,Kamay Botany Bay,1405052\n13,Garigal,1388905\n14,Eurobodalla,1305299\n15,Berowra Valley,1184377\n16,Worimi Conservation Lands,1164024\n17,Illawarra Escarpment,1112495\n18,Coffs Coast,1040218\n19,Cape Byron,997706\n20,Georges River,963684\n',
    'trip_role_2024_25.csv': "role,intrastate_pct,interstate_pct\nThe only reason,51,17\nThe main reason,19,11\nOne of the main reasons,9,15\nA minor reason,9,22\nNot one of the reasons,8,24\nCan't say,4,11\n",
    'visit_duration_2024_25.csv': "duration,intrastate_pct,interstate_pct\nJust for the day,88,69\nOvernight,3,11\nMultiple nights,7,17\nCan't say/recall,2,2\n",
    'visitor_origin_2024_25.csv': 'origin,group,adults,children,total_visits\nSydney,Intrastate,34680797,7455599,42136397\nRegional NSW,Intrastate,10790569,1889164,12679733\nACT,Interstate,1376038,316092,1692130\nMelbourne,Interstate,1494277,766545,2260821\nRegional VIC,Interstate,854979,339337,1194316\nBrisbane,Interstate,1397195,558334,1955529\nRegional QLD,Interstate,1762364,385473,2147837\nAdelaide,Interstate,194780,145431,340212\nRegional SA & NT,Interstate,303790,455563,759353\nPerth,Interstate,54898,24161,79059\nRegional WA,Interstate,38454,23813,62267\nHobart,Interstate,51325,34500,85825\nRegional TAS,Interstate,91632,105001,196633\n',
    'visits_by_year.csv': 'year,adult_visits,child_visits,total_visits\n2008,31128875,6798741,37927616\n2010,27262279,6581347,33843626\n2012,28745337,6750287,35495624\n2014,31674661,7761387,39436048\n2016,40103897,11558047,51661944\n2018,45333817,14902193,60236009\n2020,38541509,11543729,50085238\n2022,40499303,12506400,53005703\n2024/25,53091099,12499013,65590112\n',
}

HEADERS = {"User-Agent": "Mozilla/5.0 (FIT3179 student project; data download script)"}


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------
def http(url, params=None, post=False, tries=4):
    data = None
    if params:
        enc = urllib.parse.urlencode(params)
        if post:
            data = enc.encode()
        else:
            url = url + ("&" if "?" in url else "?") + enc
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:
            if attempt == tries - 1:
                raise
            wait = 3 * (attempt + 1)
            print(f"    retry in {wait}s ({e})")
            time.sleep(wait)


def fetch_layer(layer_url, where="1=1", out_fields="*", offset=None, chunk=400):
    """Download every feature of an ArcGIS layer as GeoJSON features (WGS84)."""
    ids = json.loads(http(layer_url + "/query", {"where": where, "returnIdsOnly": "true", "f": "json"}, post=True))
    if "error" in ids:
        raise RuntimeError(ids["error"])
    oids = sorted(ids.get("objectIds") or [])
    print(f"    {len(oids)} features")
    feats = []
    for i in range(0, len(oids), chunk):
        params = {
            "objectIds": ",".join(map(str, oids[i:i + chunk])),
            "outFields": out_fields,
            "returnGeometry": "true",
            "returnZ": "false",
            "outSR": "4326",
            "geometryPrecision": "5",
            "f": "geojson",
        }
        if offset:
            params["maxAllowableOffset"] = str(offset)
        page = json.loads(http(layer_url + "/query", params, post=True))
        if "error" in page:
            raise RuntimeError(page["error"])
        feats.extend(page.get("features", []))
        print(f"    downloaded {len(feats)}/{len(oids)}", end="\r")
    print()
    return [f for f in feats if f.get("geometry")]


# --------------------------------------------------------------------------
# Geometry helpers (pure Python)
# --------------------------------------------------------------------------
def haversine_km(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(h))


def line_parts(geom):
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def line_length_km(geom):
    return sum(haversine_km(p[i], p[i + 1]) for p in line_parts(geom) for i in range(len(p) - 1))


def line_midpoint(geom):
    parts = [p for p in line_parts(geom) if p]
    pts = max(parts, key=len) if parts else [[0, 0]]
    return pts[len(pts) // 2][0], pts[len(pts) // 2][1]


def drop_z(coords):
    """Remove height values: [x, y, z] -> [x, y], at any nesting depth."""
    if coords and isinstance(coords[0], (int, float)):
        return coords[:2]
    return [drop_z(c) for c in coords]


def polygons(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


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


def in_polygon(x, y, geom):
    for poly in polygons(geom):
        if poly and in_ring(x, y, poly[0]) and not any(in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def bbox(geom):
    xs, ys = [], []
    for poly in polygons(geom):
        for ring in poly:
            for p in ring:
                xs.append(p[0]); ys.append(p[1])
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


class ParkIndex:
    """Point -> park lookup with bounding-box pre-filter."""

    def __init__(self, park_feats):
        self.items = [(bbox(f["geometry"]), f) for f in park_feats]
        self.items = [(b, f) for b, f in self.items if b]

    def find(self, x, y):
        for (x0, y0, x1, y1), f in self.items:
            if x0 <= x <= x1 and y0 <= y <= y1 and in_polygon(x, y, f["geometry"]):
                return f["properties"]
        return None


# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------
def write_geojson(path, feats):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
    print(f"  wrote {path}  ({os.path.getsize(path) / 1e6:.2f} MB, {len(feats)} features)")


def write_csv(path, rows, fields):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"  wrote {path}  ({len(rows)} rows)")


def clean_lookout_name(name):
    """'OnGround Lookout - Perrys Lookdown - Nth' -> 'Perrys Lookdown - Nth'"""
    if not name:
        return ""
    for prefix in ("OnGround Lookout - ", "Viewing Platform - ", "ViewPoint - ", "Lookout - "):
        if name.startswith(prefix):
            return name[len(prefix):].strip()
    return name.strip()


# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------
def get_parks():
    print("\n[1/5] NPWS estate (park boundaries)")
    feats = fetch_layer(ESTATE_URL, out_fields="NAME,NAME_SHORT,TYPE,GIS_AREA", offset=0.0015, chunk=100)
    out = []
    for f in feats:
        p = f["properties"]
        f["geometry"] = {"type": f["geometry"]["type"], "coordinates": drop_z(f["geometry"]["coordinates"])}
        f["properties"] = {
            "park": p.get("NAME"),
            "park_short": p.get("NAME_SHORT"),
            "type": p.get("TYPE"),
            "gis_area": round(p["GIS_AREA"], 1) if p.get("GIS_AREA") is not None else None,
        }
        out.append(f)
    write_geojson(data_layout.out_path("parks.geojson"), out)
    write_park_points(out)
    return out


def ring_centroid(ring):
    """Area-weighted centroid and absolute area (degrees^2) of a polygon ring."""
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i][0], ring[i][1]
        x1, y1 = ring[i + 1][0], ring[i + 1][1]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-12:
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        return sum(xs) / len(xs), sum(ys) / len(ys), 0.0
    return cx / (3 * a), cy / (3 * a), abs(a) / 2


def write_park_points(park_feats):
    """One point per park (centre of its largest piece) + top-20 parks with locations."""
    best = {}
    for f in park_feats:
        p = f["properties"]
        for poly in polygons(f["geometry"]):
            if not poly:
                continue
            x, y, area = ring_centroid(poly[0])
            if p["park"] not in best or area > best[p["park"]]["_area"]:
                best[p["park"]] = {"park": p["park"], "park_short": p["park_short"], "type": p["type"],
                                   "lon": round(x, 5), "lat": round(y, 5), "_area": area}
    rows = sorted(best.values(), key=lambda r: r["park"] or "")
    for r in rows:
        r.pop("_area")
    write_csv(data_layout.out_path("park_points.csv"), rows, ["park", "park_short", "type", "lon", "lat"])

    top_path = data_layout.find("top20_parks.csv")
    if not top_path:
        return
    with open(top_path, encoding="utf-8") as f:
        top = list(csv.DictReader(f))
    by_full = {(r["park"] or "").lower(): r for r in rows}
    out, missing = [], []
    for t in top:
        name = t["park"].strip().lower()
        match = (by_full.get(name + " national park")
                 or by_full.get(name)
                 or next((r for r in rows if (r["park"] or "").lower().startswith(name + " ")), None)
                 or next((r for r in rows if (r["park_short"] or "").lower() == name), None))
        if match:
            out.append({**t, "park_full": match["park"], "lon": match["lon"], "lat": match["lat"]})
        else:
            missing.append(t["park"])
            out.append({**t, "park_full": "", "lon": "", "lat": ""})
    write_csv(data_layout.out_path("top20_parks_located.csv"), out, ["rank", "park", "visits_2024_25", "park_full", "lon", "lat"])
    if missing:
        print("  ! no boundary match for:", ", ".join(missing), "- fill lon/lat by hand in top20_parks_located.csv")


def get_nsw_outline():
    print("\n[5/5] NSW state outline (ABS ASGS 2021)")
    try:
        feats = fetch_layer(ABS_STATE_URL, where="state_code_2021='1'", out_fields="state_name_2021", offset=0.005)
        for f in feats:
            f["properties"] = {"state": f["properties"].get("state_name_2021", "New South Wales")}
        write_geojson(data_layout.out_path("nsw_outline.geojson"), feats)
    except Exception as e:
        print(f"  could not download automatically ({e}). Get the STE 2021 shapefile from the ABS ASGS page instead.")


def get_lookouts(index):
    print("\n[2/5] Lookouts")
    feats = fetch_layer(LOOKOUT_URL, out_fields="OBJECTID,AssetName,SubtypeCD")
    out, rows = [], []
    for f in feats:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        park = index.find(lon, lat) or {}
        props = {
            "id": p.get("OBJECTID"),
            "name": clean_lookout_name(p.get("AssetName")),
            "type": LOOKOUT_TYPES.get(p.get("SubtypeCD"), "Other"),
            "park": park.get("park_short") or park.get("park") or "Outside NPWS estate",
            "park_full": park.get("park") or "",
            "lon": round(lon, 5),
            "lat": round(lat, 5),
        }
        out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [props["lon"], props["lat"]]},
                    "properties": props})
        rows.append(props)
    write_geojson(data_layout.out_path("lookouts.geojson"), out)
    write_csv(data_layout.out_path("lookouts.csv"), rows, list(rows[0].keys()) if rows else ["id"])

    counts = {}
    for r in rows:
        key = (r["park"], r["park_full"])
        counts.setdefault(key, {"park": r["park"], "park_full": r["park_full"], "lookouts": 0,
                                "on_ground": 0, "platforms": 0, "viewpoints": 0})
        c = counts[key]
        c["lookouts"] += 1
        c["on_ground"] += r["type"] == "On-ground lookout"
        c["platforms"] += r["type"] == "Viewing platform"
        c["viewpoints"] += r["type"] == "Viewpoint"
    per_park = sorted(counts.values(), key=lambda c: -c["lookouts"])
    write_csv(data_layout.out_path("lookouts_per_park.csv"), per_park, list(per_park[0].keys()) if per_park else ["park"])


def get_tracks(index):
    print("\n[3/5] Walking tracks & routes (this is the big one)")
    where = "SubtypeCD IN (1101,1102)"
    feats = fetch_layer(TRACK_URL, where=where, out_fields="OBJECTID,AssetName,SubtypeCD,AssetType", offset=0.0002)
    out, rows = [], []
    for f in feats:
        p = f["properties"]
        g = {"type": f["geometry"]["type"], "coordinates": drop_z(f["geometry"]["coordinates"])}
        if not line_parts(g) or not any(len(part) >= 2 for part in line_parts(g)):
            continue
        km = line_length_km(g)
        mx, my = line_midpoint(g)
        park = index.find(mx, my) or {}
        cls = p.get("AssetType")
        props = {
            "id": p.get("OBJECTID"),
            "name": (p.get("AssetName") or "").strip(),
            "kind": TRACK_SUBTYPES.get(p.get("SubtypeCD"), "Other"),
            "class_num": cls if cls in (1, 2, 3, 4, 5, 6) else None,
            "class": TRACK_CLASS.get(cls, "Unknown"),
            "length_km": round(km, 3),
            "park": park.get("park_short") or park.get("park") or "Outside NPWS estate",
        }
        out.append({"type": "Feature", "geometry": g, "properties": props})
        rows.append(props)
    write_geojson(data_layout.out_path("tracks.geojson"), out)
    write_csv(data_layout.out_path("tracks.csv"), rows, list(rows[0].keys()) if rows else ["id"])

    by_class = {}
    for r in rows:
        c = by_class.setdefault(r["class"], {"class": r["class"], "class_num": r["class_num"], "sections": 0, "total_km": 0.0})
        c["sections"] += 1
        c["total_km"] += r["length_km"]
    summary = sorted(by_class.values(), key=lambda c: (c["class_num"] is None, c["class_num"] or 0))
    for c in summary:
        c["total_km"] = round(c["total_km"], 1)
    write_csv(data_layout.out_path("tracks_by_class.csv"), summary, ["class", "class_num", "sections", "total_km"])

    grid = {}
    for r in rows:
        band = next(lbl for lo, hi, lbl in LENGTH_BANDS if lo <= r["length_km"] < hi)
        grid[(band, r["class"])] = grid.get((band, r["class"]), 0) + 1
    heat = [{"length_band": b, "band_order": i, "class": c, "sections": grid.get((b, c), 0)}
            for i, (_, _, b) in enumerate(LENGTH_BANDS) for c in TRACK_CLASS.values()]
    write_csv(data_layout.out_path("tracks_length_x_class.csv"), heat, ["length_band", "band_order", "class", "sections"])


def get_expenditure():
    print("\n[4/5] NSW visitor expenditure (Data.NSW)")
    try:
        meta = json.loads(http(EXPENDITURE_API))
        res = [r for r in meta["result"]["resources"] if (r.get("format") or "").lower() == "csv"]
        if not res:
            raise RuntimeError("no CSV resource listed")
        raw = http(res[0]["url"])
        path = data_layout.out_path("nsw_visitor_expenditure.csv")
        with open(path, "wb") as f:
            f.write(raw)
        print(f"  wrote {path}")
        print("  preview:\n   " + "\n   ".join(raw.decode("utf-8-sig", "replace").splitlines()[:6]))
    except Exception as e:
        print(f"  could not download automatically ({e}).")
        print("  Download it by hand: https://data.nsw.gov.au/data/dataset/nsw-visitor-expenditure")



def write_survey_tables():
    print("\n[0/5] Visitor survey tables")
    for name, text in SURVEY_TABLES.items():
        existing = data_layout.find(name)
        if existing:
            print(f"  kept existing {existing}")
        else:
            path = data_layout.out_path(name)
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(text)
            print(f"  wrote {path}")


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    write_survey_tables()
    try:
        parks = get_parks()
        index = ParkIndex(parks)
        get_lookouts(index)
        get_tracks(index)
    except Exception as e:
        print(f"\nERROR while downloading map layers: {e}")
        print("If this is a network/timeout error, just run the script again.")
        sys.exit(1)
    get_expenditure()
    get_nsw_outline()
    print(f"\nDone in {time.time() - t0:.0f}s. Files are in ./{OUT}/")
    print("Tip: if tracks.geojson is over ~5 MB, drop it into mapshaper.org, run "
          "'-simplify 20% keep-shapes', and export as TopoJSON.")


if __name__ == "__main__":
    main()