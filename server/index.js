'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const { PORT, THEATERS, TTL } = require('./config');
const { TTLCache } = require('./lib/cache');
const news = require('./sources/news');
const markets = require('./sources/markets');
const gdelt = require('./sources/gdelt');
const reliefweb = require('./sources/reliefweb');
const seismic = require('./sources/seismic');
const aggregate = require('./aggregate');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STARTED_AT = Date.now();
const cache = new TTLCache({ name: 'sources' });

// ---------------------------------------------------------------------------
// Cached source accessors
// ---------------------------------------------------------------------------

const getWire = () =>
  cache.wrap('wire', { ttl: TTL.news, grace: TTL.newsGrace }, news.fetchWire);

const getMarkets = () =>
  cache.wrap('markets', { ttl: TTL.markets, grace: TTL.marketsGrace }, markets.fetchMarkets);

const getGeo = () =>
  cache.wrap('geo', { ttl: TTL.gdelt, grace: TTL.gdeltGrace }, () =>
    gdelt.fetchGlobalGeo({ timespan: '3d' })
  );

const getHumanitarian = () =>
  cache.wrap(
    'humanitarian',
    { ttl: TTL.reliefweb, grace: TTL.reliefwebGrace },
    reliefweb.fetchHumanitarian
  );

const getSeismic = () =>
  cache.wrap('seismic', { ttl: TTL.seismic, grace: TTL.seismicGrace }, seismic.fetchSeismic);

const getTheaterSignal = (theater) =>
  cache.wrap(
    `signal:${theater.id}`,
    { ttl: TTL.theater, grace: TTL.theaterGrace },
    () => gdelt.fetchTheaterSignal(theater, { timespan: '7d' })
  );

const getTheaterWire = (theater) =>
  cache.wrap(`twire:${theater.id}`, { ttl: TTL.theater, grace: TTL.theaterGrace }, () =>
    news.fetchTheaterWire(theater)
  );

/** Resolve a promise to a value, or to a sentinel on failure. Never throws. */
async function soft(promise, fallback) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, value: fallback, error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleOverview() {
  const [wireRes, marketRes] = await Promise.all([
    soft(getWire(), { items: [], sourceStatus: [] }),
    soft(getMarkets(), { quotes: [], stress: { value: null, components: [] }, status: [] }),
  ]);

  const wire = wireRes.value;
  const board = marketRes.value;

  // GDELT signals are an enrichment: use whatever is already warm in cache, and
  // never block the overview on them.
  const gdeltByTheater = {};
  for (const t of THEATERS) {
    const entry = cache.peek(`signal:${t.id}`);
    if (entry && entry.value) gdeltByTheater[t.id] = entry.value;
  }

  const theaters = aggregate.buildTheaterStatus(wire.items, gdeltByTheater);
  const composite = aggregate.buildComposite(theaters, board.stress, wire.items);
  const priority = aggregate.buildPriorityFeed(wire.items);

  return {
    generatedAt: new Date().toISOString(),
    composite,
    theaters,
    priority,
    markets: {
      stress: board.stress,
      quotes: board.quotes,
    },
    wireMeta: {
      total: wire.items.length,
      sources: wire.sourceStatus,
      degraded: !wireRes.ok || wire.sourceStatus.some((s) => !s.ok),
    },
    errors: [
      wireRes.ok ? null : `wire: ${wireRes.error}`,
      marketRes.ok ? null : `markets: ${marketRes.error}`,
    ].filter(Boolean),
  };
}

async function handleWire(query) {
  const res = await soft(getWire(), { items: [], sourceStatus: [] });
  let items = res.value.items;

  const lane = query.get('lane');
  if (lane && lane !== 'all') items = items.filter((i) => i.lane === lane);

  const theater = query.get('theater');
  if (theater && theater !== 'all') {
    items = items.filter((i) => (i.theaters || []).includes(theater));
  }

  const q = (query.get('q') || '').trim().toLowerCase();
  if (q) {
    items = items.filter(
      (i) => i.title.toLowerCase().includes(q) || (i.summary || '').toLowerCase().includes(q)
    );
  }

  const limit = Math.min(300, Math.max(1, Number(query.get('limit')) || 120));

  return {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items: items.slice(0, limit),
    sources: res.value.sourceStatus,
    error: res.ok ? null : res.error,
  };
}

async function handleMarkets() {
  const res = await soft(getMarkets(), { quotes: [], stress: null, status: [] });
  return { generatedAt: new Date().toISOString(), ...res.value, error: res.ok ? null : res.error };
}

async function handleGeo() {
  const res = await soft(getGeo(), { points: [], status: [] });
  return { generatedAt: new Date().toISOString(), ...res.value, error: res.ok ? null : res.error };
}

async function handleHumanitarian() {
  const res = await soft(getHumanitarian(), { reports: [], disasters: [], errors: [] });
  return { generatedAt: new Date().toISOString(), ...res.value, error: res.ok ? null : res.error };
}

async function handleSeismic() {
  const res = await soft(getSeismic(), { events: [], flagged: [], count: 0 });
  return { generatedAt: new Date().toISOString(), ...res.value, error: res.ok ? null : res.error };
}

