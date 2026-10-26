import copy
import json
from pathlib import Path

SRC = Path("charts/2_top_20_parks_and_lookouts.vg.json")
BARS_OUT = Path("charts/2.2_ranked_by_visits.vg.json")
SCHEMA = "https://vega.github.io/schema/vega-lite/v5.json"

SHOW_ALL_OR_PICKED = "highlightPark == null || datum.park == highlightPark"
PICKED_ONLY = "highlightPark != null && datum.park == highlightPark"


def swap_conditions(node):
    """Styles now react to a plain highlightPark value that main.js sets."""
    if isinstance(node, dict):
        cond = node.get("condition")
        if isinstance(cond, dict) and cond.get("param") == "pickPark":
            test = SHOW_ALL_OR_PICKED if cond.get("empty", True) else PICKED_ONLY
            node["condition"] = {"test": test, "value": cond["value"]}
        for child in node.values():
            swap_conditions(child)
    elif isinstance(node, list):
        for child in node:
            swap_conditions(child)


def click_params(views=None):
    pick = {
        "name": "pickPark",
        "select": {"type": "point", "fields": ["park"], "on": "click", "clear": "dblclick"},
    }
    if views:
        pick["views"] = views
    return [pick, {"name": "highlightPark", "value": None}]


spec = json.loads(SRC.read_text(encoding="utf-8"))
map_view, bars_view = spec["vconcat"]

# ---- map ----
map_spec = {
    "$schema": SCHEMA,
    "title": {
        "text": "Top 20 parks and lookouts",
        "subtitle": "Circle size shows visits in 2024/25. Purple rings are lookouts.",
    },
    "autosize": "pad",
    "params": click_params(views=["park_circles"]),
    **copy.deepcopy(map_view),
}
swap_conditions(map_spec)

for layer in map_spec["layer"]:
    enc = layer.get("encoding", {})
    stroke_legend = enc.get("stroke", {}).get("legend")
    if isinstance(stroke_legend, dict):
        stroke_legend.update({"labelFontSize": 11, "padding": 0, "offset": 4})
    size = enc.get("size")
    if size:
        size["title"] = "Visits to each park, 2024/25"
        size["legend"].update({
            "labelExpr": "datum.value / 1000000 + ' million'",
            "titleFontSize": 11, "labelFontSize": 11, "titleLimit": 240,
            "columnPadding": 14, "padding": 0, "offset": 4,
        })

# ---- bars ----
bars = copy.deepcopy(bars_view)
bars.pop("name", None)
bars.update({
    "$schema": SCHEMA,
    "width": "container",
    "height": {"step": 16},
    "autosize": {"type": "fit-x", "contains": "padding"},
    "params": click_params(),
})
bars["encoding"]["y"]["axis"] = {"labelFontSize": 11, "labelLimit": 170}
swap_conditions(bars)


def dump(obj):
    text = json.dumps(obj, indent=2, ensure_ascii=False)
    return text.replace("Lookout (hover for details)", "Lookout (hover for its name)")


SRC.with_suffix(".json.bak").write_text(SRC.read_text(encoding="utf-8"), encoding="utf-8")
SRC.write_text(dump(map_spec), encoding="utf-8")
BARS_OUT.write_text(dump(bars), encoding="utf-8")
print("wrote", SRC, "and", BARS_OUT)