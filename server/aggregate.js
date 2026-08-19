'use strict';

const { THEATERS } = require('./config');

/**
 * Derived readings.
 *
 * Everything in this file measures *reporting* — how much is being written
 * about a theater, in what language, and how markets moved. That is a proxy for
 * attention, not a measurement of events on the ground. Reporting intensity
 * rises with media access and news cycles as readily as with fighting, and
 * falls in places journalists cannot reach. The API labels these fields
 * accordingly and the UI states the basis next to every number.
 */

const HALF_LIFE_HOURS = 10;

/** Recency weight: 1.0 now, decaying by half every HALF_LIFE_HOURS. */
function recencyWeight(ageMinutes) {
  if (ageMinutes === null || ageMinutes === undefined) return 0.35; // undated
  const hours = Math.max(0, ageMinutes) / 60;
  return Math.pow(0.5, hours / HALF_LIFE_HOURS);
}

/**
 * Per-theater reporting picture built from the classified wire.
 */
function buildTheaterStatus(wireItems, gdeltByTheater = {}) {
  const byId = new Map(THEATERS.map((t) => [t.id, t]));
  const acc = new Map();

  for (const t of THEATERS) {
    acc.set(t.id, {
      id: t.id,
      name: t.name,
      short: t.short,
      region: t.region,
      lat: t.lat,
      lon: t.lon,
      countries: t.countries,
      baseline: t.baseline,
      context: t.context,
      itemCount: 0,
      weightedActivity: 0,
      signalScore: 0,
      signalTags: {},
      latestAt: null,
      headlines: [],
    });
  }

  for (const item of wireItems) {
    if (!item.theaters || !item.theaters.length) continue;
    const rw = recencyWeight(item.ageMinutes);

    for (const tid of item.theaters) {
      const slot = acc.get(tid);
      if (!slot) continue;

      // A theater mentioned in passing counts for less than one the piece is about.
      const relevance = (item.theaterScores && item.theaterScores[tid]) || 1;
      const relevanceWeight = Math.min(1, 0.45 + relevance * 0.2);

      slot.itemCount += 1;
      slot.weightedActivity += rw * (item.weight || 0.8) * relevanceWeight * (1 + Math.log2(item.corroboration || 1));
      slot.signalScore += (item.signalScore || 0) * rw;

      for (const tag of item.signals || []) {
        slot.signalTags[tag] = (slot.signalTags[tag] || 0) + 1;
      }
      if (item.publishedMs && (!slot.latestAt || item.publishedMs > slot.latestAt)) {
        slot.latestAt = item.publishedMs;
      }
      if (slot.headlines.length < 6) {
        slot.headlines.push({
          title: item.title,
          url: item.url,
          source: item.source,
          publishedAt: item.publishedAt,
          ageMinutes: item.ageMinutes,
          signals: item.signals,
          corroboration: item.corroboration,
        });
      }
    }
  }

  // Normalise activity across theaters so the scale is self-referential:
  // "busy relative to everything else we watch right now".
  const activities = [...acc.values()].map((s) => s.weightedActivity);
  const maxActivity = Math.max(1e-6, ...activities);

  const out = [];
  for (const slot of acc.values()) {
    const theater = byId.get(slot.id);
    const normalised = slot.weightedActivity / maxActivity; // 0..1

    const gd = gdeltByTheater[slot.id] || null;
    const intensity = Math.round(normalised * 100);

    out.push({
      ...slot,
      signalTags: Object.entries(slot.signalTags)
        .sort((a, b) => b[1] - a[1])
        .map(([tag, n]) => ({ tag, n })),
      reportingIntensity: intensity,
      level: intensityToLevel(intensity, theater.baseline),
      latestAt: slot.latestAt ? new Date(slot.latestAt).toISOString() : null,
      gdelt: gd
        ? {
            latestVolume: gd.latestVolume,
            latestTone: gd.latestTone,
            volumeTrend: gd.volumeTrend,
            toneTrend: gd.toneTrend,
          }
        : null,
    });
  }

  out.sort((a, b) => b.reportingIntensity - a.reportingIntensity || b.baseline - a.baseline);
  return out;
}

/**
 * Map reporting intensity onto a 1–5 band, floored near the theater's baseline
 * so a quiet news day does not imply a resolved conflict. A long-running war
 * that simply is not in today's headlines still reads as active.
 */
