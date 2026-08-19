'use strict';

const { get } = require('../lib/fetch');

/**
 * USGS seismic feed.
 *
 * Relevance to this dashboard: an underground nuclear test registers as a
 * seismic event with a distinctive profile — very shallow, and located at a
 * known test site. Open-source monitoring of exactly this feed is how public
 * reporting of DPRK tests has historically broken before official confirmation.
 *
 * The `explosionLike` flag below is a *geometry* heuristic only (shallow depth,
 * proximity to a known site). It is not a determination that a test occurred:
 * shallow natural earthquakes, mining blasts and quarry work all trip the same
 * conditions. USGS's own `type` field is the authoritative classifier and is
 * passed through untouched.
 */

const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';

/** Publicly documented nuclear test sites, for proximity annotation. */
const TEST_SITES = [
  { name: 'Punggye-ri (DPRK)', lat: 41.28, lon: 129.09, radiusKm: 60 },
  { name: 'Lop Nur (China)', lat: 41.5, lon: 88.5, radiusKm: 120 },
  { name: 'Semipalatinsk (Kazakhstan)', lat: 50.1, lon: 78.9, radiusKm: 120 },
  { name: 'Novaya Zemlya (Russia)', lat: 73.4, lon: 54.9, radiusKm: 150 },
  { name: 'Nevada NNSS (USA)', lat: 37.1, lon: -116.05, radiusKm: 100 },
  { name: 'Pokhran (India)', lat: 27.09, lon: 71.75, radiusKm: 80 },
  { name: 'Chagai (Pakistan)', lat: 28.83, lon: 64.62, radiusKm: 80 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function nearestTestSite(lat, lon) {
  let best = null;
  for (const site of TEST_SITES) {
    const km = haversineKm(lat, lon, site.lat, site.lon);
    if (km <= site.radiusKm && (!best || km < best.km)) {
      best = { name: site.name, km: Math.round(km) };
    }
  }
  return best;
}

async function fetchSeismic() {
  const data = await get(FEED, { timeout: 15_000, retries: 1, as: 'json' });
  const features = Array.isArray(data && data.features) ? data.features : [];
  const events = [];

  for (const f of features) {
    const p = f.properties || {};
    const g = f.geometry || {};
    if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;

    const [lon, lat, depth] = g.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const mag = Number(p.mag);
    const depthKm = Number.isFinite(depth) ? depth : null;
    const site = nearestTestSite(lat, lon);

    // Shallow + near a known site. See the caveat in the file header.
    const explosionLike =
      site !== null && depthKm !== null && depthKm < 5 && Number.isFinite(mag) && mag >= 4.5;

    events.push({
      id: f.id || `${lat},${lon},${p.time}`,
      mag: Number.isFinite(mag) ? mag : null,
      place: p.place || '',
      time: p.time ? new Date(p.time).toISOString() : null,
      lat,
      lon,
      depthKm,
      type: p.type || 'earthquake', // USGS classification: earthquake | explosion | ...
      url: p.url || '',
      nearTestSite: site,
      explosionLike,
    });
  }

  events.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

  return {
    events: events.slice(0, 80),
    flagged: events.filter((e) => e.explosionLike || e.type === 'explosion' || e.type === 'nuclear explosion'),
    count: events.length,
  };
}

module.exports = { fetchSeismic, nearestTestSite, haversineKm, TEST_SITES };
