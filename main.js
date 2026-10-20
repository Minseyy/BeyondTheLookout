const CHARTS = {
  "#bar_chart": "1_park_visits_per_survey_year",
  "#regions_map": "top_20_parks_by_region",
  "#share_maps": "share_of_park_visits_by_region",
  "#lookout_map": "3_park_visits_per_lookout",
  "#track_waffle": "walking_track_by_difficulty",
  "#park_difficulty": "track_difficulty_in_top_20_parks",
  "#origin_chart": "5.1_where_visitors_live",
  "#trip_role_chart": "5.2_role_of_the_park_in_the_trip",
  "#monthly_chart": "visits_through_the_year",
  "#duration_chart": "length_of_visit",
  "#activities_chart": "top_10_activities",
  "#satisfaction_chart": "visitor_satisfaction",
};
const chartFile = (name) => `charts/${name}.vg.json`;

// Fonts & colours for every chart
const OPTIONS = {
  actions: false,
  config: {
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
    background: "#f7f2e4",
    padding: 16,
    autosize: { type: "fit", contains: "padding" }, // "container" width includes the padding
  },
};

function showError(divId, err) {
  console.error(divId, err);
  document.querySelector(divId).innerHTML = `<p style="color:#b3261e">Chart error: ${err.message}</p>`;
}

const loadJSON = (url) => fetch(url).then((res) => res.json());

// draw the charts
for (const [divId, name] of Object.entries(CHARTS)) {
  vegaEmbed(divId, chartFile(name), OPTIONS)
    .then((result) => {
      if (divId === "#park_difficulty") linkBarsToParkMap(result.view);
    })
    .catch((err) => showError(divId, err));
}

// ---------------------------------------------------------------- park map (Section 4)
// The dropdown, the difficulty bars and the map all show the same park.
let parkBarsView = null;
const parkMapSpec = loadJSON(chartFile("park_track_map"));
const parkList = loadJSON("data/park_list.json"); // [{ park, rank, summary }]
const parkSelect = document.getElementById("park_select");

async function drawParkMap(park) {
  if (parkBarsView) parkBarsView.signal("highlightPark", park).run(); // dim the other bars
  parkSelect.value = park;

  const info = (await parkList).find((p) => p.park === park);
  const summary = document.getElementById("park_summary");
  if (summary && info) summary.textContent = info.summary;

  // copy the spec and set which park it shows
  const spec = structuredClone(await parkMapSpec);
  spec.params.find((p) => p.name === "park").value = park;
  return vegaEmbed("#park_map", spec, OPTIONS).catch((err) => showError("#park_map", err));
}

// Clicking a bar shows that park on the map
function linkBarsToParkMap(view) {
  parkBarsView = view;
  if (parkSelect && parkSelect.value) view.signal("highlightPark", parkSelect.value).run();
  view.addSignalListener("pickPark", (name, value) => {
    const picked = value && value.park;
    const park = Array.isArray(picked) ? picked[0] : picked;
    if (!park) return;
    drawParkMap(park);
    document.getElementById("park_map").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// Fill the dropdown (busiest park first) and draw the first park
if (parkSelect) {
  parkList.then((parks) => {
    parks.forEach((p) => parkSelect.add(new Option(`${p.rank}. ${p.park}`, p.park)));
    parkSelect.addEventListener("change", () => drawParkMap(parkSelect.value));
    drawParkMap(parks[0].park);
  });
}

// ---------------------------------------------------------------- numbers in the page text
// Every <span data-stat="name"> gets its value from page_numbers.json.
// The text typed into index.html is only a fallback.
loadJSON("data/page_numbers.json")
  .then((stats) => {
    document.querySelectorAll("[data-stat]").forEach((el) => {
      if (stats[el.dataset.stat] !== undefined) el.textContent = stats[el.dataset.stat];
    });
  })
  .catch((err) => console.warn("Page numbers not updated (showing the typed-in values):", err.message));
