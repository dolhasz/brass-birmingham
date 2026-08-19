'use strict';

/**
 * Fixture-backed replacement for globalThis.fetch.
 *
 * Routes upstream URLs to recorded payloads so the real adapters can be
 * exercised without network access. Anything not explicitly routed returns 500
 * on purpose, which keeps the partial-failure paths under test.
 */

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const readFix = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

function makeResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => body,
  };
}

function timeline(series, valueAt) {
  return JSON.stringify({
    timeline: [
      {
        series,
        data: Array.from({ length: 12 }, (_, i) => ({
          date: `202608${String(i + 1).padStart(2, '0')}T120000Z`,
          value: valueAt(i),
        })),
      },
    ],
  });
}

/** Anchor prices roughly matching each instrument's real order of magnitude. */
const BASE_PRICE = {
  'cl.f': 80.95, 'cb.f': 84.6, 'ng.f': 3.25, 'gc.f': 2402.0, 'si.f': 30.4,
  'hg.f': 4.12, 'zw.f': 545.0, 'zc.f': 421.0, '^spx': 5380.0, '^ndq': 18510.0,
  '^dax': 18240.0, '^nkx': 38900.0, '^hsi': 17650.0, '^vix': 17.9,
  eurusd: 1.086, usdjpy: 147.2, usdchf: 0.882, gbpusd: 1.274,
};

function syntheticHistory(symbol) {
  const base = BASE_PRICE[symbol] ?? 100;
  // Deterministic pseudo-random walk so runs are reproducible.
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) % 9973;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const rows = ['Date,Open,High,Low,Close,Volume'];
  let price = base * 0.97;
  for (let d = 1; d <= 20; d++) {
    const drift = (rand() - 0.48) * base * 0.012;
    const open = price;
    price = Math.max(base * 0.6, price + drift);
    const high = Math.max(open, price) * (1 + rand() * 0.004);
    const low = Math.min(open, price) * (1 - rand() * 0.004);
    const date = `2026-07-${String(d + 10).padStart(2, '0')}`;
    rows.push(
      [date, open, high, low, price, Math.round(100000 + rand() * 500000)]
        .map((v) => (typeof v === 'number' ? v.toFixed(4).replace(/\.?0+$/, '') : v))
        .join(',')
    );
  }
  return rows.join('\n') + '\n';
}

/**
 * A risk-off session: energy and safe havens bid, equities lower, VIX sharply
 * up — so the stress index and composite have something real to compute from.
 */
const SNAPSHOT_ROWS = [
  ['CL.F', 83.1], ['CB.F', 87.2], ['NG.F', 3.39], ['GC.F', 2461.3], ['SI.F', 31.22],
  ['HG.F', 4.05], ['ZW.F', 552.0], ['ZC.F', 418.0], ['^SPX', 5290.4], ['^NDQ', 18180.6],
  ['^DAX', 18010.2], ['^NKX', 38400.0], ['^HSI', 17490.0], ['^VIX', 22.4],
  ['EURUSD', 1.0802], ['USDJPY', 148.6], ['USDCHF', 0.891], ['GBPUSD', 1.2665],
];

const SNAPSHOT_CSV =
  'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
  SNAPSHOT_ROWS.map(
    ([sym, close]) =>
      `${sym},2026-08-19,20:15:00,${(close * 0.995).toFixed(4)},${(close * 1.01).toFixed(4)},` +
      `${(close * 0.99).toFixed(4)},${close},0`
  ).join('\n') +
  '\n';

function route(url) {
  const u = String(url);

  if (u.includes('aljazeera') || u.includes('bbci.co.uk') || u.includes('theguardian')) {
    return makeResponse(readFix('rss2.xml'));
  }
  if (u.includes('defensenews') || u.includes('breakingdefense') || u.includes('nato.int')) {
    return makeResponse(readFix('atom.xml'));
  }
  if (u.includes('rss.dw.com') || u.includes('news.un.org')) {
    return makeResponse(readFix('rdf.xml'));
  }
  if (u.includes('news.google.com')) return makeResponse(readFix('rss2.xml'));

  if (u.includes('api.gdeltproject.org/api/v2/geo')) return makeResponse(readFix('gdelt-geo.json'));
  if (u.includes('mode=timelinevol')) return makeResponse(timeline('Volume Intensity', (i) => 0.4 + i * 0.05));
  if (u.includes('mode=timelinetone')) return makeResponse(timeline('Average Tone', (i) => -2 - i * 0.2));

  if (u.includes('earthquake.usgs.gov')) return makeResponse(readFix('usgs.geojson'));

  if (u.includes('stooq.com/q/d/l')) {
    // Synthesise a plausible series per symbol so the ticker under test shows
    // realistic moves rather than one instrument's prices under every label.
    const sym = decodeURIComponent((/[?&]s=([^&]+)/.exec(u) || [, 'cl.f'])[1]).toLowerCase();
    return makeResponse(syntheticHistory(sym));
  }
  if (u.includes('stooq.com/q/l')) return makeResponse(SNAPSHOT_CSV);

  if (u.includes('api.reliefweb.int/v1/reports')) {
    return makeResponse(
      JSON.stringify({
        data: [
          {
            id: 4001,
            fields: {
              title: 'Sudan: Humanitarian Situation Report No. 12',
              url: 'https://reliefweb.int/report/sudan/4001',
              date: { created: '2026-08-19T06:00:00+00:00' },
              source: [{ name: 'UNICEF' }],
              primary_country: { name: 'Sudan', iso3: 'SDN' },
              disaster_type: [{ name: 'Complex Emergency' }],
            },
          },
          {
            id: 4002,
            fields: {
              title: 'occupied Palestinian territory: Flash Update #204',
              url: 'https://reliefweb.int/report/opt/4002',
              date: { created: '2026-08-19T04:30:00+00:00' },
              source: [{ name: 'OCHA' }],
              primary_country: { name: 'Palestine', iso3: 'PSE' },
              disaster_type: [],
            },
          },
        ],
      })
    );
  }
  if (u.includes('api.reliefweb.int/v1/disasters')) {
    return makeResponse(
      JSON.stringify({
        data: [
          {
            id: 900,
            fields: {
              name: 'Sudan: Complex Emergency',
              url: 'https://reliefweb.int/disaster/ce-2023-000123-sdn',
              status: 'ongoing',
              date: { created: '2023-04-15T00:00:00+00:00' },
              primary_country: { name: 'Sudan', iso3: 'SDN' },
              primary_type: { name: 'Complex Emergency' },
            },
          },
        ],
      })
    );
  }

  return makeResponse('upstream unavailable', { status: 500 });
}

function install() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => route(url);
  return () => {
    globalThis.fetch = original;
  };
}

module.exports = { install, route, makeResponse, readFix };
