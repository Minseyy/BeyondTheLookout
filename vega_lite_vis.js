// =====================================================================
// Shared settings
// =====================================================================
// Chart colours, matched to the page palette in style.css
const TEAL = "#2a9d8f";
const GREEN_DARK = "#2f5e22";
const CORAL = "#e76f51";
const SEA = "#dcebf4";
const SCHEMA = "https://vega.github.io/schema/vega-lite/v5.json";

// Loads a GeoJSON file so Vega-Lite can read its shapes
function geo(url, box) {
  const d = { url: url, format: { type: "json", property: "features" } };
  if (box) d.box = box; // optional: keep only features that start inside this box
  return d;
}

// The area the track map zooms into: Sydney + Blue Mountains
const SYDNEY_BOX = { west: 150.0, south: -34.6, east: 151.8, north: -33.1 };

function firstPoint(geometry) {
  let c = geometry.coordinates;
  while (Array.isArray(c[0])) c = c[0];
  return c;
}

// Cuts a polygon outline to the box edges (so big parks don't stretch the map)
function clipRingToBox(ring, box) {
  const edges = [
    [
      function (p) {
        return p[0] >= box.west;
      },
      function (a, b) {
        return [
          box.west,
          a[1] + ((b[1] - a[1]) * (box.west - a[0])) / (b[0] - a[0]),
        ];
      },
    ],
    [
      function (p) {
        return p[0] <= box.east;
      },
      function (a, b) {
        return [
          box.east,
          a[1] + ((b[1] - a[1]) * (box.east - a[0])) / (b[0] - a[0]),
        ];
      },
    ],
    [
      function (p) {
        return p[1] >= box.south;
      },
      function (a, b) {
        return [
          a[0] + ((b[0] - a[0]) * (box.south - a[1])) / (b[1] - a[1]),
          box.south,
        ];
      },
    ],
    [
      function (p) {
        return p[1] <= box.north;
      },
      function (a, b) {
        return [
          a[0] + ((b[0] - a[0]) * (box.north - a[1])) / (b[1] - a[1]),
          box.north,
        ];
      },
    ],
  ];
  let pts = ring.slice(0, -1);
  for (const [inside, cross] of edges) {
    if (pts.length === 0) break;
    const out = [];
    let prev = pts[pts.length - 1];
    for (const cur of pts) {
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cross(prev, cur));
      }
      prev = cur;
    }
    pts = out;
  }
  return pts.length >= 3 ? pts.concat([pts[0]]) : null;
}

function clipFeatureToBox(f, box) {
  const g = f.geometry;
  if (!g || g.type !== "MultiPolygon") return f; // lines and points are left as they are
  const parts = g.coordinates
    .map(function (poly) {
      const rings = poly.map(function (r) {
        return clipRingToBox(r, box);
      });
      if (!rings[0]) return null;
      return [rings[0]].concat(
        rings.slice(1).filter(function (r) {
          return r;
        }),
      );
    })
    .filter(function (p) {
      return p;
    });
  return parts.length
    ? Object.assign({}, f, {
        geometry: { type: "MultiPolygon", coordinates: parts },
      })
    : null;
}

function insideBox(f, box) {
  if (!f.geometry) return false;
  const p = firstPoint(f.geometry);
  return (
    p[0] >= box.west &&
    p[0] <= box.east &&
    p[1] >= box.south &&
    p[1] <= box.north
  );
}

// =====================================================================
// Map-file fixer
// Vega-Lite needs polygon outlines drawn CLOCKWISE. Files from mapshaper,
// ArcGIS or geojson.io are usually anti-clockwise, which makes a shape
// fill the whole world. This flips them on load, so ANY GeoJSON file you
// add with geo("...") just works.
// =====================================================================
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2; // negative = clockwise
}

function fixPolygon(rings) {
  return rings.map(function (ring, i) {
    const isClockwise = ringArea(ring) < 0;
    const wantClockwise = i === 0; // outer ring clockwise, holes anti-clockwise
    return isClockwise === wantClockwise ? ring : ring.slice().reverse();
  });
}

// Slivers: some files contain zero-size triangles (with an identical hole
// inside). d3 reads those as "the whole world", so we drop them, plus any
// hole that is tiny. Anything under ~1 hectare is invisible on these maps.
const MIN_AREA = 1e-6; // in square degrees (about 1 hectare)

function cleanPolygon(rings) {
  const outer = rings[0];
  if (!outer || outer.length < 4 || Math.abs(ringArea(outer)) < MIN_AREA)
    return null;
  const holes = rings.slice(1).filter(function (h) {
    return (
      h.length >= 4 &&
      Math.abs(ringArea(h)) >= MIN_AREA &&
      Math.abs(ringArea(h)) < Math.abs(ringArea(outer))
    );
  });
  return fixPolygon([outer].concat(holes));
}

function rewindFeature(f) {
  const g = f && f.geometry;
  if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) {
    const parts = (g.type === "Polygon" ? [g.coordinates] : g.coordinates)
      .map(cleanPolygon)
      .filter(function (p) {
        return p !== null;
      });
    if (parts.length === 0) {
      f.geometry = null; // nothing visible left
    } else {
      f.geometry = { type: "MultiPolygon", coordinates: parts };
    }
  }
  return f;
}

const geoCache = {};
function loadFeatures(url) {
  if (!geoCache[url]) {
    geoCache[url] = fetch(url)
      .then(function (res) {
        if (!res.ok) {
          console.warn(url + " not found - that map layer is skipped");
          return { features: [] };
        }
        return res.json();
      })
      .then(function (gj) {
        return (gj.features || []).map(rewindFeature).filter(function (f) {
          return f.geometry;
        });
      });
  }
  return geoCache[url];
}

// Swaps every geo("...") file in a chart for the fixed shapes.
// Works through layers and side-by-side (hconcat / vconcat) charts.
async function prepareSpec(spec) {
  const d = spec.data;
  if (d && d.url && d.format && d.format.property === "features") {
    let features = await loadFeatures(d.url);
    if (d.box) {
      features = features
        .filter(function (f) {
          return insideBox(f, d.box);
        })
        .map(function (f) {
          return clipFeatureToBox(f, d.box);
        })
        .filter(function (f) {
          return f;
        });
    }
    spec.data = { values: features };
  } else if (
    d &&
    Array.isArray(d.values) &&
    d.values.length &&
    d.values[0].type === "Feature"
  ) {
    d.values.forEach(rewindFeature);
  }
  for (const key of ["layer", "hconcat", "vconcat", "concat"]) {
    if (spec[key]) {
      for (const child of spec[key]) await prepareSpec(child);
    }
  }
  return spec;
}

// =====================================================================
// Section 1: visits per year (bar chart)
// =====================================================================
const visitsChart = {
  $schema: SCHEMA,
  width: "container",
  height: 280,
  data: {
    url: "data/visits_by_year.csv",
    format: { parse: { year: "string" } },
  },
  encoding: {
    x: {
      field: "year",
      type: "ordinal",
      title: "Survey year",
      axis: { labelAngle: 0 },
    },
    y: {
      field: "total_visits",
      type: "quantitative",
      title: "Visits per year",
      axis: { format: "~s" },
    },
  },
  layer: [
    {
      mark: { type: "bar", cornerRadiusEnd: 3 },
      encoding: {
        color: {
          condition: { test: "datum.year == '2020'", value: CORAL },
          value: GREEN_DARK,
        },
        tooltip: [
          { field: "year", title: "Year" },
          { field: "total_visits", title: "Visits", format: "," },
        ],
      },
    },
    {
      transform: [{ filter: "datum.year == '2020'" }],
      mark: {
        type: "text",
        text: "COVID-19",
        dy: -8,
        color: CORAL,
        fontWeight: "bold",
      },
    },
  ],
};