function intensityToLevel(intensity, baseline) {
  const fromNews =
    intensity >= 70 ? 5 : intensity >= 45 ? 4 : intensity >= 22 ? 3 : intensity >= 8 ? 2 : 1;
  const floor = Math.max(1, baseline - 1);
  return Math.max(floor, fromNews);
}

/**
 * Composite global reading, 0–100, with its inputs exposed.
 *
 * Deliberately simple and legible: three observable components, fixed weights,
 * no hidden model. A reader can check each number against the panel it came
 * from. It summarises today's signal; it does not predict anything.
 */
function buildComposite(theaterStatus, marketStress, wireItems) {
  const components = [];

  // 1. Weighted reporting intensity across theaters, biased toward the ones
  //    that carry the most structural risk.
  let wsum = 0;
  let acc = 0;
  for (const t of theaterStatus) {
    const w = t.baseline;
    acc += t.reportingIntensity * w;
    wsum += w;
  }
  const theaterComponent = wsum ? acc / wsum : 0;
  components.push({
    key: 'reporting',
    label: 'Theater reporting intensity',
    value: Math.round(theaterComponent),
    weight: 0.45,
    basis: 'Volume and recency of classified wire items, weighted by theater baseline.',
  });

  // 2. Market stress, when the board resolved.
  const stressValue = marketStress && marketStress.value !== null ? marketStress.value : null;
  components.push({
    key: 'markets',
    label: 'Market stress',
    value: stressValue,
    weight: 0.3,
    basis: 'Daily moves in VIX, gold, Brent, gas and the S&P 500.',
  });

  // 3. Density of escalation language on the wire.
  const recent = wireItems.filter((i) => (i.ageMinutes ?? 1e9) < 24 * 60);
  const withSignal = recent.filter((i) => (i.signalScore || 0) > 0);
  const escalationDensity = recent.length
    ? Math.min(100, (withSignal.length / recent.length) * 160)
    : null;
  components.push({
    key: 'language',
    label: 'Escalation language density',
    value: escalationDensity === null ? null : Math.round(escalationDensity),
    weight: 0.25,
    basis: 'Share of the last 24h of wire items containing escalation-signal terms.',
  });

  let total = 0;
  let usedWeight = 0;
  for (const c of components) {
    if (c.value === null) continue;
    total += c.value * c.weight;
    usedWeight += c.weight;
  }

  const value = usedWeight > 0 ? Math.round(total / usedWeight) : null;

  return {
    value,
    band: value === null ? null : bandFor(value),
    components,
    coverage: usedWeight,
    caveat:
      'Derived from reporting volume, market moves and headline language. ' +
      'It measures observable signal, not ground truth, and is not a forecast.',
  };
}

function bandFor(v) {
  if (v >= 75) return { id: 'severe', label: 'Severe' };
  if (v >= 58) return { id: 'elevated', label: 'Elevated' };
  if (v >= 40) return { id: 'guarded', label: 'Guarded' };
  if (v >= 22) return { id: 'moderate', label: 'Moderate' };
  return { id: 'low', label: 'Low' };
}

/**
 * Items whose language and corroboration make them worth surfacing above the
 * general wire. Ranked, not filtered — the full wire stays available.
 */
function buildPriorityFeed(wireItems, limit = 14) {
  const scored = wireItems
    .filter((i) => (i.ageMinutes ?? 1e9) < 36 * 60)
    .map((i) => {
      const rw = recencyWeight(i.ageMinutes);
      const theaterBoost = (i.theaters || []).reduce((s, tid) => {
        const t = THEATERS.find((x) => x.id === tid);
        return s + (t ? t.baseline : 0);
      }, 0);
      const score =
        rw * 10 +
        Math.max(0, i.signalScore || 0) * 1.4 +
        theaterBoost * 1.1 +
        (i.corroboration || 1) * 1.6 +
        (i.weight || 0.8) * 3;
      return { ...i, priorityScore: Math.round(score * 10) / 10 };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);

  return scored.slice(0, limit);
}

module.exports = {
  buildTheaterStatus,
  buildComposite,
  buildPriorityFeed,
  recencyWeight,
  intensityToLevel,
};
