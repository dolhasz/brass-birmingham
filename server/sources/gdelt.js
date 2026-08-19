'use strict';

const { get, settleAll } = require('../lib/fetch');
const { THEATERS } = require('../config');

/**
 * GDELT 2.0 public APIs — no key required.
 *
 *   GEO  : geolocated density of news mentions -> the map heat layer
 *   DOC  : timelinevol / timelinetone -> reporting volume and sentiment series
 *
 * GDELT is generous but flaky: it will occasionally answer with an HTML error
 * page, a rate-limit notice, or truncated JSON. Every call here is therefore
 * treated as best-effort and contained by the caller.
 */

const GEO_URL = 'https://api.gdeltproject.org/api/v2/geo/geo';
const DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

/** GDELT emits both "20260819T120000Z" and ISO-ish stamps. Accept either. */
function parseGdeltDate(s) {
  if (!s) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s);
  if (compact) {
    const [, y, mo, d, h, mi, sec] = compact;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec));
  }
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return new Date(Date.UTC(+y, +mo - 1, +d));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Geolocated mention density for a query.
 * @returns {{points: Array, total: number}}
 */
async function fetchGeo(query, { timespan = '3d' } = {}) {
  const url =
    `${GEO_URL}?query=${encodeURIComponent(query)}` +
    `&mode=pointdata&format=geojson&timespan=${encodeURIComponent(timespan)}`;

  const data = await get(url, {
    timeout: 15_000,
    retries: 1,
    as: 'json',
    accept: 'application/json, application/geo+json, */*',
  });

  const features = Array.isArray(data && data.features) ? data.features : [];
  const points = [];

  for (const f of features) {
    const geom = f && f.geometry;
    if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates)) continue;
    const [lon, lat] = geom.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const props = f.properties || {};
    // GDELT reports mention weight in `count`; older responses use `shareimage`
    // or embed it in the html blurb. Fall back to 1 so a point still renders.
    const count = Number(props.count) || 1;

    points.push({
      lat,
      lon,
      name: String(props.name || props.location || '').split(',')[0].trim(),
      count,
    });
  }

  points.sort((a, b) => b.count - a.count);
  const total = points.reduce((s, p) => s + p.count, 0);
  return { points: points.slice(0, 220), total };
}

/** Reporting volume as a percentage of all monitored coverage. */
async function fetchVolume(query, { timespan = '7d' } = {}) {
  const url =
    `${DOC_URL}?query=${encodeURIComponent(query)}` +
    `&mode=timelinevol&format=json&timespan=${encodeURIComponent(timespan)}`;
  const data = await get(url, { timeout: 15_000, retries: 1, as: 'json' });
  return extractSeries(data);
}

/** Average tone of coverage; negative is more negative reporting. */
async function fetchTone(query, { timespan = '7d' } = {}) {
  const url =
    `${DOC_URL}?query=${encodeURIComponent(query)}` +
    `&mode=timelinetone&format=json&timespan=${encodeURIComponent(timespan)}`;
  const data = await get(url, { timeout: 15_000, retries: 1, as: 'json' });
  return extractSeries(data);
}

function extractSeries(data) {
  const timeline = data && Array.isArray(data.timeline) ? data.timeline : [];
  if (!timeline.length) return [];
  const series = timeline[0];
  const rows = Array.isArray(series && series.data) ? series.data : [];
  const out = [];
  for (const row of rows) {
    const d = parseGdeltDate(row.date);
    const v = Number(row.value);
    if (!d || !Number.isFinite(v)) continue;
    out.push({ t: d.toISOString(), v });
  }
  return out;
}

/**
 * Volume/tone for one theater, plus a simple trend read comparing the most
 * recent quarter of the window against the preceding stretch.
 */
async function fetchTheaterSignal(theater, { timespan = '7d' } = {}) {
  const [volRes, toneRes] = await Promise.allSettled([
    fetchVolume(theater.query, { timespan }),
    fetchTone(theater.query, { timespan }),
  ]);

  const volume = volRes.status === 'fulfilled' ? volRes.value : [];
  const tone = toneRes.status === 'fulfilled' ? toneRes.value : [];

  return {
    theaterId: theater.id,
    volume,
    tone,
    volumeTrend: trend(volume),
    toneTrend: trend(tone),
    latestVolume: volume.length ? volume[volume.length - 1].v : null,
    latestTone: tone.length ? tone[tone.length - 1].v : null,
    errors: [
      volRes.status === 'rejected' ? `volume: ${volRes.reason?.message || volRes.reason}` : null,
      toneRes.status === 'rejected' ? `tone: ${toneRes.reason?.message || toneRes.reason}` : null,
    ].filter(Boolean),
  };
}

/**
 * Percentage change of the last quarter of a series versus the earlier
 * remainder. Returns null when there is not enough data to say anything.
 */
function trend(series) {
  if (!series || series.length < 8) return null;
  const cut = Math.floor(series.length * 0.75);
  const recent = series.slice(cut);
  const earlier = series.slice(0, cut);
  if (!recent.length || !earlier.length) return null;

  const avg = (xs) => xs.reduce((s, x) => s + x.v, 0) / xs.length;
  const r = avg(recent);
  const e = avg(earlier);
  if (!Number.isFinite(r) || !Number.isFinite(e)) return null;
  if (Math.abs(e) < 1e-9) return null;
  return ((r - e) / Math.abs(e)) * 100;
}

/** Geolocated points across every theater, tagged with which theater produced them. */
async function fetchGlobalGeo({ timespan = '3d', concurrency = 5 } = {}) {
  const results = await settleAll(
    THEATERS,
    async (t) => fetchGeo(t.query, { timespan }),
    concurrency
  );

  const points = [];
  const status = [];

  for (let i = 0; i < THEATERS.length; i++) {
    const t = THEATERS[i];
    const r = results[i];
    status.push({
      theaterId: t.id,
      ok: r.ok,
      points: r.ok ? r.value.points.length : 0,
      ms: r.ms,
      error: r.ok ? null : r.error,
    });
    if (!r.ok) continue;
    for (const p of r.value.points) {
      points.push({ ...p, theaterId: t.id });
    }
  }

  return { points, status, generatedAt: new Date().toISOString() };
}

module.exports = {
  fetchGeo,
  fetchVolume,
  fetchTone,
  fetchTheaterSignal,
  fetchGlobalGeo,
  parseGdeltDate,
  trend,
};