// =====================================================================
// Section 2: "Google-style" map + linked bar chart
//   Basemap: mint land, blue sea, green national parks, blue lakes,
//            faint dashed borders for states and NPWS regions, no roads
//   Click a region  -> it's outlined, and its parks light up on the map
//                      AND in the bar chart. Double-click -> reset
// =====================================================================
const STYLE = {
  sea: "#a8dcef",
  land: "#e3f5ea",
  landOther: "#eef2ec",
  park: "#c0e8cc",
  border: "#9aa8a2",
  label: "#5f6b66",
  parkLabel: "#2e7d5b",
};

// true when nothing is clicked yet, or when this row's region is the clicked one
const regionPicked = { param: "pickRegion", empty: true };

// A few big places so readers can orient themselves (no suburbs)
const cities = [
  { name: "Sydney", lon: 151.2093, lat: -33.8688 },
  { name: "Newcastle", lon: 151.7817, lat: -32.9283 },
  { name: "Wollongong", lon: 150.8931, lat: -34.4278 },
  { name: "Canberra", lon: 149.13, lat: -35.2809 },
];

const regionsMap = {
  $schema: SCHEMA,
  autosize: "pad", // side-by-side charts keep their own sizes
  spacing: 30,
  hconcat: [
    // ---------------- LEFT: the map ----------------
    {
      width: 520,
      height: 480,
      projection: { type: "mercator" },
      view: { fill: STYLE.sea, stroke: null },
      layer: [
        // 1. neighbouring states (context.json from mapshaper - optional)
        {
          data: geo("data/context.json"),
          mark: {
            type: "geoshape",
            fill: STYLE.landOther,
            stroke: STYLE.border,
            strokeWidth: 0.8,
            strokeDash: [4, 3],
          },
        },

        // 2. NSW land
        {
          data: geo("data/nsw.json"),
          mark: { type: "geoshape", fill: STYLE.land, stroke: null },
        },

        // 3. national parks as darker green patches
        {
          data: geo("data/parks.geojson"),
          mark: { type: "geoshape", fill: STYLE.park, stroke: null },
          encoding: { tooltip: [{ field: "properties.park", title: "Park" }] },
        },

        // 4. lakes (lakes.json from mapshaper - optional)
        {
          data: geo("data/lakes.json"),
          mark: { type: "geoshape", fill: STYLE.sea, stroke: null },
        },

        // 5. NPWS regions: invisible fill (so you can click them) + faint dashed border
        {
          data: geo("data/branches.json"),
          transform: [
            { filter: "datum.properties.NAME != 'ACT'" },
            { calculate: "datum.properties.NAME", as: "branch" },
            {
              lookup: "branch",
              from: {
                data: { url: "data/branch_visits_2024_25.csv" },
                key: "branch",
                fields: ["visits"],
              },
            },
          ],
          params: [
            {
              name: "pickRegion",
              select: {
                type: "point",
                fields: ["branch"],
                on: "click",
                clear: "dblclick",
              },
            },
          ],
          mark: {
            type: "geoshape",
            fill: GREEN_DARK,
            stroke: STYLE.border,
            strokeDash: [3, 3],
            cursor: "pointer",
          },
          encoding: {
            fillOpacity: {
              condition: { param: "pickRegion", empty: false, value: 0.12 },
              value: 0.01,
            },
            strokeWidth: {
              condition: { param: "pickRegion", empty: false, value: 2.5 },
              value: 0.8,
            },
            tooltip: [
              { field: "branch", title: "NPWS region" },
              {
                field: "visits",
                title: "Region visits (2024/25)",
                format: ",",
              },
            ],
          },
        },

        // 6. region names (Greater Sydney & Blue Mountains are small - hover them)
        {
          data: { url: "data/branch_visits_2024_25.csv" },
          transform: [
            {
              filter:
                "datum.branch != 'Greater Sydney' && datum.branch != 'Blue Mountains'",
            },
          ],
          mark: {
            type: "text",
            fontSize: 10,
            fontStyle: "italic",
            color: STYLE.label,
            opacity: 0.9,
          },
          encoding: {
            longitude: { field: "label_lon", type: "quantitative" },
            latitude: { field: "label_lat", type: "quantitative" },
            text: { field: "branch", type: "nominal" },
          },
        },

        // 7. city dots + names
        {
          data: { values: cities },
          mark: { type: "circle", size: 12, color: STYLE.label },
          encoding: {
            longitude: { field: "lon", type: "quantitative" },
            latitude: { field: "lat", type: "quantitative" },
          },
        },
        {
          data: { values: cities },
          mark: {
            type: "text",
            align: "left",
            dx: 5,
            dy: -5,
            fontSize: 10,
            color: STYLE.label,
          },
          encoding: {
            longitude: { field: "lon", type: "quantitative" },
            latitude: { field: "lat", type: "quantitative" },
            text: { field: "name", type: "nominal" },
          },
        },

        // 8. top-20 park circles
        {
          data: { url: "data/top20_parks_located.csv" },
          transform: [{ filter: "isValid(datum.lon)" }],
          mark: {
            type: "circle",
            color: CORAL,
            stroke: "white",
            strokeWidth: 1.2,
          },
          encoding: {
            longitude: { field: "lon", type: "quantitative" },
            latitude: { field: "lat", type: "quantitative" },
            size: {
              field: "visits_2024_25",
              type: "quantitative",
              title: "Park visits (2024/25)",
              scale: { domain: [0, 8000000], range: [0, 900] },
              legend: {
                values: [1000000, 4000000, 8000000],
                format: "~s",
                orient: "bottom",
                symbolFillColor: CORAL, // same orange as the circles on the map
                symbolOpacity: 0.9,
                symbolStrokeColor: "white",
                symbolStrokeWidth: 1.2,
              },
            },
            order: { field: "visits_2024_25", sort: "descending" },
            opacity: { condition: regionPicked, value: 0.15 },
            tooltip: [
              { field: "rank", title: "Rank" },
              { field: "park_full", title: "Park" },
              { field: "branch", title: "NPWS region" },
              {
                field: "visits_2024_25",
                title: "Visits (2024/25)",
                format: ",",
              },
            ],
          },
        },
      ],
    },

    // ---------------- RIGHT: linked bar chart ----------------
    {
      width: 300,
      height: 480,
      title: {
        text: "Top 20 parks by visits",
        subtitle: "Click a region on the map to highlight its parks",
        anchor: "start",
        fontSize: 13,
        subtitleFontSize: 11,
      },
      data: { url: "data/top20_parks_located.csv" },
      mark: { type: "bar", cornerRadiusEnd: 3 },
      encoding: {
        y: { field: "park", type: "nominal", sort: "-x", title: null },
        x: {
          field: "visits_2024_25",
          type: "quantitative",
          title: "Visits (2024/25)",
          axis: { format: "~s" },
        },
        color: {
          condition: { param: "pickRegion", empty: true, value: CORAL },
          value: "#dddddd",
        },
        tooltip: [
          { field: "park_full", title: "Park" },
          { field: "branch", title: "NPWS region" },
          { field: "visits_2024_25", title: "Visits", format: "," },
        ],
      },
    },
  ],
};

// =====================================================================
// Section 2b: each region's share of visits, one small map per survey
//             year (small-multiple choropleth)
//   Hover a region -> it's outlined in every year, so you can follow it
// =====================================================================

