'use strict';

const crypto = require('crypto');
const { get, settleAll } = require('../lib/fetch');
const { parseXML, find, findAll, children, textOf, stripHtml } = require('../lib/xml');
const { classify, signals } = require('../lib/classify');
const { FEEDS, TTL, googleNewsUrl } = require('../config');

/**
 * Normalise one RSS 2.0 / RSS 1.0 (RDF) / Atom document into a flat item list.
 * Feeds in the wild mix all three, sometimes within one publisher.
 */
function parseFeed(xmlText, feed) {
  const doc = parseXML(xmlText);

  // RSS/RDF use <item>; Atom uses <entry>.
  const nodes = [...findAll(doc, 'item'), ...findAll(doc, 'entry')];
  const out = [];

  for (const node of nodes) {
    const title = stripHtml(textOf(node, 'title'), 300);
    const url = extractLink(node);
    if (!title || !url) continue;

    const published = extractDate(node);
    const summary = stripHtml(
      textOf(node, 'description') ||
        textOf(node, 'summary') ||
        textOf(node, 'content') ||
        '',
      420
    );

    const haystack = `${title} ${summary}`;
    const { ids: theaters, scores } = classify(haystack);
    const sig = signals(haystack);

    out.push({
      id: hash(url || title),
      title,
      url,
      summary,
      source: feed.name,
      sourceId: feed.id,
      lane: feed.lane,
      weight: feed.weight,
      publishedAt: published ? published.toISOString() : null,
      publishedMs: published ? published.getTime() : null,
      theaters,
      theaterScores: scores,
      signals: sig.tags,
      signalScore: sig.score,
    });
  }
  return out;
}

function extractLink(node) {
  // Atom: <link rel="alternate" href="..."/> — prefer the alternate rel.
  const linkNodes = children(node, 'link').concat(
    children(node, 'link').length ? [] : findAll(node, 'link')
  );
  let fallback = '';
  for (const l of linkNodes) {
    const href = l.attrs && l.attrs.href;
    if (!href) continue;
    const rel = (l.attrs.rel || 'alternate').toLowerCase();
    if (rel === 'alternate') return href.trim();
    if (!fallback) fallback = href.trim();
  }
  // RSS: <link>https://…</link>
  const text = textOf(node, 'link');
  if (text) return text.trim();
  if (fallback) return fallback;

  // Last resort: a guid that happens to be a permalink.
  const guid = textOf(node, 'guid');
  return /^https?:\/\//i.test(guid) ? guid.trim() : '';
}

const DATE_FIELDS = ['pubdate', 'published', 'updated', 'dc:date', 'date', 'lastbuilddate'];

function extractDate(node) {
  for (const field of DATE_FIELDS) {
    const raw = textOf(node, field);
    if (!raw) continue;
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

/** Normalise a headline for near-duplicate detection across syndicating outlets. */
function dedupeKey(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an|of|in|on|at|to|for|and|as|is|are|says|say|after|amid)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 9)
    .join(' ');
}

/**
 * Fetch every configured feed concurrently. Individual failures are recorded
 * and skipped — a dead feed must never blank the wire.
 */
async function fetchWire() {
  const results = await settleAll(
    FEEDS,
    async (feed) => {
      const xml = await get(feed.url, {
        timeout: 12_000,
        retries: 1,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      });
      return parseFeed(xml, feed);
    },
    8
  );

  const items = [];
  const sourceStatus = [];

  for (const r of results) {
    sourceStatus.push({
      id: r.item.id,
      name: r.item.name,
      lane: r.item.lane,
      ok: r.ok,
      count: r.ok ? r.value.length : 0,
      ms: r.ms,
      error: r.ok ? null : r.error,
    });
    if (r.ok) items.push(...r.value);
  }

  return { items: rankAndDedupe(items), sourceStatus };
}

/**
 * Merge, drop near-duplicates (keeping the highest-weighted source), and sort
 * by recency with a modest quality nudge.
 */
function rankAndDedupe(items, { limit = 400 } = {}) {
  const byUrl = new Map();
  for (const it of items) {
    const existing = byUrl.get(it.url);
    if (!existing || it.weight > existing.weight) byUrl.set(it.url, it);
  }

  const byTitle = new Map();
  for (const it of byUrl.values()) {
    const key = dedupeKey(it.title);
    if (!key) continue;
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, { ...it, alsoReportedBy: [] });
      continue;
    }
    // Keep the stronger source, but remember who else carried it — corroboration
    // count is itself a useful signal on a wire.
    if (it.weight > existing.weight) {
      const merged = { ...it, alsoReportedBy: existing.alsoReportedBy };
      if (!merged.alsoReportedBy.includes(existing.source)) {
        merged.alsoReportedBy.push(existing.source);
      }
      byTitle.set(key, merged);
    } else if (!existing.alsoReportedBy.includes(it.source) && it.source !== existing.source) {
      existing.alsoReportedBy.push(it.source);
    }
  }

  const now = Date.now();
  const list = [...byTitle.values()];
  list.sort((a, b) => {
    const at = a.publishedMs || 0;
    const bt = b.publishedMs || 0;
    return bt - at;
  });

  return list.slice(0, limit).map((it) => ({
    ...it,
    ageMinutes: it.publishedMs ? Math.round((now - it.publishedMs) / 60_000) : null,
    corroboration: 1 + (it.alsoReportedBy ? it.alsoReportedBy.length : 0),
  }));
}

/** Theater-specific drilldown via a Google News query feed. */
async function fetchTheaterWire(theater) {
  const url = googleNewsUrl(theater.query);
  const xml = await get(url, {
    timeout: 12_000,
    retries: 1,
    accept: 'application/rss+xml, application/xml, text/xml, */*',
  });
  const items = parseFeed(xml, {
    id: `gnews-${theater.id}`,
    name: 'Google News',
    lane: 'aggregate',
    weight: 0.6,
  });
  // Google News wraps the publisher name into the title after a trailing dash.
  for (const it of items) {
    const m = it.title.match(/^(.*)\s+-\s+([^-]{2,40})$/);
    if (m) {
      it.title = m[1].trim();
      it.source = m[2].trim();
    }
  }
  return rankAndDedupe(items, { limit: 40 });
}

module.exports = { fetchWire, fetchTheaterWire, parseFeed, rankAndDedupe, dedupeKey, TTL };
