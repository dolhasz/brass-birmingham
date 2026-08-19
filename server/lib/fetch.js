'use strict';

const UA =
  'Mozilla/5.0 (compatible; ConflictMonitor/1.0; +https://github.com/dolhasz/brass-birmingham)';

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * fetch with a hard timeout, bounded retries and sane defaults.
 * Retries only on transient failures (network error, 429, 5xx).
 */
async function get(url, opts = {}) {
  const {
    timeout = 12_000,
    retries = 2,
    backoff = 600,
    accept = '*/*',
    headers = {},
    as = 'text', // 'text' | 'json'
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(backoff * Math.pow(2, attempt - 1));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: accept,
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
      });

      if (!res.ok) {
        const retriable = res.status === 429 || res.status >= 500;
        const body = await safeText(res);
        const err = new HttpError(res.status, url, body.slice(0, 300));
        if (retriable && attempt < retries) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      const text = await res.text();
      if (as === 'json') {
        try {
          return JSON.parse(text);
        } catch {
          // Some upstreams (notably GDELT) emit malformed JSON on error.
          throw new Error(
            `Invalid JSON from ${url}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`
          );
        }
      }
      return text;
    } catch (err) {
      lastErr = err;
      const transient =
        err.name === 'AbortError' ||
        err instanceof TypeError ||
        err.code === 'ECONNRESET' ||
        err.code === 'ENOTFOUND' ||
        (err instanceof HttpError && (err.status === 429 || err.status >= 500));
      if (!transient || attempt === retries) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run many async tasks with bounded concurrency, never rejecting.
 * Returns [{ ok, value | error, meta }] in input order — the caller decides
 * what a partial result means. This is what keeps one dead feed from
 * taking down a whole panel.
 */
async function settleAll(items, worker, concurrency = 6) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const started = Date.now();
      try {
        const value = await worker(items[i], i);
        results[i] = { ok: true, value, item: items[i], ms: Date.now() - started };
      } catch (err) {
        results[i] = {
          ok: false,
          error: err.message || String(err),
          item: items[i],
          ms: Date.now() - started,
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner)
  );
  return results;
}

module.exports = { get, settleAll, sleep, HttpError, UA };