// Region outlines are very detailed. At small-multiple size that detail is
// invisible but slow to draw, so drop points closer than `tol` degrees.
function thinFeature(f, tol) {
  const thinRing = function (ring) {
    const out = [ring[0]];
    for (let i = 1; i < ring.length - 1; i++) {
      const last = out[out.length - 1];
      if (
        Math.abs(ring[i][0] - last[0]) > tol ||
        Math.abs(ring[i][1] - last[1]) > tol
      )
        out.push(ring[i]);
    }
    out.push(ring[ring.length - 1]);
    return out.length >= 4 ? out : null;
  };
  const parts = f.geometry.coordinates
    .map(function (poly) {
      const rings = poly.map(thinRing);
      if (!rings[0]) return null;
      return [rings[0]].concat(
        rings.slice(1).filter(function (r) {
          return r;
        }),
      );
    })
    .filter(function (p) {
      return p;
    });
  return {
    type: "Feature",
    properties: f.properties,
    geometry: { type: "MultiPolygon", coordinates: parts },
  };
}

// Colour bins for "share of all visits" (%). The top bins are split at
// 30 and 40 so Greater Sydney's climb shows up as a change of colour.
const SHARE_BINS = [3, 6, 10, 15, 30, 40];
const SHARE_COLOURS = [
  "#f1f7e9",
  "#d6ecc6",
  "#b3dba0",
  "#86c17a",
  "#57a05a",
  "#2f7a3d",
  "#173d1a",
];

async function buildShareMaps() {
  const [branches, shares] = await Promise.all([
    loadFeatures("data/branches.json"),
    loadCSV("data/branch_share_by_year.csv"),
  ]);
  const outline = {};
  branches.forEach(function (f) {
    outline[f.properties.NAME] = thinFeature(f, 0.02);
  });

  // the eight regions don't always add up to 100% in the older reports
  const totals = {};
  shares.forEach(function (r) {
    totals[r.year] = (totals[r.year] || 0) + +r.share_pct;
  });
  const years = Object.keys(totals); // survey order

  // one small map per survey year (9 separate views, 3 per row)
  const maps = years.map(function (year, i) {
    const regions = shares
      .filter(function (r) {
        return r.year === year && outline[r.branch];
      })
      .map(function (r) {
        return {
          type: "Feature",
          geometry: outline[r.branch].geometry,
          properties: {},
          branch: r.branch,
          year: year,
          share: +r.share_pct,
          yearTotal: Math.round(totals[year] * 10) / 10,
        };
      });
    const sydney = regions.find(function (f) {
      return f.branch === "Greater Sydney";
    });

    return {
      width: 240,
      height: 200,
      title: {
        text: year,
        font: "Fraunces, Georgia, serif",
        fontSize: 15,
        color: "#1f3d17",
        offset: 4,
      },
      projection: { type: "mercator" },
      view: { fill: STYLE.sea, stroke: null },
      layer: [
        {
          name: "share_map_" + i, // the hover highlight listens to these views
          data: { values: regions },
          mark: { type: "geoshape", cursor: "pointer" },
          encoding: {
            color: {
              field: "share",
              type: "quantitative",
              title: "Share of all visits (%)",
              scale: {
                type: "threshold",
                domain: SHARE_BINS,
                range: SHARE_COLOURS,
              },
              legend: { orient: "right" },
            },
            stroke: {
              condition: { param: "hoverRegion", empty: false, value: CORAL },
              value: "white",
            },
            strokeWidth: {
              condition: { param: "hoverRegion", empty: false, value: 2.2 },
              value: 0.6,
            },
            tooltip: [
              { field: "branch", title: "NPWS region" },
              { field: "year", title: "Survey year" },
              { field: "share", title: "Share of visits (%)", format: ".1f" },
              {
                field: "yearTotal",
                title: "All 8 regions add to (%)",
                format: ".1f",
              },
            ],
          },
        },
        // Greater Sydney is tiny at this size, so its share is written in the sea beside it
        {
          data: {
            values: sydney
              ? [
                  {
                    lon: 151.5,
                    lat: -34.5,
                    label: "Sydney\n" + Math.round(sydney.share) + "%",
                  },
                ]
              : [],
          },
          mark: {
            type: "text",
            align: "left",
            baseline: "top",
            lineBreak: "\n",
            fontSize: 11,
            fontWeight: "bold",
            color: "#8a3b24",
          },
          encoding: {
            longitude: { field: "lon", type: "quantitative" },
            latitude: { field: "lat", type: "quantitative" },
            text: { field: "label", type: "nominal" },
          },
        },
      ],
    };
  });

  return {
    $schema: SCHEMA,
    autosize: "pad",
    columns: 3,
    spacing: { row: 14, column: 26 },
    // hover a region on any map -> outlined on all 9
    params: [
      {
        name: "hoverRegion",
        select: {
          type: "point",
          fields: ["branch"],
          on: "mouseover",
          clear: "mouseout",
        },
        views: maps.map(function (m, i) {
          return "share_map_" + i;
        }),
      },
    ],
    concat: maps,
    resolve: { scale: { color: "shared" }, legend: { color: "shared" } },
  };
}

// =====================================================================
// Section 3: where are the lookouts?
//   Dot map: every lookout, coloured by type (click the legend to show one type)
//   Choropleth under it: each region's park visits divided by its lookouts
//   Bar chart beside it: the same number, so the tiny regions can be read
//   Click a region -> its lookouts and its bar stay bright. Double-click resets
// =====================================================================
const LOOKOUT_TYPES = [
  { type: "Viewing platform", color: GREEN_DARK },
  { type: "On-ground lookout", color: TEAL },
  { type: "Viewpoint", color: "#6d4c7d" },
];

// Colour bins for "visits per lookout"
const CROWD_BINS = [25000, 50000, 75000, 100000];
const CROWD_COLOURS = ["#fbf3dc", "#f4dcae", "#eebd8c", "#e0956c", "#c0573c"];

// true if the point [x, y] is inside a ring (ray casting)
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function inFeature(x, y, f) {
  return f.geometry.coordinates.some(function (poly) {
    return (
      inRing(x, y, poly[0]) &&
      !poly.slice(1).some(function (hole) {
        return inRing(x, y, hole);
      })
    );
  });
}

// Works out which NPWS region every lookout is in, and visits per lookout per region
let lookoutRegionsCache = null;
function lookoutRegions() {
  if (!lookoutRegionsCache) {
    lookoutRegionsCache = Promise.all([
      loadCSV("data/lookouts.csv"),
      loadFeatures("data/branches.json"),
      loadCSV("data/branch_visits_2024_25.csv"),
    ]).then(function ([lookouts, branches, visits]) {
      const regions = branches.filter(function (f) {
        return f.properties.NAME !== "ACT";
      });
      const points = lookouts
        .filter(function (r) {
          return r.type !== "Other";
        }) // "Other" = camping platforms
        .map(function (r) {
          const x = +r.lon,
            y = +r.lat;
          const home = regions.find(function (f) {
            return inFeature(x, y, f);
          });
          return {
            name: r.name,
            type: r.type,
            park: r.park_full,
            lon: x,
            lat: y,
            branch: home ? home.properties.NAME : "Outside the regions",
          };
        });

      const perRegion = visits.map(function (v) {
        const count = points.filter(function (p) {
          return p.branch === v.branch;
        }).length;
        return {
          branch: v.branch,
          visits: +v.visits,
          lookouts: count,
          perLookout: count ? +v.visits / count : null,
        };
      });
      return { points: points, regions: perRegion };
    });
  }
  return lookoutRegionsCache;
}