async function handleTheater(id) {
  const theater = THEATERS.find((t) => t.id === id);
  if (!theater) return { status: 404, body: { error: `unknown theater: ${id}` } };

  const [wireRes, signalRes, drillRes, geoRes] = await Promise.all([
    soft(getWire(), { items: [] }),
    soft(getTheaterSignal(theater), null),
    soft(getTheaterWire(theater), []),
    soft(gdelt.fetchGeo(theater.query, { timespan: '3d' }), { points: [], total: 0 }),
  ]);

  const related = wireRes.value.items.filter((i) => (i.theaters || []).includes(id));
  const status = aggregate.buildTheaterStatus(wireRes.value.items, {
    [id]: signalRes.value || undefined,
  });

  return {
    generatedAt: new Date().toISOString(),
    theater: {
      ...theater,
      status: status.find((s) => s.id === id) || null,
    },
    wire: related.slice(0, 40),
    drilldown: drillRes.value || [],
    signal: signalRes.value,
    geo: geoRes.value,
    errors: [
      wireRes.ok ? null : `wire: ${wireRes.error}`,
      signalRes.ok ? null : `signal: ${signalRes.error}`,
      drillRes.ok ? null : `drilldown: ${drillRes.error}`,
      geoRes.ok ? null : `geo: ${geoRes.error}`,
    ].filter(Boolean),
  };
}

function handleHealth() {
  const mem = process.memoryUsage();
  return {
    status: 'ok',
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    node: process.version,
    generatedAt: new Date().toISOString(),
    memoryMB: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
    },
    theaters: THEATERS.length,
    cache: cache.stats(),
  };
}

function handleConfig() {
  return {
    theaters: THEATERS.map((t) => ({
      id: t.id,
      name: t.name,
      short: t.short,
      region: t.region,
      lat: t.lat,
      lon: t.lon,
      countries: t.countries,
      baseline: t.baseline,
      context: t.context,
    })),
  };
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const COMPRESSIBLE = /^(text\/|application\/json|image\/svg|application\/javascript|text\/javascript)/;

/** Memoised gzip of static assets — the map TopoJSON is ~750KB raw. */
const gzipCache = new Map();

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = path.join(PUBLIC_DIR, rel);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    return sendJSON(req, res, 403, { error: 'forbidden' });
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
    if (stat.isDirectory()) return sendJSON(req, res, 404, { error: 'not found' });
  } catch {
    return sendJSON(req, res, 404, { error: 'not found' });
  }

  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }

  const immutable = ext === '.json' && rel.includes('/data/');
  const headers = {
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': immutable ? 'public, max-age=604800' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  };

  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (wantsGzip && COMPRESSIBLE.test(type) && stat.size > 1024) {
    const key = `${resolved}:${etag}`;
    let buf = gzipCache.get(key);
    if (!buf) {
      const raw = await fsp.readFile(resolved);
      buf = zlib.gzipSync(raw, { level: 6 });
      gzipCache.set(key, buf);
      if (gzipCache.size > 60) gzipCache.delete(gzipCache.keys().next().value);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = buf.length;
    headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(resolved).pipe(res);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJSON(req, res, status, body) {
  const json = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && json.length > 1024) {
    const buf = zlib.gzipSync(json, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = buf.length;
    headers.Vary = 'Accept-Encoding';
    res.writeHead(status, headers);
    return res.end(buf);
  }

  headers['Content-Length'] = Buffer.byteLength(json);
  res.writeHead(status, headers);
  res.end(json);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const API = {
  '/api/health': () => handleHealth(),
  '/api/config': () => handleConfig(),
  '/api/overview': () => handleOverview(),
  '/api/markets': () => handleMarkets(),
  '/api/geo': () => handleGeo(),
  '/api/humanitarian': () => handleHumanitarian(),
  '/api/seismic': () => handleSeismic(),
};

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(req, res, 405, { error: 'method not allowed' });
  }

  if (pathname === '/api/wire') {
    return sendJSON(req, res, 200, await handleWire(url.searchParams));
  }

  const theaterMatch = /^\/api\/theater\/([a-z0-9_-]+)$/i.exec(pathname);
  if (theaterMatch) {
    const result = await handleTheater(theaterMatch[1]);
    if (result.status === 404) return sendJSON(req, res, 404, result.body);
    return sendJSON(req, res, 200, result);
  }

  const handler = API[pathname];
  if (handler) return sendJSON(req, res, 200, await handler());

  if (pathname.startsWith('/api/')) {
    return sendJSON(req, res, 404, { error: 'unknown endpoint' });
  }

  return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (res.statusCode >= 400 || ms > 2000) {
      console.log(`${req.method} ${req.url} -> ${res.statusCode} ${ms}ms`);
    }
  });

  route(req, res).catch((err) => {
    console.error('unhandled route error:', err);
    if (!res.headersSent) sendJSON(req, res, 500, { error: 'internal error' });
    else res.end();
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function warm() {
  // Populate caches in the background so the first visitor is not the one
  // paying for a cold fetch. Failures are logged and retried on demand.
  const jobs = [
    ['wire', getWire()],
    ['markets', getMarkets()],
  ];
  for (const [name, p] of jobs) {
    p.then(
      () => console.log(`warm: ${name} ready`),
      (err) => console.warn(`warm: ${name} failed — ${err.message || err}`)
    );
  }

  // Stagger the heavier GDELT work so boot does not fan out 25 requests at once.
  setTimeout(() => {
    getGeo().then(
      (g) => console.log(`warm: geo ready (${g.points.length} points)`),
      (err) => console.warn(`warm: geo failed — ${err.message || err}`)
    );
  }, 4000);
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`conflict-monitor listening on :${PORT}`);
    warm();
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`${sig} received, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }
}

module.exports = { server, route, handleOverview, handleHealth, cache };
