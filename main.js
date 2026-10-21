const CHARTS = {
  "#bar_chart": "1_park_visits_per_survey_year",
  "#regions_map": "2_top_20_parks_and_lookouts",
  "#lookout_map": "3_park_visits_per_lookout",
  "#share_maps": "3.2_share_of_park_visits_by_region",
  "#track_waffle": "4.1_walking_track_by_difficulty",
  "#park_difficulty": "4.2_track_difficulty_in_top_20_parks",
  "#flow_map": "5.1_interstate_flow_map",
  "#intl_isotype": "5.2_international_isotype",
  "#intl_map": "5.3_international_visitors_map",
  "#profile_mosaic": "5.4_visitor_profile_mosaic",
  "#profile_bars": "5.4b_visitor_profile_bars",
  "#profile_bars2": "5.4c_v_p_b",
  "#monthly_chart": "6.1_visits_through_the_year",
  "#satisfaction_chart": "7.2_visitor_satisfaction",
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

for (const [divId, name] of Object.entries(CHARTS)) {
  vegaEmbed(divId, chartFile(name), OPTIONS)
    .then((result) => {
      if (divId === "#regions_map") linkParkInfo(result.view);
      if (divId === "#park_difficulty") linkBarsToParkMap(result.view);
    })
    .catch((err) => showError(divId, err));
}

// Clicking a park(map/bar) shows it in the panel under the chart.
// numbers from park_info.json
// Photo n description come from park_details.json
const parkInfo = loadJSON("data/park_info.json");
const parkDetails = loadJSON("data/park_details.json").catch(() => ({}));
const panel = document.getElementById("park_info");
const EMPTY_PANEL = panel ? panel.innerHTML : "";

const escapeHTML = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const formatNumber = (n) => Math.round(n).toLocaleString("en-AU");

async function showParkInfo(park) {
  if (!panel) return;
  // the map selects by full name (park_full), the old version by short name (park): accept both
  const info = (await parkInfo).find((p) => p.park === park || p.park_full === park);
  if (!info) {
    panel.innerHTML = EMPTY_PANEL; // nothing picked (double-click)
    return;
  }
  const extra = (await parkDetails)[info.park] || {};
  const photo = extra.image
    ? `<figure><img src="${escapeHTML(extra.image)}" alt="${escapeHTML(info.park_full)}" loading="lazy" referrerpolicy="no-referrer">` +
    (extra.image_credit ? `<figcaption>${escapeHTML(extra.image_credit)}</figcaption>` : "") +
    `</figure>`
    : "";
  const stat = (label, value) => (value === null || value === undefined ? "" : `<div><dt>${label}</dt><dd>${value}</dd></div>`);

  panel.innerHTML = `
    <div class="park-info-body${photo ? "" : " no-photo"}">
      ${photo}
      <div>
        <h3>${info.rank}. ${escapeHTML(info.park_full)}</h3>
        <p class="park-info-region">${escapeHTML(info.branch)} region</p>
        ${extra.description ? `<p class="park-info-text">${escapeHTML(extra.description)}</p>` : ""}
        <dl class="park-info-stats">
          ${stat("Visits (2024/25)", formatNumber(info.visits))}
          ${stat("Lookouts", info.lookouts)}
          ${stat("Walking track", info.track_km === null ? null : `${formatNumber(info.track_km)} km`)}
          ${stat("Easy track", info.easy_pct === null ? null : `${info.easy_pct}%`)}
          ${stat("Hard track", info.hard_pct === null ? null : `${info.hard_pct}%`)}
        </dl>
        <button type="button" class="park-info-link">See its tracks on the map ↓</button>
      </div>
    </div>`;
  // no photo file = no photo and card use the full width
  const img = panel.querySelector("img");
  if (img) {
    img.addEventListener("error", () => {
      img.closest("figure").remove();
      panel.querySelector(".park-info-body").classList.add("no-photo");
    });
  }

  panel.querySelector(".park-info-link").addEventListener("click", () => {
    drawParkMap(info.park);
    document.getElementById("park_map").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function linkParkInfo(view) {
  view.addSignalListener("pickPark", (name, value) => {
    const picked = value && (value.park_full || value.park);
    showParkInfo(Array.isArray(picked) ? picked[0] : picked);
  });
}

// ---------------------------------------------------------------- park map (Section 4)
// The dropdown, the difficulty bars and the map all show the same park.
let parkBarsView = null;
const parkMapSpec = loadJSON(chartFile("4.2_park_track_map"));
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