async function buildLookoutMap() {
  const { points, regions } = await lookoutRegions();
  const crowdColour = {
    field: "perLookout",
    type: "quantitative",
    title: "Park visits per lookout",
    scale: { type: "threshold", domain: CROWD_BINS, range: CROWD_COLOURS },
  };
  const regionPickedHere = { param: "pickLookoutRegion", empty: true };

  return {
    $schema: SCHEMA,
    autosize: "pad",
    spacing: 30,
    hconcat: [
      // ---------------- LEFT: choropleth + lookout dots ----------------
      {
        width: 540,
        height: 480,
        projection: { type: "mercator" },
        view: { fill: STYLE.sea, stroke: null },
        layer: [
          {
            data: geo("data/context.json"),
            mark: {
              type: "geoshape",
              fill: STYLE.landOther,
              stroke: STYLE.border,
              strokeWidth: 0.8,
              strokeDash: [4, 3],
            },
          },
          {
            data: geo("data/nsw.json"),
            mark: { type: "geoshape", fill: STYLE.land, stroke: null },
          },

          // regions shaded by visits per lookout
          {
            data: geo("data/branches.json"),
            transform: [
              { filter: "datum.properties.NAME != 'ACT'" },
              { calculate: "datum.properties.NAME", as: "branch" },
              {
                lookup: "branch",
                from: {
                  data: { values: regions },
                  key: "branch",
                  fields: ["visits", "lookouts", "perLookout"],
                },
              },
            ],
            params: [
              {
                name: "pickLookoutRegion",
                select: {
                  type: "point",
                  fields: ["branch"],
                  on: "click",
                  clear: "dblclick",
                },
              },
            ],
            mark: { type: "geoshape", stroke: "white", cursor: "pointer" },
            encoding: {
              color: Object.assign({}, crowdColour, {
                legend: {
                  orient: "bottom",
                  direction: "horizontal",
                  format: "~s",
                  titleLimit: 200,
                },
              }),
              strokeWidth: {
                condition: {
                  param: "pickLookoutRegion",
                  empty: false,
                  value: 2.5,
                },
                value: 0.8,
              },
              fillOpacity: {
                condition: {
                  param: "pickLookoutRegion",
                  empty: true,
                  value: 1,
                },
                value: 0.35,
              },
              tooltip: [
                { field: "branch", title: "NPWS region" },
                { field: "lookouts", title: "Lookouts" },
                {
                  field: "visits",
                  title: "Park visits (2024/25)",
                  format: ",",
                },
                {
                  field: "perLookout",
                  title: "Visits per lookout",
                  format: ",.0f",
                },
              ],
            },
          },

          // one dot per lookout, coloured by type
          {
            data: { values: points },
            params: [
              {
                name: "pickType",
                select: { type: "point", fields: ["type"] },
                bind: "legend",
              },
            ],
            mark: {
              type: "circle",
              size: 16,
              stroke: "white",
              strokeWidth: 0.4,
            },
            encoding: {
              longitude: { field: "lon", type: "quantitative" },
              latitude: { field: "lat", type: "quantitative" },
              fill: {
                field: "type",
                type: "nominal",
                title: "Lookout type (click to filter)",
                scale: {
                  domain: LOOKOUT_TYPES.map(function (t) {
                    return t.type;
                  }),
                  range: LOOKOUT_TYPES.map(function (t) {
                    return t.color;
                  }),
                },
                legend: {
                  orient: "bottom",
                  direction: "horizontal",
                  titleLimit: 220,
                },
              },
              opacity: {
                // bright only if its type AND its region are picked (or nothing is picked yet)
                condition: {
                  test: {
                    and: [
                      { param: "pickType" },
                      { param: "pickLookoutRegion" },
                    ],
                  },
                  value: 0.9,
                },
                value: 0.06,
              },
              tooltip: [
                { field: "name", title: "Lookout" },
                { field: "type", title: "Type" },
                { field: "park", title: "Park" },
                { field: "branch", title: "NPWS region" },
              ],
            },
          },

          // a few places to find your way
          {
            data: {
              values: cities.filter(function (c) {
                return c.name !== "Wollongong";
              }),
            },
            mark: {
              type: "text",
              align: "left",
              dx: 6,
              dy: -4,
              fontSize: 10,
              fontStyle: "italic",
              fontWeight: "bold",
              color: "#3d3d3d",
            },
            encoding: {
              longitude: { field: "lon", type: "quantitative" },
              latitude: { field: "lat", type: "quantitative" },
              text: { field: "name", type: "nominal" },
            },
          },
        ],
      },

      // ---------------- RIGHT: visits per lookout by region ----------------
      {
        width: 250,
        height: 480,
        title: {
          text: "Park visits per lookout",
          subtitle: "Each region's visits ÷ its lookouts",
          anchor: "start",
          fontSize: 13,
          subtitleFontSize: 11,
        },
        data: {
          values: regions.filter(function (r) {
            return r.lookouts > 0;
          }),
        },
        encoding: {
          y: {
            field: "branch",
            type: "nominal",
            sort: "-x",
            title: null,
            axis: { labelLimit: 140 },
          },
          x: {
            field: "perLookout",
            type: "quantitative",
            title: "Visits per lookout (2024/25)",
            axis: { format: "~s", tickCount: 4 },
          },
        },
        layer: [
          {
            mark: {
              type: "bar",
              cornerRadiusEnd: 3,
              stroke: "#c9bfa5",
              strokeWidth: 0.6,
            },
            encoding: {
              color: Object.assign({}, crowdColour, { legend: null }),
              opacity: { condition: regionPickedHere, value: 0.25 },
              tooltip: [
                { field: "branch", title: "NPWS region" },
                { field: "lookouts", title: "Lookouts" },
                {
                  field: "visits",
                  title: "Park visits (2024/25)",
                  format: ",",
                },
                {
                  field: "perLookout",
                  title: "Visits per lookout",
                  format: ",.0f",
                },
              ],
            },
          },
          {
            mark: {
              type: "text",
              align: "left",
              dx: 4,
              fontSize: 10,
              color: "#6b6b6b",
            },
            encoding: {
              text: { field: "lookoutsLabel", type: "nominal" },
              opacity: { condition: regionPickedHere, value: 0.3 },
            },
            transform: [
              {
                calculate: "datum.lookouts + ' lookouts'",
                as: "lookoutsLabel",
              },
            ],
          },
        ],
      },
    ],
  };
}

// =====================================================================
// Sections 5-7: simple first versions (default look, real data)
//   Style these later, the same way as sections 1-4.
// =====================================================================

// 5a. Where visitors live (2024/25)
const originChart = {
  $schema: SCHEMA,
  width: "container",
  height: 300,
  data: { url: "data/visitor_origin_2024_25.csv" },
  transform: [
    {
      calculate:
        "datum.group == 'Intrastate' ? 'Local' : datum.group == 'Interstate' ? 'Non-local' : datum.group",
      as: "group",
    },
    { filter: "datum.group_type != 'Overall'" },
  ],
  mark: "bar",
  encoding: {
    y: { field: "origin", type: "nominal", sort: "-x", title: null },
    x: {
      field: "total_visits",
      type: "quantitative",
      title: "Visits (2024/25)",
      axis: { format: "~s" },
    },
    color: { field: "group", type: "nominal", title: "Visitor from" },
    tooltip: [
      { field: "origin", title: "Lives in" },
      { field: "total_visits", title: "Visits", format: "," },
    ],
  },
};

// 5b. How much the park was the reason for the trip
const tripRoleChart = {
  $schema: SCHEMA,
  width: "container",
  height: 260,
  data: { url: "data/trip_role_2024_25.csv" },
  transform: [
    { fold: ["intrastate_pct", "interstate_pct"], as: ["visitor", "pct"] },
    {
      calculate: "datum.visitor == 'intrastate_pct' ? 'Local' : 'Non-local'",
      as: "visitor",
    },
  ],
  mark: { type: "point", filled: true, size: 110 }, // dot plot: one dot per visitor group
  encoding: {
    y: { field: "role", type: "nominal", sort: null, title: "The park was..." },
    x: { field: "pct", type: "quantitative", title: "% of visitors" },
    color: { field: "visitor", type: "nominal", title: null },
    tooltip: [
      { field: "role", title: "The park was" },
      { field: "visitor", title: "Visitor" },
      { field: "pct", title: "% of visitors" },
    ],
  },
};

