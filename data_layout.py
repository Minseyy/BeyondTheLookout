"""
data_layout.py - where every file in data/ lives.

get_npws_data.py and prepare_data.py both import this, so a file's folder is
decided in ONE place. To move a file, change it here and nowhere else.

    out_path("x.json")   where a script should WRITE x.json (makes the folder)
    in_path("x.json")    where a script should READ x.json from (its home folder,
                         or, if it isn't there, wherever it is found under data/)

Folders named after a chart hold the files that chart loads.
    _shared       used by more than one chart (or by a chart and main.js)
    _page         used by main.js only
    _raw_sources  not loaded by the site: the inputs the scripts build from
                  (you can re-make most of these by running get_npws_data.py,
                  but nsw.json and branches.json are downloaded by hand - keep them!)
"""

import os

DATA = "data"

LAYOUT = {
    "1_park_visits_per_survey_year": ["visits_by_year.csv"],
    "2_top_20_parks_and_lookouts": [
        "park_circles.json",
        "lookouts_by_region.json",
        "parks.geojson",
        "parks_map.json",
        "sydney_lens.json",
        "sydney_lens_label.json",
    ],
    "3_park_visits_per_lookout": ["branch_visits_2024_25.csv", "region_lookouts.json"],
    "3.2_share_of_park_visits_by_region": ["region_share_maps.json"],
    "4.1_walking_track_by_difficulty": ["track_waffle.json"],
    "4.2_track_difficulty_in_top_20_parks": ["park_track_difficulty.json"],
    "4.2_park_track_map": ["park_map_lookouts.json", "park_map_shapes.json"],
    "5.1_interstate_flow_map": [
        "australia_states.json",
        "interstate_flows_2024_25.csv",
    ],
    "5.3_international_visitors_map": [
        "international_visitors_2024_25.csv",
        "world-110m.json",
    ],
    "6.1_visits_through_the_year": ["monthly_index_2024_25_CHECK.csv"],
    "6.2_length_of_visit": ["visit_duration_2024_25.csv"],
    "7_top_10_activities": ["top10_activities_2024_25.csv"],
    "7.2_visitor_satisfaction": ["satisfaction_2024_25.csv"],
    "_shared": [
        "branches_fixed.json",
        "nsw_fixed.json",
        "park_info.json",
        "visitor_profile_2024_25.csv",
    ],
    "_page": ["park_details.json", "park_list.json", "page_numbers.json"],
    "_raw_sources": [
        # downloaded by hand - the scripts can NOT re-make these
        "nsw.json",
        "branches.json",
        # made by get_npws_data.py
        "lookouts.csv",
        "lookouts.geojson",
        "lookouts_per_park.csv",
        "park_points.csv",
        "tracks.csv",
        "tracks.geojson",
        "tracks_by_class.csv",
        "tracks_length_x_class.csv",
        "top20_parks.csv",
        "top20_parks_located.csv",
        "nsw_outline.geojson",
        "nsw_visitor_expenditure.csv",
        # survey tables the scripts read but no chart loads
        "branch_share_by_year.csv",
        "trip_role_2024_25.csv",
        "visitor_origin_2024_25.csv",
        "walk_length_by_branch_2024_25.csv",
        "towns.csv",
    ],
}

_FOLDER = {name: folder for folder, names in LAYOUT.items() for name in names}


def out_path(name):
    """Where to write `name`. Creates the folder. Unknown names go in data/ itself, with a warning."""
    folder = _FOLDER.get(name)
    if folder is None:
        print(
            f"  ! {name} is not in data_layout.py - saving it in {DATA}/ (add it to LAYOUT)"
        )
        folder_path = DATA
    else:
        folder_path = os.path.join(DATA, folder)
    os.makedirs(folder_path, exist_ok=True)
    return os.path.join(folder_path, name)


def find(name):
    """The existing path of `name`, or None. Checks its home folder first, then anywhere under data/."""
    folder = _FOLDER.get(name)
    if folder is not None:
        home = os.path.join(DATA, folder, name)
        if os.path.exists(home):
            return home
    for root, _dirs, files in os.walk(DATA):
        if name in files:
            return os.path.join(root, name)
    return None


def in_path(name):
    """Where to read `name` from. If it can't be found, returns its home path so the error says where it should be."""
    found = find(name)
    if found:
        return found
    folder = _FOLDER.get(name)
    return os.path.join(DATA, folder, name) if folder else os.path.join(DATA, name)
