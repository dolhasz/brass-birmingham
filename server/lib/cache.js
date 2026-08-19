'use strict';

/**
 * TTL cache with stale-while-revalidate semantics.
 *
 * A dashboard should never block on a slow upstream. Three windows:
 *   - fresh  (age < ttl)          -> return immediately, no refresh
 *   - stale  (ttl <= age < ttl+grace) -> return immediately, refresh in background
 *   - cold   (age >= ttl+grace)   -> await a fresh fetch, but fall back to the
 *                                    stale value if that fetch fails
 *
 * Concurrent callers for the same key share a single in-flight producer.
 */
class TTLCache {
  constructor({ name = 'cache' } = {}) {
    this.name = name;
    this.entries = new Map(); // key -> { value, at, error, errorAt }
    this.inflight = new Map(); // key -> Promise
  }

  peek(key) {
    return this.entries.get(key) || null;
  }

  set(key, value) {
    this.entries.set(key, { value, at: Date.now(), error: null, errorAt: 0 });
  }

  /**
   * @param {string} key
   * @param {object} opts  { ttl, grace }  milliseconds
   * @param {function(): Promise<any>} producer
   */
  async wrap(key, opts, producer) {
    const ttl = opts.ttl ?? 60_000;
    const grace = opts.grace ?? ttl * 10;
    const entry = this.entries.get(key);
    const age = entry ? Date.now() - entry.at : Infinity;

    if (entry && age < ttl) return entry.value;

    if (entry && age < ttl + grace) {
      // Serve stale, refresh behind the scenes.
      this._refresh(key, producer).catch(() => {});
      return entry.value;
    }

    try {
      return await this._refresh(key, producer);
    } catch (err) {
      if (entry) return entry.value; // expired, but better than nothing
      throw err;
    }
  }

  _refresh(key, producer) {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        const value = await producer();
        this.entries.set(key, { value, at: Date.now(), error: null, errorAt: 0 });
        return value;
      } catch (err) {
        const prev = this.entries.get(key);
        if (prev) {
          prev.error = err.message || String(err);
          prev.errorAt = Date.now();
        }
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }

  /** Diagnostic snapshot for the health endpoint. */
  stats() {
    const now = Date.now();
    const out = {};
    for (const [key, e] of this.entries) {
      out[key] = {
        ageMs: now - e.at,
        hasValue: e.value !== undefined && e.value !== null,
        lastError: e.error,
        lastErrorAgeMs: e.errorAt ? now - e.errorAt : null,
      };
    }
    return out;
  }
}

module.exports = { TTLCache };