// 6a. Visits through the year (index: 100 = an average month)
//     NOTE: month order in this file is not checked yet (see the _CHECK in the name)
const monthlyChart = {
  $schema: SCHEMA,
  width: "container",
  height: 260,
  data: { url: "data/monthly_index_2024_25_CHECK.csv" },
  layer: [
    {
      mark: { type: "rule", strokeDash: [4, 4] },
      encoding: { y: { datum: 100 } },
    },
    {
      mark: { type: "line", point: true },
      encoding: {
        x: {
          field: "month",
          type: "ordinal",
          sort: null,
          title: null,
          axis: { labelAngle: 0 },
        },
        y: {
          field: "visit_index",
          type: "quantitative",
          title: "Visit index (100 = average month)",
          scale: { zero: false },
        },
        tooltip: [
          { field: "month", title: "Month" },
          { field: "visit_index", title: "Index" },
        ],
      },
    },
  ],
};

// 6b. How long a visit lasts
const durationChart = {
  $schema: SCHEMA,
  width: "container",
  height: 220,
  data: { url: "data/visit_duration_2024_25.csv" },
  transform: [
    { fold: ["intrastate_pct", "interstate_pct"], as: ["visitor", "pct"] },
    {
      calculate: "datum.visitor == 'intrastate_pct' ? 'Local' : 'Non-local'",
      as: "visitor",
    },
  ],
  mark: { type: "point", filled: true, size: 110 }, // dot plot: one dot per visitor group
  encoding: {
    y: { field: "duration", type: "nominal", sort: null, title: null },
    x: { field: "pct", type: "quantitative", title: "% of visitors" },
    color: { field: "visitor", type: "nominal", title: null },
    tooltip: [
      { field: "duration", title: "Visit length" },
      { field: "visitor", title: "Visitor" },
      { field: "pct", title: "% of visitors" },
    ],
  },
};

// 7a. Top 10 activities. The file only has the rank, not how many people,
//     so this shows the order only (no bar lengths).
const activitiesChart = {
  $schema: SCHEMA,
  width: "container",
  height: 300,
  data: { url: "data/top10_activities_2024_25.csv" },
  mark: { type: "point", filled: true, size: 120 },
  encoding: {
    y: {
      field: "activity",
      type: "nominal",
      sort: { field: "rank", order: "ascending" },
      title: null,
    },
    x: {
      field: "rank",
      type: "quantitative",
      title: "Rank (1 = most common)",
      scale: { domain: [1, 10], reverse: true },
      axis: { tickCount: 10 },
    },
    tooltip: [
      { field: "rank", title: "Rank" },
      { field: "activity", title: "Activity" },
    ],
  },
};

// 7b. Satisfaction by visitor group, with the overall level as a line
const satisfactionChart = {
  $schema: SCHEMA,
  width: "container",
  height: 240,
  data: { url: "data/satisfaction_2024_25.csv" },
  transform: [
    {
      calculate:
        "datum.group == 'Intrastate (NSW residents)' ? 'Local' : datum.group == 'Interstate' ? 'Non-local' : datum.group",
      as: "group",
    },
  ],
  layer: [
    {
      transform: [{ filter: "datum.group_type != 'Overall'" }],
      mark: "bar",
      encoding: {
        y: { field: "group", type: "nominal", sort: null, title: null },
        x: {
          field: "net_satisfied_pct",
          type: "quantitative",
          title: "Net satisfied (%)",
          scale: { domain: [0, 100] },
        },
        color: { field: "group_type", type: "nominal", title: "Group by" },
        tooltip: [
          { field: "group", title: "Group" },
          { field: "net_satisfied_pct", title: "Net satisfied (%)" },
        ],
      },
    },
    {
      transform: [{ filter: "datum.group_type == 'Overall'" }],
      mark: { type: "rule", strokeDash: [4, 4], color: "black" },
      encoding: { x: { field: "net_satisfied_pct", type: "quantitative" } },
    },
  ],
};

// =====================================================================
// Section 4: accessibility
//   4a. Waffle: 100 squares = all walking track, coloured by difficulty
//   4b. Track map coloured by difficulty + lookouts, with a dropdown
// =====================================================================

// Difficulty groups (NPWS track classes)
const DIFFICULTY = [
  { group: "Easy", classes: [1, 2], label: "Easy (Class 1–2)", color: TEAL },
  {
    group: "Moderate",
    classes: [3, 4],
    label: "Moderate (Class 3–4)",
    color: "#e9c46a",
  },
  { group: "Hard", classes: [5, 6], label: "Hard (Class 5–6)", color: CORAL },
];

// 3a. The waffle is built when the page loads, from tracks_by_class.csv
const WAFFLE_SIZE = 320;
async function buildWaffle() {
  const rows = await loadCSV("data/tracks_by_class.csv");

  // km per difficulty group (the 'Unknown' class is left out)
  const groups = DIFFICULTY.map(function (d) {
    const km = rows
      .filter(function (r) {
        return d.classes.includes(+r.class_num);
      })
      .reduce(function (sum, r) {
        return sum + +r.total_km;
      }, 0);
    return Object.assign({}, d, { km: km });
  });
  const totalKm = groups.reduce(function (sum, g) {
    return sum + g.km;
  }, 0);

  // turn shares into whole squares that add up to exactly 100
  groups.forEach(function (g) {
    g.exact = (g.km / totalKm) * 100;
    g.squares = Math.floor(g.exact);
  });
  let left =
    100 -
    groups.reduce(function (sum, g) {
      return sum + g.squares;
    }, 0);
  groups
    .slice()
    .sort(function (a, b) {
      return b.exact - b.squares - (a.exact - a.squares);
    })
    .forEach(function (g) {
      if (left > 0) {
        g.squares += 1;
        left -= 1;
      }
    });

  // one row per square, filled row by row from the top-left
  const squares = [];
  groups.forEach(function (g) {
    for (let i = 0; i < g.squares; i++) {
      const n = squares.length;
      squares.push({
        col: n % 10,
        row: Math.floor(n / 10),
        difficulty: g.label + ": " + g.squares + "%",
        km: Math.round(g.km),
      });
    }
  });

  return {
    $schema: SCHEMA,
    autosize: "pad", // fixed-size chart: keep its own size
    width: WAFFLE_SIZE,
    height: WAFFLE_SIZE,
    data: { values: squares },

    mark: {
      type: "square",
      size: Math.pow((WAFFLE_SIZE / 10) * 0.85, 2),
      stroke: "white",
      strokeWidth: 1.5,
    },
    encoding: {
      x: { field: "col", type: "ordinal", axis: null },
      y: { field: "row", type: "ordinal", axis: null },
      color: {
        field: "difficulty",
        type: "nominal",
        title: "Share of all walking track",
        scale: {
          domain: groups.map(function (g) {
            return g.label + ": " + g.squares + "%";
          }),
          range: groups.map(function (g) {
            return g.color;
          }),
        },
        legend: null, // the class key beside the chart is the legend
      },
      tooltip: [
        { field: "difficulty", title: "Difficulty" },
        { field: "km", title: "Total track (km)", format: "," },
      ],
    },
    view: { stroke: null },
  };
}

// 3b. Track difficulty in each of the 20 most visited parks
//     Built when the page loads from tracks.csv + park_points.csv + top20_parks_located.csv

// Some top-20 names cover several NPWS reserves
const PARK_ALIASES = {
  "Worimi Conservation Lands": ["Worimi NP", "Worimi RP", "Worimi SCA"],
};

