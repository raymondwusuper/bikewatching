import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// ── Replace with your Mapbox public token from https://account.mapbox.com ──
mapboxgl.accessToken = 'pk.eyJ1IjoicmF5bW9uZHd1IiwiYSI6ImNtcDY2cXg2ZDFpN2YycnEwNG9ibGs5engifQ.zQSRIlGV3qe2DDoyjyeX0A';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

const svg = d3.select('#map').select('svg');
const tooltip = document.getElementById('tooltip');

// Quantize scale: maps departure ratio [0,1] → discrete {0, 0.5, 1}
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// Radius scale (updated range when filtering is active)
const radiusScale = d3.scaleSqrt().range([0, 25]);

// Pre-bucketed trips by minute of day for fast time filtering
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute   = Array.from({ length: 1440 }, () => []);

let timeFilter = -1;
let circles;   // D3 selection of all station circles
let stations;  // station array with enriched traffic data

// ── Helpers ─────────────────────────────────────────────────────────────────

function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) return tripsByMinute.flat();
  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;
  if (minMinute > maxMinute) {
    return tripsByMinute.slice(minMinute).concat(tripsByMinute.slice(0, maxMinute)).flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

function computeStationTraffic(stationList, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );
  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );
  return stationList.map((station) => {
    const id = station.short_name;
    station.arrivals     = arrivals.get(id)   ?? 0;
    station.departures   = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// ── Position sync ────────────────────────────────────────────────────────────

function updatePositions() {
  circles
    .attr('cx', (d) => getCoords(d).cx)
    .attr('cy', (d) => getCoords(d).cy);
}

// ── Scatter-plot update ──────────────────────────────────────────────────────

function updateScatterPlot(tf) {
  const filteredStations = computeStationTraffic(stations, tf);
  radiusScale.domain([0, d3.max(filteredStations, (d) => d.totalTraffic)]);
  tf === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

  circles
    .data(filteredStations, (d) => d.short_name)
    .join('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) =>
      stationFlow(d.departures / d.totalTraffic),
    );
}

// ── Slider UI ────────────────────────────────────────────────────────────────

function updateTimeDisplay() {
  timeFilter = Number(document.getElementById('time-slider').value);
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  if (timeFilter === -1) {
    selectedTime.style.display = 'none';
    anyTimeLabel.style.display = 'block';
  } else {
    selectedTime.style.display = 'block';
    selectedTime.textContent = formatTime(timeFilter);
    anyTimeLabel.style.display = 'none';
  }

  if (circles) updateScatterPlot(timeFilter);
}

// ── Map load ─────────────────────────────────────────────────────────────────

map.on('load', async () => {
  // Bike lanes — Boston
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: { 'line-color': '#32D400', 'line-width': 3, 'line-opacity': 0.5 },
  });

  // Bike lanes — Cambridge
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });
  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: { 'line-color': '#32D400', 'line-width': 3, 'line-opacity': 0.5 },
  });

  // Load stations
  const jsonData = await d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json');

  // Load trips — parse dates + bucket by minute
  await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at   = new Date(trip.ended_at);
      const startMin = minutesSinceMidnight(trip.started_at);
      const endMin   = minutesSinceMidnight(trip.ended_at);
      departuresByMinute[startMin].push(trip);
      arrivalsByMinute[endMin].push(trip);
      return trip;
    },
  );

  // Enrich stations with traffic totals
  stations = computeStationTraffic(jsonData.data.stations);
  radiusScale.domain([0, d3.max(stations, (d) => d.totalTraffic)]);

  // Draw circles
  circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) =>
      stationFlow(d.departures / d.totalTraffic),
    )
    .on('mouseenter', function (event, d) {
      tooltip.style.display = 'block';
      tooltip.textContent = `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`;
    })
    .on('mousemove', function (event) {
      tooltip.style.left = `${event.clientX + 12}px`;
      tooltip.style.top  = `${event.clientY - 28}px`;
    })
    .on('mouseleave', function () {
      tooltip.style.display = 'none';
    });

  updatePositions();

  map.on('move',    updatePositions);
  map.on('zoom',    updatePositions);
  map.on('resize',  updatePositions);
  map.on('moveend', updatePositions);

  // Wire slider
  document.getElementById('time-slider').addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
