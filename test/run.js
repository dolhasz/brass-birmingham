'use strict';

/**
 * Test suite.
 *
 * The build environment blocks outbound access to every upstream this service
 * uses, so `globalThis.fetch` is replaced with a fixture router. That is not
 * just a workaround: it exercises the real adapters end to end — URL
 * construction, HTTP handling, parsing, classification, aggregation and the
 * HTTP routes — against payloads shaped like the real ones, including
 * malformed records and dead feeds.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`      ${err.message.split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Fixture-backed fetch
// ---------------------------------------------------------------------------
// Shared with test/browser.js so both exercise identical upstream payloads.

const fixtureFetch = require('./fixture-fetch');
const readFix = fixtureFetch.readFix;

fixtureFetch.install();

// ---------------------------------------------------------------------------
// lib/xml
// ---------------------------------------------------------------------------

const xml = require('../server/lib/xml');

test('xml: parses RSS structure and decodes entities', () => {
  const doc = xml.parseXML(readFix('rss2.xml'));
  const items = xml.findAll(doc, 'item');
  assert.strictEqual(items.length, 5, 'should find all five <item> nodes');
  assert.strictEqual(
    xml.textOf(items[0], 'link'),
    'https://example.org/world/article-1?utm=rss&src=feed',
    '&amp; should decode to &'
  );
});

test('xml: CDATA content is taken literally, not re-decoded', () => {
  const doc = xml.parseXML(readFix('rss2.xml'));
  const first = xml.findAll(doc, 'item')[0];
  const title = xml.textOf(first, 'title');
  assert.ok(title.includes('Missile strike'), 'CDATA title should survive');
  assert.ok(!title.includes('<![CDATA['), 'CDATA wrapper should be stripped');
});

test('xml: namespaced tags resolve by local name', () => {
  const doc = xml.parseXML(readFix('rdf.xml'));
  const item = xml.findAll(doc, 'item')[0];
  assert.strictEqual(xml.textOf(item, 'dc:date'), '2026-08-19T10:00:00Z');
  assert.strictEqual(xml.textOf(item, 'date'), '2026-08-19T10:00:00Z', 'local-name lookup');
});

test('xml: stripHtml removes markup and truncates on a word boundary', () => {
  assert.strictEqual(xml.stripHtml('<p>Hello <b>world</b></p>'), 'Hello world');
  const out = xml.stripHtml('one two three four five six seven', 14);
  assert.ok(out.length <= 14, `got ${out.length}: ${out}`);
  assert.ok(out.endsWith('…'));
});

test('xml: tolerates an unclosed tag without throwing', () => {
  const doc = xml.parseXML(readFix('rss2.xml'));
  const items = xml.findAll(doc, 'item');
  const last = items[items.length - 1];
  assert.ok(xml.textOf(last, 'title').includes('Tolerance check'));
});

// ---------------------------------------------------------------------------
// lib/csv
// ---------------------------------------------------------------------------

const csv = require('../server/lib/csv');

test('csv: parses a header row into objects', () => {
  const rows = csv.parseCSVObjects(readFix('stooq-history.csv'));
  assert.strictEqual(rows.length, 7);
  assert.strictEqual(rows[0].date, '2026-08-11');
  assert.strictEqual(csv.num(rows[6].close), 82.86);
});

test('csv: handles quoted fields containing commas and escaped quotes', () => {
  const rows = csv.parseCSV('a,b\n"x,y","he said ""hi"""\n');
  assert.deepStrictEqual(rows[1], ['x,y', 'he said "hi"']);
});

test('csv: num() rejects non-numeric values', () => {
  assert.strictEqual(csv.num('N/A'), null);
  assert.strictEqual(csv.num(''), null);
  assert.strictEqual(csv.num('12.5'), 12.5);
});

// ---------------------------------------------------------------------------
// lib/classify
// ---------------------------------------------------------------------------

const { classify, signals } = require('../server/lib/classify');

test('classify: tags theaters from headline text', () => {
  assert.deepStrictEqual(classify('Russian missile strike on Kharkiv').ids, ['ukraine']);
  assert.deepStrictEqual(classify('Houthi attack in the Red Sea').ids, ['redsea']);
});

test('classify: word boundaries prevent substring false positives', () => {
  assert.deepStrictEqual(classify('Indiana factory expands').ids, []);
  assert.deepStrictEqual(classify('A tyrannical regime').ids, [], '"iran" must not match "tyrannical"');
});

test('classify: ranks the dominant theater first', () => {
  const { ids } = classify('Ukraine and Russia clash near Donetsk; Kyiv responds. Taiwan mentioned once.');
  assert.strictEqual(ids[0], 'ukraine');
});

test('signals: detects escalation language and scores de-escalation negatively', () => {
  assert.ok(signals('airstrike killed several').tags.includes('strike'));
  assert.ok(signals('ceasefire agreed in talks').score < 0, 'diplomacy should reduce the score');
});

// ---------------------------------------------------------------------------
// sources/news
// ---------------------------------------------------------------------------

const news = require('../server/sources/news');

test('news: parses RSS 2.0 and skips items with no usable link', () => {
  const items = news.parseFeed(readFix('rss2.xml'), {
    id: 'f',
    name: 'Example',
    lane: 'wire',
    weight: 1,
  });
  assert.strictEqual(items.length, 4, 'the link-less item should be dropped');
  assert.ok(items.every((i) => i.url), 'every item must have a url');
  assert.ok(items[0].publishedMs > 0, 'pubDate should parse');
});

test('news: parses Atom, preferring rel="alternate" links', () => {
  const items = news.parseFeed(readFix('atom.xml'), {
    id: 'a',
    name: 'Atom',
    lane: 'defense',
    weight: 1,
  });
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].url, 'https://defense.example.org/a/taiwan-adiz');
  assert.ok(items[1].url.endsWith('/dprk-launch'), 'bare <link href> should still resolve');
});

test('news: parses RSS 1.0 (RDF) with dc:date', () => {
  const items = news.parseFeed(readFix('rdf.xml'), {
    id: 'r',
    name: 'RDF',
    lane: 'wire',
    weight: 1,
  });
  assert.strictEqual(items.length, 2);
  assert.ok(items[0].publishedMs > 0, 'dc:date should be read as the timestamp');
  assert.deepStrictEqual(items[0].theaters, ['sudan']);
});

test('news: near-duplicate headlines collapse and record corroboration', () => {
  const a = news.parseFeed(readFix('rss2.xml'), { id: 'a', name: 'A', lane: 'wire', weight: 1.0 });
  const b = news.parseFeed(readFix('atom.xml'), { id: 'b', name: 'B', lane: 'wire', weight: 0.5 });
  const merged = news.rankAndDedupe([...a, ...b]);

  const kharkiv = merged.filter((i) => i.title.includes('Kharkiv'));
  assert.strictEqual(kharkiv.length, 1, 'the syndicated duplicate should collapse');
  assert.strictEqual(kharkiv[0].source, 'A', 'the higher-weighted source should win');
  assert.strictEqual(kharkiv[0].corroboration, 2, 'corroboration should count both outlets');
});

test('news: results are sorted newest first', () => {
  const items = news.parseFeed(readFix('rss2.xml'), { id: 'f', name: 'F', lane: 'wire', weight: 1 });
  const ranked = news.rankAndDedupe(items);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      (ranked[i - 1].publishedMs || 0) >= (ranked[i].publishedMs || 0),
      'ordering must be descending by publish time'
    );
  }
});

test('news: fetchWire contains dead feeds instead of failing', async () => {
  const { items, sourceStatus } = await news.fetchWire();
  assert.ok(items.length > 0, 'live feeds should still produce items');
  assert.ok(
    sourceStatus.some((s) => !s.ok),
    'the fixture router 500s most feeds — those must be reported as failures'
  );
  assert.ok(
    sourceStatus.some((s) => s.ok && s.count > 0),
    'working feeds must still report their counts'
  );
});

// ---------------------------------------------------------------------------
// sources/markets
// ---------------------------------------------------------------------------

const markets = require('../server/sources/markets');

test('markets: builds the full board with per-instrument series', async () => {
  const board = await markets.fetchMarkets();
  assert.strictEqual(board.quotes.length, 18, 'every configured instrument should appear');
  assert.ok(board.quotes.every((q) => q.available), 'all instruments resolve from fixtures');

  const wti = board.quotes.find((q) => q.symbol === 'cl.f');
  assert.strictEqual(wti.last, 83.1, 'the live snapshot price should win over the history bar');
  assert.ok(Number.isFinite(wti.reference), 'reference comes from the daily history');
  assert.ok(
    Math.abs(wti.changePct - ((wti.last - wti.reference) / wti.reference) * 100) < 1e-6,
    'changePct must be consistent with last and reference'
  );
  assert.ok(wti.series.length > 1, 'a sparkline series should be present');

  // Instruments must not share a series — that was a real bug in the fixtures.
  const spx = board.quotes.find((q) => q.symbol === '^spx');
  assert.ok(spx.last > 5000, `S&P should be in the thousands, got ${spx.last}`);
  assert.notStrictEqual(spx.series[0], wti.series[0], 'each symbol needs its own history');
});

test('markets: an implausible move is suppressed rather than displayed', async () => {
  // A snapshot price from a different series than the history it is compared
  // against — exactly what a mismatched upstream payload looks like.
  const restore = fixtureFetch.install();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('stooq.com/q/l')) {
      return fixtureFetch.makeResponse(
        'Symbol,Date,Time,Open,High,Low,Close,Volume\nCL.F,2026-08-19,20:15:00,1,1,1,18604.20,0\n'
      );
    }
    return original(url);
  };

  const board = await markets.fetchMarkets();
  const wti = board.quotes.find((q) => q.symbol === 'cl.f');
  assert.strictEqual(wti.changePct, null, 'a >75% move must not be reported');
  assert.strictEqual(wti.suspect, true, 'and it should be flagged as suspect');

  restore();
  fixtureFetch.install();
});

test('markets: stress index rises on a risk-off day', () => {
  const riskOff = markets.computeStress([
    { symbol: '^vix', name: 'VIX', changePct: 25 },
    { symbol: 'gc.f', name: 'Gold', changePct: 3 },
    { symbol: 'cb.f', name: 'Brent', changePct: 6 },
    { symbol: '^spx', name: 'S&P 500', changePct: -4 },
  ]);
  assert.ok(riskOff.value > 85, `expected a high reading, got ${riskOff.value}`);

  const calm = markets.computeStress([
    { symbol: '^vix', name: 'VIX', changePct: -8 },
    { symbol: 'gc.f', name: 'Gold', changePct: -1 },
    { symbol: 'cb.f', name: 'Brent', changePct: -2 },
    { symbol: '^spx', name: 'S&P 500', changePct: 1.5 },
  ]);
  assert.ok(calm.value < 20, `expected a low reading, got ${calm.value}`);
});

test('markets: stress is null when nothing resolved', () => {
  assert.strictEqual(markets.computeStress([]).value, null);
});

test('markets: rangePosition locates the last price within its range', () => {
  const bars = [
    { low: 10, high: 20, close: 15 },
    { low: 12, high: 22, close: 18 },
  ];
  assert.strictEqual(markets.rangePosition(bars, 22), 1);
  assert.strictEqual(markets.rangePosition(bars, 10), 0);
  assert.strictEqual(markets.rangePosition(bars, 16), 0.5);
});

// ---------------------------------------------------------------------------
// sources/gdelt
// ---------------------------------------------------------------------------

const gdelt = require('../server/sources/gdelt');

test('gdelt: parses compact and ISO timestamps', () => {
  const d = gdelt.parseGdeltDate('20260819T120000Z');
  assert.strictEqual(d.toISOString(), '2026-08-19T12:00:00.000Z');
  assert.strictEqual(gdelt.parseGdeltDate('20260819').toISOString(), '2026-08-19T00:00:00.000Z');
  assert.strictEqual(gdelt.parseGdeltDate('nonsense'), null);
});

test('gdelt: geo parsing skips non-point and malformed features', async () => {
  const { points, total } = await gdelt.fetchGeo('ukraine');
  assert.strictEqual(points.length, 4, 'polygon and bad-coordinate features must be dropped');
  assert.strictEqual(points[0].name, 'Kyiv', 'name should be trimmed to the first segment');
  assert.strictEqual(points[0].count, 402, 'points should be sorted by count');
  assert.strictEqual(points[3].count, 1, 'a missing count should default to 1');
  assert.strictEqual(total, 683);
});

test('gdelt: trend compares the recent window against the earlier one', () => {
  const rising = Array.from({ length: 12 }, (_, i) => ({ t: '', v: i }));
  assert.ok(gdelt.trend(rising) > 0, 'a rising series should trend positive');
  assert.strictEqual(gdelt.trend([{ t: '', v: 1 }]), null, 'too few points to judge');
});

test('gdelt: theater signal returns both series', async () => {
  const sig = await gdelt.fetchTheaterSignal({ id: 'ukraine', query: 'Ukraine Russia war' });
  assert.strictEqual(sig.volume.length, 12);
  assert.strictEqual(sig.tone.length, 12);
  assert.ok(sig.latestTone < 0, 'fixture tone is negative');
  assert.strictEqual(sig.errors.length, 0);
});

// ---------------------------------------------------------------------------
// sources/seismic
// ---------------------------------------------------------------------------

const seismic = require('../server/sources/seismic');

test('seismic: haversine distance is sane', () => {
  const km = seismic.haversineKm(0, 0, 0, 1);
  assert.ok(km > 110 && km < 112, `one degree of longitude at the equator: ${km}`);
});

test('seismic: flags a shallow event near a known test site', async () => {
  const { events, flagged } = await seismic.fetchSeismic();
  assert.strictEqual(events.length, 4);

  const dprk = events.find((e) => e.place.includes('Punggye-ri'));
  assert.ok(dprk.explosionLike, 'shallow + near a test site should be flagged');
  assert.strictEqual(dprk.nearTestSite.name, 'Punggye-ri (DPRK)');

  const tokyo = events.find((e) => e.place.includes('Tokyo'));
  assert.ok(!tokyo.explosionLike, 'a deep, distant quake must not be flagged');
  assert.strictEqual(tokyo.nearTestSite, null);

  assert.ok(
    flagged.some((e) => e.type === 'explosion'),
    "USGS's own explosion classification should carry through"
  );
});

// ---------------------------------------------------------------------------
// sources/reliefweb
// ---------------------------------------------------------------------------

const reliefweb = require('../server/sources/reliefweb');

test('reliefweb: normalises reports and disasters and tags theaters', async () => {
  const { reports, disasters, errors } = await reliefweb.fetchHumanitarian();
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(reports[0].country, 'Sudan');
  assert.deepStrictEqual(reports[0].theaters, ['sudan']);
  assert.strictEqual(disasters[0].status, 'ongoing');
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

const aggregate = require('../server/aggregate');

function wireItem(over = {}) {
  return {
    title: 'x',
    url: 'https://e/1',
    source: 'S',
    weight: 1,
    ageMinutes: 30,
    corroboration: 1,
    theaters: ['ukraine'],
    theaterScores: { ukraine: 3 },
    signals: ['strike'],
    signalScore: 3,
    publishedMs: Date.now() - 30 * 60_000,
    publishedAt: new Date().toISOString(),
    ...over,
  };
}

test('aggregate: recency weighting decays by half over the half-life', () => {
  assert.strictEqual(aggregate.recencyWeight(0), 1);
  assert.ok(Math.abs(aggregate.recencyWeight(600) - 0.5) < 1e-9, '10h -> 0.5');
});

test('aggregate: theater status reflects classified volume', () => {
  const items = [wireItem(), wireItem(), wireItem({ theaters: ['taiwan'], theaterScores: { taiwan: 1 } })];
  const status = aggregate.buildTheaterStatus(items);

  const ukr = status.find((t) => t.id === 'ukraine');
  const twn = status.find((t) => t.id === 'taiwan');
  assert.strictEqual(ukr.itemCount, 2);
  assert.strictEqual(ukr.reportingIntensity, 100, 'the busiest theater normalises to 100');
  assert.ok(twn.reportingIntensity < ukr.reportingIntensity);
  assert.ok(ukr.signalTags.some((s) => s.tag === 'strike'));
});

test('aggregate: an ongoing war stays above its baseline on a quiet day', () => {
  const status = aggregate.buildTheaterStatus([wireItem({ theaters: ['taiwan'], theaterScores: { taiwan: 1 } })]);
  const ukr = status.find((t) => t.id === 'ukraine');
  assert.strictEqual(ukr.itemCount, 0, 'no items today');
  assert.ok(ukr.level >= 4, `baseline 5 should floor the level at 4, got ${ukr.level}`);
});

test('aggregate: composite blends components and exposes them', () => {
  const status = aggregate.buildTheaterStatus([wireItem()]);
  const composite = aggregate.buildComposite(status, { value: 80 }, [wireItem()]);

  assert.ok(composite.value >= 0 && composite.value <= 100);
  assert.strictEqual(composite.components.length, 3);
  assert.ok(composite.band.label, 'a band label should be present');
  assert.ok(composite.caveat.includes('not a forecast'));
});

test('aggregate: composite degrades when markets are missing', () => {
  const status = aggregate.buildTheaterStatus([wireItem()]);
  const composite = aggregate.buildComposite(status, { value: null }, [wireItem()]);
  assert.ok(composite.value !== null, 'should still produce a value from the other components');
  assert.strictEqual(composite.components.find((c) => c.key === 'markets').value, null);
  assert.ok(composite.coverage < 1, 'coverage should record the missing weight');
});

test('aggregate: priority feed ranks escalation and corroboration up', () => {
  const dull = wireItem({ title: 'dull', signalScore: 0, signals: [], corroboration: 1, theaters: [] });
  const loud = wireItem({ title: 'loud', signalScore: 9, corroboration: 4 });
  const feed = aggregate.buildPriorityFeed([dull, loud]);
  assert.strictEqual(feed[0].title, 'loud');
});

// ---------------------------------------------------------------------------
// public/js/topo (ESM)
// ---------------------------------------------------------------------------

test('topo: decodes world geometry and projects correctly', async () => {
  const topo = await import('../public/js/topo.mjs');
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'countries-50m.json'), 'utf8')
  );
  const feats = topo.decodeTopology(raw, 'countries');
  assert.ok(feats.length > 200, `expected ~241 countries, got ${feats.length}`);

  const ukr = feats.find((f) => f.name === 'Ukraine');
  assert.strictEqual(ukr.id, '804', 'ISO numeric id must match the theater config');

  const lons = ukr.polygons[0][0].map((p) => p[0]);
  assert.ok(Math.min(...lons) > 21 && Math.max(...lons) < 41, 'Ukraine longitude range');

  assert.deepStrictEqual(topo.project(0, 0), [1800, 900], 'null island maps to the canvas centre');
  assert.deepStrictEqual(topo.project(-180, 90), [0, 0], 'top-left corner');
  assert.ok(topo.toPath(ukr).startsWith('M'), 'path data should be produced');
});

test('topo: a ring crossing the antimeridian is split, not streaked', async () => {
  const topo = await import('../public/js/topo.mjs');

  // A small box straddling 180°: 175E -> 175W. Drawn naively this produces one
  // path spanning the entire canvas width.
  const feature = {
    polygons: [[[[175, 10], [-175, 10], [-175, -10], [175, -10], [175, 10]]]],
  };
  const d = topo.toPath(feature);

  const subpaths = d.split('M').filter(Boolean);
  assert.strictEqual(subpaths.length, 2, 'should render as two pieces, one per map edge');

  // Each piece individually must stay narrow. Together they legitimately reach
  // both edges — that is the point — so the span has to be measured per piece.
  const spans = subpaths.map((sp) => {
    const xs = [...sp.matchAll(/(-?[\d.]+) /g)].map((m) => Number(m[1]));
    return Math.max(...xs) - Math.min(...xs);
  });
  for (const span of spans) {
    assert.ok(
      span < topo.WORLD.width * 0.1,
      `each piece should be narrow, got ${span} of ${topo.WORLD.width}`
    );
  }

  const allX = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
  assert.ok(allX.some((x) => x <= 1), 'left edge reached');
  assert.ok(allX.some((x) => x >= topo.WORLD.width - 1), 'right edge reached');
});

test('topo: ordinary geometry is unaffected by antimeridian handling', async () => {
  const topo = await import('../public/js/topo.mjs');
  const feature = { polygons: [[[[10, 10], [20, 10], [20, 0], [10, 0], [10, 10]]]] };
  const d = topo.toPath(feature);
  assert.strictEqual(d.split('M').filter(Boolean).length, 1, 'a normal ring stays one subpath');
});

test('topo: every theater country id resolves to real geometry', async () => {
  const topo = await import('../public/js/topo.mjs');
  const { THEATERS } = require('../server/config');
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'countries-50m.json'), 'utf8')
  );
  // Config references geometry by ISO id, or by name for disputed territories
  // that carry no id in this dataset. The renderer indexes both.
  const feats = topo.decodeTopology(raw, 'countries');
  const keys = new Set();
  for (const f of feats) {
    if (f.id) keys.add(f.id);
    if (f.name) keys.add(f.name.toLowerCase());
  }

  const missing = [];
  for (const t of THEATERS) {
    for (const ref of t.countries) {
      if (!keys.has(ref) && !keys.has(String(ref).toLowerCase())) {
        missing.push(`${t.id}:${ref}`);
      }
    }
  }
  assert.deepStrictEqual(missing, [], `these country codes have no geometry: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const { server } = require('../server/index');

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers: { Accept: 'application/json' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      })
      .on('error', reject);
  });
}

let port = 0;

test('http: server starts', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  assert.ok(port > 0);
});

test('http: /api/health reports cache diagnostics', async () => {
  const res = await request(port, '/api/health');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.status, 'ok');
  assert.ok(body.theaters > 20);
  assert.ok(body.cache, 'cache stats should be exposed for diagnostics');
});

test('http: /api/overview assembles the full dashboard payload', async () => {
  const res = await request(port, '/api/overview');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);

  assert.ok(body.composite, 'composite present');
  assert.ok(Array.isArray(body.theaters) && body.theaters.length > 20);
  assert.ok(Array.isArray(body.priority));
  assert.ok(body.markets.quotes.length > 0, 'market board should be populated from fixtures');
  assert.ok(body.wireMeta.total > 0, 'wire should have items');
  assert.ok(body.wireMeta.degraded, 'the stub 500s most feeds, so degraded must be true');
});

test('http: /api/wire filters by query and lane', async () => {
  const all = JSON.parse((await request(port, '/api/wire?limit=200')).body);
  assert.ok(all.count > 0);

  const kharkiv = JSON.parse((await request(port, '/api/wire?q=kharkiv')).body);
  assert.ok(kharkiv.count >= 1);
  assert.ok(kharkiv.items.every((i) => /kharkiv/i.test(i.title + i.summary)));

  const defense = JSON.parse((await request(port, '/api/wire?lane=defense')).body);
  assert.ok(defense.items.every((i) => i.lane === 'defense'));
});

test('http: /api/theater/:id returns detail, unknown ids 404', async () => {
  const ok = await request(port, '/api/theater/ukraine');
  assert.strictEqual(ok.status, 200);
  const body = JSON.parse(ok.body);
  assert.strictEqual(body.theater.id, 'ukraine');
  assert.ok(body.theater.status, 'status block present');

  const bad = await request(port, '/api/theater/atlantis');
  assert.strictEqual(bad.status, 404);
});

test('http: /api/geo, /api/seismic and /api/humanitarian resolve', async () => {
  const geo = JSON.parse((await request(port, '/api/geo')).body);
  assert.ok(geo.points.length > 0, 'geo points from fixtures');

  const seis = JSON.parse((await request(port, '/api/seismic')).body);
  assert.strictEqual(seis.events.length, 4);

  const hum = JSON.parse((await request(port, '/api/humanitarian')).body);
  assert.ok(hum.reports.length > 0);
});

test('http: static assets are served with correct types', async () => {
  const index = await request(port, '/');
  assert.strictEqual(index.status, 200);
  assert.ok(index.headers['content-type'].includes('text/html'));
  assert.ok(index.body.includes('GLOBAL CONFLICT MONITOR'));

  const js = await request(port, '/js/app.mjs');
  assert.strictEqual(js.status, 200);
  assert.ok(js.headers['content-type'].includes('javascript'), 'mjs must be served as JavaScript');

  const css = await request(port, '/css/style.css');
  assert.ok(css.headers['content-type'].includes('text/css'));
});

test('http: path traversal is refused', async () => {
  const res = await request(port, '/../package.json');
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  assert.ok(!res.body.includes('global-conflict-monitor'), 'must not leak files above the web root');
});

test('http: unknown API routes 404 as JSON', async () => {
  const res = await request(port, '/api/nope');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(JSON.parse(res.body).error, 'unknown endpoint');
});

test('http: shuts down cleanly', async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------

console.log('\n  conflict-monitor test suite\n');
run();