let parkDifficultyCache = null;
function parkDifficulty() {
  if (!parkDifficultyCache) {
    parkDifficultyCache = Promise.all([
      loadCSV("data/tracks.csv"),
      loadCSV("data/park_points.csv"),
      loadCSV("data/top20_parks_located.csv"),
    ]).then(function ([tracks, parkPoints, top20]) {
      // full park name -> short name used in tracks.csv
      const shortName = {};
      parkPoints.forEach(function (p) {
        shortName[p.park] = p.park_short;
      });

      // km of track per park per difficulty group
      const km = {};
      tracks.forEach(function (t) {
        const c = +t.class_num;
        if (!c) return;
        const group = DIFFICULTY.find(function (d) {
          return d.classes.includes(c);
        });
        km[t.park] = km[t.park] || {};
        km[t.park][group.label] = (km[t.park][group.label] || 0) + +t.length_km;
      });

      const parks = top20
        .map(function (p) {
          const shorts = PARK_ALIASES[p.park] || [shortName[p.park_full]];
          const byGroup = {};
          DIFFICULTY.forEach(function (d) {
            byGroup[d.label] = shorts.reduce(function (sum, s) {
              return sum + ((km[s] || {})[d.label] || 0);
            }, 0);
          });
          const total = Object.values(byGroup).reduce(function (a, b) {
            return a + b;
          }, 0);
          return {
            park: p.park,
            rank: +p.rank,
            visits: +p.visits_2024_25,
            byGroup: byGroup,
            total: total,
            shorts: shorts,
          };
        })
        .filter(function (p) {
          return p.total > 0;
        });

      return parks;
    });
  }
  return parkDifficultyCache;
}

async function buildParkDifficulty() {
  const parks = await parkDifficulty();
  const rows = [];
  parks.forEach(function (p) {
    DIFFICULTY.forEach(function (d, i) {
      rows.push({
        park: p.park,
        rank: p.rank,
        difficulty: d.label,
        order: i,
        km: Math.round(p.byGroup[d.label] * 10) / 10,
        share: p.byGroup[d.label] / p.total,
        totalKm: Math.round(p.total),
      });
    });
  });

  return {
    $schema: SCHEMA,
    width: "container",
    height: PAIR_HEIGHT, // same height as the map beside it
    data: { values: rows },
    params: [
      // clicking a bar
      {
        name: "pickPark",
        select: { type: "point", fields: ["park"], on: "click", clear: false },
      },
      // the park currently on the map (set by the dropdown); "" = none
      { name: "highlightPark", value: "" },
    ],
    mark: { type: "bar", height: { band: 0.75 }, cursor: "pointer" },
    encoding: {
      y: {
        field: "park",
        type: "nominal",
        title: null,
        sort: { field: "rank", op: "min", order: "ascending" },
        axis: { labelFontSize: 11, labelLimit: 150 },
      },
      x: {
        field: "km",
        type: "quantitative",
        stack: "normalize",
        title: "Share of the park's walking track",
        axis: { format: "%", tickCount: 4 },
      },
      color: {
        field: "difficulty",
        type: "nominal",
        title: null,
        scale: {
          domain: DIFFICULTY.map(function (d) {
            return d.label;
          }),
          range: DIFFICULTY.map(function (d) {
            return d.color;
          }),
        },
        legend: {
          orient: "top",
          direction: "horizontal",
          labelFontSize: 11,
          symbolSize: 80,
          labelExpr: "split(datum.label, ' (')[0]",
        }, // "Easy (Class 1–2)" -> "Easy"
      },
      order: { field: "order", type: "quantitative" },
      opacity: {
        condition: {
          test: "highlightPark == '' || datum.park == highlightPark",
          value: 1,
        },
        value: 0.3,
      },
      tooltip: [
        { field: "park", title: "Park" },
        { field: "rank", title: "Visit rank" },
        { field: "difficulty", title: "Difficulty" },
        { field: "km", title: "Track (km)", format: ",.1f" },
        { field: "share", title: "Share of park's track", format: ".0%" },
        { field: "totalKm", title: "Park's total track (km)" },
      ],
    },
  };
}

// =====================================================================
// 3c. Trail map for ONE park at a time
//     Pick a park in the dropdown (or click its bar above) and the map
//     zooms to that park: outline, tracks by difficulty, lookouts.
// =====================================================================
async function buildParkMap(parkName) {
  const parks = await parkDifficulty();
  const park =
    parks.find(function (p) {
      return p.park === parkName;
    }) || parks[0];
  const isThisPark = function (f) {
    return park.shorts.includes(f.properties.park_short || f.properties.park);
  };

  const [allParks, tracks, land, lookouts] = await Promise.all([
    loadFeatures("data/parks.geojson"),
    loadFeatures("data/tracks.geojson"),
    loadFeatures("data/nsw.json"),
    loadCSV("data/lookouts.csv"),
  ]);

  const outline = allParks.filter(function (f) {
    return park.shorts.includes(f.properties.park_short);
  });
  const parkTracks = tracks.filter(function (f) {
    return park.shorts.includes(f.properties.park);
  });
  const parkLookouts = lookouts.filter(function (r) {
    return r.type !== "Other" && park.shorts.includes(r.park);
  });

  // frame = the park's outline plus a 10% margin
  const xs = [],
    ys = [];
  outline.forEach(function (f) {
    f.geometry.coordinates.forEach(function (poly) {
      poly[0].forEach(function (pt) {
        xs.push(pt[0]);
        ys.push(pt[1]);
      });
    });
  });
  const padX =
    (Math.max.apply(null, xs) - Math.min.apply(null, xs)) * 0.1 + 0.01;
  const padY =
    (Math.max.apply(null, ys) - Math.min.apply(null, ys)) * 0.1 + 0.01;
  const box = {
    west: Math.min.apply(null, xs) - padX,
    east: Math.max.apply(null, xs) + padX,
    south: Math.min.apply(null, ys) - padY,
    north: Math.max.apply(null, ys) + padY,
  };

  // the map's drawing area = its box minus Vega's padding on each side
  const mapEl = document.getElementById("park_map");
  const width = Math.max(
    200,
    ((mapEl && mapEl.clientWidth) || 500) - 2 * VEGA_PADDING,
  );
  const height = PAIR_HEIGHT - 2 * VEGA_PADDING;

  // widen the frame to the map's shape, so land fills the whole view
  // (otherwise the empty sides look like sea)
  const mercY = function (lat) {
    return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  };
  const latFromY = function (y) {
    return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
  };
  const boxW = ((box.east - box.west) * Math.PI) / 180;
  const boxH = mercY(box.north) - mercY(box.south);
  const wanted = width / height;
  if (boxW / boxH < wanted) {
    // too narrow: add longitude on both sides
    const extra = (((boxH * wanted - boxW) / 2) * 180) / Math.PI;
    box.west -= extra;
    box.east += extra;
  } else {
    // too wide: add latitude top and bottom
    const extra = (boxW / wanted - boxH) / 2;
    box.north = latFromY(mercY(box.north) + extra);
    box.south = latFromY(mercY(box.south) - extra);
  }

  // land and neighbouring parks, cut to the frame so the map zooms to this park
  const clip = function (features) {
    return features
      .map(function (f) {
        return clipFeatureToBox(f, box);
      })
      .filter(function (f) {
        return f;
      });
  };
  const landHere = clip(land);
  const otherParksHere = clip(
    allParks.filter(function (f) {
      return !outline.includes(f);
    }),
  );

  // summary line above the map
  const summary = document.getElementById("park_summary");
  if (summary) {
    summary.textContent =
      fmt.commas(park.total) +
      " km of track, " +
      parkLookouts.length +
      " lookout" +
      (parkLookouts.length === 1 ? "" : "s");
  }

  return {
    $schema: SCHEMA,
    width: "container",
    height: PAIR_HEIGHT, // same height as the bar chart beside it
    projection: { type: "mercator" },
    view: { fill: STYLE.sea, stroke: null },
    layer: [
      // invisible rectangle = the frame, so every park is framed the same way
      // (corners listed clockwise: SW, NW, NE, SE)
      {
        data: {
          values: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [box.west, box.south],
                    [box.west, box.north],
                    [box.east, box.north],
                    [box.east, box.south],
                    [box.west, box.south],
                  ],
                ],
              },
            },
          ],
        },
        mark: { type: "geoshape", fill: STYLE.sea, stroke: null },
      },
      {
        data: { values: landHere },
        mark: { type: "geoshape", fill: STYLE.land, stroke: null },
      },
      {
        data: { values: otherParksHere },
        mark: {
          type: "geoshape",
          fill: STYLE.park,
          stroke: null,
          opacity: 0.5,
        },
      },
      {
        data: { values: outline },
        mark: {
          type: "geoshape",
          fill: STYLE.park,
          stroke: GREEN_DARK,
          strokeWidth: 1.2,
        },
        encoding: { tooltip: [{ field: "properties.park", title: "Park" }] },
      },

      // tracks by difficulty
      {
        data: { values: parkTracks },
        transform: [
          { filter: "isValid(datum.properties.class_num)" },
          {
            calculate:
              "datum.properties.class_num <= 2 ? 'Easy (Class 1–2)' : datum.properties.class_num <= 4 ? 'Moderate (Class 3–4)' : 'Hard (Class 5–6)'",
            as: "difficulty",
          },
        ],
        mark: {
          type: "geoshape",
          filled: false,
          strokeWidth: 3,
          strokeCap: "round",
          strokeJoin: "round",
        },
        encoding: {
          color: {
            field: "difficulty",
            type: "nominal",
            title: null,
            scale: {
              domain: DIFFICULTY.map(function (d) {
                return d.label;
              }),
              range: DIFFICULTY.map(function (d) {
                return d.color;
              }),
            },
            legend: null, // same colours as the bar chart legend beside it
          },
          tooltip: [
            { field: "properties.name", title: "Track" },
            { field: "properties.class", title: "Class" },
            {
              field: "properties.length_km",
              title: "Length (km)",
              format: ".2f",
            },
          ],
        },
      },

      // lookouts
      {
        data: { values: parkLookouts },
        mark: {
          type: "point",
          shape: "triangle-up",
          size: 70,
          filled: true,
          color: GREEN_DARK,
          stroke: "white",
          strokeWidth: 1,
        },
        encoding: {
          longitude: { field: "lon", type: "quantitative" },
          latitude: { field: "lat", type: "quantitative" },
          tooltip: [
            { field: "name", title: "Lookout" },
            { field: "type", title: "Type" },
          ],
        },
      },
    ],
  };
}

