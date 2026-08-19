'use strict';

const { get, settleAll } = require('../lib/fetch');
const { parseCSVObjects, num } = require('../lib/csv');
const { INSTRUMENTS, STRESS_WEIGHTS } = require('../config');

/**
 * Market data from Stooq's public CSV endpoints — no API key required.
 *
 *   snapshot: /q/l/?s=a+b+c&f=sd2t2ohlcv&h&e=csv   (one call, all symbols)
 *   history:  /q/d/l/?s=a&d1=…&d2=…&i=d            (per symbol, daily bars)
 *
 * History is the primary source: it yields the prior close needed for a change
 * calculation plus the series behind each sparkline. The snapshot is layered on
 * top for a fresher last price when the session is open.
 */

const SNAPSHOT_URL = 'https://stooq.com/q/l/';
const HISTORY_URL = 'https://stooq.com/q/d/l/';

function ymd(d) {
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

async function fetchSnapshot() {
  const symbols = INSTRUMENTS.map((i) => i.symbol).join('+');
  const url = `${SNAPSHOT_URL}?s=${encodeURIComponent(symbols)}&f=sd2t2ohlcv&h&e=csv`;
  const csv = await get(url, { timeout: 12_000, retries: 1, accept: 'text/csv, */*' });
  const rows = parseCSVObjects(csv);
  const bySymbol = {};
  for (const r of rows) {
    const sym = (r.symbol || '').toLowerCase();
    if (!sym) continue;
    bySymbol[sym] = {
      close: num(r.close),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      volume: num(r.volume),
      date: r.date || null,
      time: r.time || null,
    };
  }
  return bySymbol;
}

async function fetchHistory(symbol, days = 90) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const url =
    `${HISTORY_URL}?s=${encodeURIComponent(symbol)}` +
    `&d1=${ymd(start)}&d2=${ymd(end)}&i=d`;
  const csv = await get(url, { timeout: 12_000, retries: 1, accept: 'text/csv, */*' });
  const rows = parseCSVObjects(csv);
  const bars = [];
  for (const r of rows) {
    const close = num(r.close);
    if (close === null || !r.date) continue;
    bars.push({ date: r.date, close, high: num(r.high), low: num(r.low) });
  }
  return bars;
}

/**
 * Build the full market board. Instruments resolve independently, so a symbol
 * Stooq has retired or renamed degrades to `unavailable` instead of failing
 * the panel.
 */
async function fetchMarkets() {
  let snapshot = {};
  let snapshotError = null;
  try {
    snapshot = await fetchSnapshot();
  } catch (err) {
    snapshotError = err.message || String(err);
  }

  const results = await settleAll(
    INSTRUMENTS,
    async (inst) => fetchHistory(inst.symbol),
    6
  );

  const quotes = [];
  const status = [];

  for (let i = 0; i < INSTRUMENTS.length; i++) {
    const inst = INSTRUMENTS[i];
    const r = results[i];
    const snap = snapshot[inst.symbol.toLowerCase()] || null;

    status.push({
      symbol: inst.symbol,
      ok: r.ok && r.value.length > 0,
      bars: r.ok ? r.value.length : 0,
      ms: r.ms,
      error: r.ok ? (r.value.length ? null : 'no bars returned') : r.error,
    });

    const bars = r.ok ? r.value : [];
    if (bars.length === 0 && !snap) {
      quotes.push({ ...inst, available: false, last: null, changePct: null, series: [] });
      continue;
    }

    const lastBar = bars.length ? bars[bars.length - 1] : null;
    const prevBar = bars.length > 1 ? bars[bars.length - 2] : null;

    // Prefer the live snapshot price when it is present and plausible.
    const last = snap && snap.close !== null ? snap.close : lastBar ? lastBar.close : null;

    // Compare against the most recent completed session that is not the same
    // bar the snapshot represents.
    let reference = null;
    if (snap && snap.close !== null && lastBar) {
      reference = snap.date && lastBar.date === snap.date ? (prevBar ? prevBar.close : null) : lastBar.close;
    } else if (prevBar) {
      reference = prevBar.close;
    }

    let change = last !== null && reference !== null ? last - reference : null;
    let changePct = change !== null && reference ? (change / reference) * 100 : null;

    // Guard against a mismatched or stale upstream payload. None of these
    // instruments moves ±75% in a session, so a reading that large means the
    // reference belongs to a different series — show no change rather than a
    // fabricated one.
    let suspect = false;
    if (changePct !== null && Math.abs(changePct) > 75) {
      suspect = true;
      change = null;
      changePct = null;
    }

    const series = bars.slice(-60).map((b) => b.close);
    if (snap && snap.close !== null && series.length) {
      if (!lastBar || (snap.date && lastBar.date !== snap.date)) series.push(snap.close);
      else series[series.length - 1] = snap.close;
    }

    quotes.push({
      ...inst,
      available: last !== null,
      last,
      reference: suspect ? null : reference,
      change,
      changePct,
      suspect,
      asOf: snap ? `${snap.date || ''} ${snap.time || ''}`.trim() : lastBar ? lastBar.date : null,
      series,
      range30: rangePosition(bars.slice(-30), last),
    });
  }

  return {
    quotes,
    stress: computeStress(quotes),
    status,
    snapshotError,
  };
}

/** Where the current price sits within its recent range (0 = low, 1 = high). */
function rangePosition(bars, last) {
  if (!bars.length || last === null) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    const l = b.low !== null ? b.low : b.close;
    const h = b.high !== null ? b.high : b.close;
    if (l < lo) lo = l;
    if (h > hi) hi = h;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return null;
  return Math.max(0, Math.min(1, (last - lo) / (hi - lo)));
}

/**
 * Composite market-stress reading, 0–100.
 *
 * This is a transparent weighted blend of daily moves in risk-sensitive
 * instruments (see STRESS_WEIGHTS) — safe-haven bid, energy shock and equity
 * drawdown. It describes how markets moved today, and nothing more; it is not
 * a forecast and carries no information about intent or capability.
 */
function computeStress(quotes) {
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  let acc = 0;
  let usedWeight = 0;
  const components = [];

  for (const w of STRESS_WEIGHTS) {
    const q = bySymbol.get(w.symbol);
    if (!q || q.changePct === null || !Number.isFinite(q.changePct)) continue;

    // A 3% adverse daily move maps to a full-scale contribution.
    const normalised = Math.max(-1, Math.min(1, (q.changePct * w.dir) / 3));
    acc += normalised * w.weight;
    usedWeight += w.weight;
    components.push({
      symbol: w.symbol,
      name: q.name,
      changePct: q.changePct,
      contribution: normalised * w.weight,
    });
  }

  if (usedWeight === 0) {
    return { value: null, components: [], coverage: 0 };
  }

  // Rescale to the weight actually observed, then map [-1,1] -> [0,100].
  const scaled = acc / usedWeight;
  const value = Math.round(((scaled + 1) / 2) * 100);

  return {
    value,
    components: components.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    coverage: usedWeight / STRESS_WEIGHTS.reduce((s, w) => s + w.weight, 0),
  };
}

module.exports = { fetchMarkets, computeStress, rangePosition, fetchHistory, fetchSnapshot };