let parkBarsView = null; // the park bar chart, once it has been drawn

// Both charts on the shared canvas are exactly this tall (including Vega's padding)
const PAIR_HEIGHT = 500;
const VEGA_PADDING = 16;

function highlightBar(parkName) {
  if (parkBarsView) parkBarsView.signal("highlightPark", parkName).run();
}

function drawParkMap(parkName) {
  highlightBar(parkName);
  return buildParkMap(parkName)
    .then(function (spec) {
      return vegaEmbed("#park_map", spec, {
        actions: false,
        config: chartTheme,
      });
    })
    .catch(function (err) {
      console.error("#park_map", err);
      document.querySelector("#park_map").innerHTML =
        "<p style='color:#b3261e'>Chart error: " + err.message + "</p>";
    });
}

// Fill the dropdown with the top-20 parks, busiest first, and draw the first one
async function setUpParkMap() {
  const select = document.getElementById("park_select");
  if (!select) return;
  const parks = (await parkDifficulty()).slice().sort(function (a, b) {
    return a.rank - b.rank;
  });
  parks.forEach(function (p) {
    const option = document.createElement("option");
    option.value = p.park;
    option.textContent = p.rank + ". " + p.park;
    select.appendChild(option);
  });
  select.addEventListener("change", function () {
    drawParkMap(select.value);
  });
  select.value = parks[0].park;
  drawParkMap(parks[0].park);
}

// Clicking a bar in the park chart picks that park on the map (and the dropdown)
function linkBarsToParkMap(view) {
  parkBarsView = view;
  const select = document.getElementById("park_select");
  if (select && select.value) highlightBar(select.value); // match whatever the map already shows

  view.addSignalListener("pickPark", function (name, value) {
    const picked = value && value.park;
    const parkName = Array.isArray(picked) ? picked[0] : picked;
    const select = document.getElementById("park_select");
    if (!parkName || !select) return;
    select.value = parkName;
    drawParkMap(parkName);
    document
      .getElementById("park_map")
      .scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// =====================================================================
// Draw the charts into their divs
// To add a chart: write a spec above, add a <div id="..."> in index.html,
// then add one line here.
// =====================================================================
const charts = {
  "#bar_chart": visitsChart,
  "#regions_map": regionsMap,
  "#share_maps": buildShareMaps, // built from the data when the page loads
  "#lookout_map": buildLookoutMap, // built from the data when the page loads
  "#origin_chart": originChart,
  "#trip_role_chart": tripRoleChart,
  "#monthly_chart": monthlyChart,
  "#duration_chart": durationChart,
  "#activities_chart": activitiesChart,
  "#satisfaction_chart": satisfactionChart,
  "#track_waffle": buildWaffle, // built from the data when the page loads
  "#park_difficulty": buildParkDifficulty, // built from the data when the page loads
};

// Fonts and text colours for every chart, matched to the page
const chartTheme = {
  font: "Inter, system-ui, sans-serif",
  axis: {
    labelColor: "#6b6b6b",
    titleColor: "#2b2b2b",
    gridColor: "#ecebe4",
    domainColor: "#bbb",
    tickColor: "#bbb",
  },
  legend: { labelColor: "#6b6b6b", titleColor: "#2b2b2b" },
  title: { font: "Fraunces, Georgia, serif", fontSize: 16, color: "#1f3d17" },
  view: { stroke: null },
  background: "#fffdf6", // same colour as the printed-plate frame
  padding: 16, // breathing room inside the frame
  autosize: { type: "fit", contains: "padding" }, // width "container" includes that padding
};

for (const [divId, chart] of Object.entries(charts)) {
  Promise.resolve(typeof chart === "function" ? chart() : chart)
    .then(prepareSpec)
    .then(function (fixedSpec) {
      return vegaEmbed(divId, fixedSpec, {
        actions: false,
        config: chartTheme,
      });
    })
    .then(function (result) {
      if (divId === "#park_difficulty" && result)
        linkBarsToParkMap(result.view);
    })
    .catch(function (err) {
      console.error(divId, err);
      document.querySelector(divId).innerHTML =
        "<p style='color:#b3261e'>Chart error: " + err.message + "</p>";
    });
}

// =====================================================================
// Page numbers: calculated from the data files, not typed in by hand.
// In index.html, any <span data-stat="name"> gets its text replaced
// with the value calculated below. The text already in the HTML is only
// a fallback, shown if a file fails to load.
// =====================================================================

// Reads a CSV file into a list of rows ({ column: value })
async function loadCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " not found");
  const text = (await res.text()).replace(/^\uFEFF/, "").replace(/\r/g, "");
  const lines = text.split("\n").filter(function (line) {
    return line.trim() !== "";
  });
  const split = function (line) {
    // handles "quoted, values"
    const out = [];
    let cur = "";
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]);
  return lines.slice(1).map(function (line) {
    const cells = split(line);
    const row = {};
    header.forEach(function (h, i) {
      row[h] = cells[i];
    });
    return row;
  });
}

// Number formats
const fmt = {
  millionsShort: function (n) {
    return (n / 1e6).toFixed(1) + "M";
  }, // 65.6M
  millionsWords: function (n) {
    return (n / 1e6).toFixed(1) + " million";
  }, // 65.6 million
  roughMillions: function (n) {
    return Math.round(n / 1e6) + " million";
  }, // 10 million
  percent: function (x) {
    return Math.round(x * 100) + "%";
  }, // 43%
  commas: function (n) {
    return Math.round(n).toLocaleString("en-AU");
  }, // 2,700
};

async function calculatePageNumbers() {
  const parks = (await parkDifficulty()).filter(function (p) {
    return p.total >= 5;
  }); // ignore parks with under 5 km of track
  const shareOf = function (p, label) {
    return p.byGroup[label] / p.total;
  };
  const easiest = parks.slice().sort(function (a, b) {
    return shareOf(b, DIFFICULTY[0].label) - shareOf(a, DIFFICULTY[0].label);
  })[0];
  const hardest = parks.slice().sort(function (a, b) {
    return shareOf(b, DIFFICULTY[2].label) - shareOf(a, DIFFICULTY[2].label);
  })[0];
  const busiest = parks.slice().sort(function (a, b) {
    return a.rank - b.rank;
  })[0];

  const [
    years,
    lookouts,
    trackClasses,
    satisfaction,
    branches,
    top20,
    shareByYear,
    lookoutsWhere,
  ] = await Promise.all([
    loadCSV("data/visits_by_year.csv"),
    loadCSV("data/lookouts.csv"),
    loadCSV("data/tracks_by_class.csv"),
    loadCSV("data/satisfaction_2024_25.csv"),
    loadCSV("data/branch_visits_2024_25.csv"),
    loadCSV("data/top20_parks_located.csv"),
    loadCSV("data/branch_share_by_year.csv"),
    lookoutRegions(),
  ]);

  // Section 2b: Greater Sydney's share in the first and latest survey
  const sydneyShares = shareByYear.filter(function (r) {
    return r.branch === "Greater Sydney";
  });
  const sydneyFirst = sydneyShares[0];
  const sydneyLast = sydneyShares[sydneyShares.length - 1];

  // Section 3: lookouts per region, and visits per lookout
  const withLookouts = lookoutsWhere.regions.filter(function (r) {
    return r.lookouts > 0;
  });
  const byCount = withLookouts.slice().sort(function (a, b) {
    return b.lookouts - a.lookouts;
  });
  const byCrowd = withLookouts.slice().sort(function (a, b) {
    return b.perLookout - a.perLookout;
  });
  const mostCrowded = byCrowd[0];
  const leastCrowded = byCrowd[byCrowd.length - 1];
  const roundTo = function (n, step) {
    return fmt.commas(Math.round(n / step) * step);
  };
  const typeCount = function (type) {
    return lookoutsWhere.points.filter(function (p) {
      return p.type === type;
    }).length;
  };

  const first = years[0];
  const latest = years[years.length - 1];
  const visitsIn = function (year) {
    const row = years.find(function (r) {
      return r.year === year;
    });
    return row ? +row.total_visits : NaN;
  };

  const kmFor = function (classes) {
    return trackClasses
      .filter(function (r) {
        return classes.includes(+r.class_num);
      })
      .reduce(function (sum, r) {
        return sum + +r.total_km;
      }, 0);
  };
  const gradedKm = kmFor([1, 2, 3, 4, 5, 6]);

  const realLookouts = lookouts.filter(function (r) {
    return r.type !== "Other";
  }); // "Other" = camping platforms
  const trackKm = trackClasses.reduce(function (sum, r) {
    return sum + (+r.total_km || 0);
  }, 0);
  const overall = satisfaction.find(function (r) {
    return r.group === "Overall";
  });
  const totalBranchVisits = branches.reduce(function (sum, r) {
    return sum + +r.visits;
  }, 0);
  const sydney = branches.find(function (r) {
    return r.branch === "Greater Sydney";
  });

  return {
    firstYear: first.year,
    latestYear: latest.year,
    visitsLatest: fmt.millionsShort(+latest.total_visits),
    visitsLatestWords: fmt.millionsWords(+latest.total_visits),
    firstVisitsWords: fmt.millionsWords(+first.total_visits),
    growth: fmt.percent(+latest.total_visits / +first.total_visits - 1),
    covidDrop: fmt.roughMillions(visitsIn("2018") - visitsIn("2020")),
    lookouts: fmt.commas(realLookouts.length),
    trackKm: fmt.commas(Math.round(trackKm / 100) * 100), // nearest 100 km
    satisfied: overall.net_satisfied_pct + "%",
    easyShare: fmt.percent(kmFor([1, 2]) / gradedKm),
    easyKm: fmt.commas(kmFor([1, 2])),
    class1Km: fmt.commas(kmFor([1])),
    moderateShare: fmt.percent(kmFor([3, 4]) / gradedKm),
    hardShare: fmt.percent(kmFor([5, 6]) / gradedKm),
    easiestPark: easiest.park,
    easiestShare: fmt.percent(shareOf(easiest, DIFFICULTY[0].label)),
    hardestPark: hardest.park,
    hardestShare: fmt.percent(shareOf(hardest, DIFFICULTY[2].label)),
    busiestPark: busiest.park,
    busiestHard: fmt.percent(shareOf(busiest, DIFFICULTY[2].label)),
    busiestEasy: fmt.percent(shareOf(busiest, DIFFICULTY[0].label)),
    sydneyVisits: fmt.roughMillions(+sydney.visits),
    sydneyShareFirstYear: sydneyFirst.year,
    sydneyShareFirst: Math.round(+sydneyFirst.share_pct) + "%",
    sydneyShareLast: Math.round(+sydneyLast.share_pct) + "%",
    platformShare: fmt.percent(
      typeCount("Viewing platform") / lookoutsWhere.points.length,
    ),
    onGroundShare: fmt.percent(
      typeCount("On-ground lookout") / lookoutsWhere.points.length,
    ),
    mostLookoutsRegion: byCount[0].branch,
    mostLookouts: String(byCount[0].lookouts),
    sydneyLookouts: String(
      (
        withLookouts.find(function (r) {
          return r.branch === "Greater Sydney";
        }) || {}
      ).lookouts,
    ),
    crowdedRegion: mostCrowded.branch,
    crowdedPerLookout: roundTo(mostCrowded.perLookout, 1000),
    quietRegion: leastCrowded.branch,
    quietPerLookout: roundTo(leastCrowded.perLookout, 1000),
    crowdRatio: String(
      Math.round(mostCrowded.perLookout / leastCrowded.perLookout),
    ),
    sydneyShare: fmt.percent(+sydney.visits / totalBranchVisits),
    // undefined (= keep the typed-in value) if the CSV has no branch column yet
    sydneyTop20:
      "branch" in top20[0]
        ? String(
            top20.filter(function (r) {
              return r.branch === "Greater Sydney";
            }).length,
          )
        : undefined,
  };
}

calculatePageNumbers()
  .then(function (stats) {
    document.querySelectorAll("[data-stat]").forEach(function (el) {
      const value = stats[el.dataset.stat];
      if (value !== undefined && !String(value).includes("NaN"))
        el.textContent = value;
    });
  })
  .catch(function (err) {
    console.warn(
      "Page numbers not updated (showing the typed-in values instead):",
      err.message,
    );
  });

setUpParkMap();

// Re-frame the park map when the window changes size (its shape changes)
let resizeTimer = null;
window.addEventListener("resize", function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    const select = document.getElementById("park_select");
    if (select && select.value) drawParkMap(select.value);
  }, 250);
});
