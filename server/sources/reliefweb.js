'use strict';

const { get } = require('../lib/fetch');
const { classify } = require('../lib/classify');

/**
 * ReliefWeb (UN OCHA) — humanitarian situation reports and active disaster
 * records. Public API, no key; it only asks that callers identify themselves
 * with an `appname`.
 */

const BASE = 'https://api.reliefweb.int/v1';
const APPNAME = 'conflict-monitor';

function buildUrl(path, params) {
  const qs = new URLSearchParams();
  qs.set('appname', APPNAME);
  for (const [k, v] of params) qs.append(k, v);
  return `${BASE}/${path}?${qs.toString()}`;
}

/** Latest situation reports, biased toward conflict-driven emergencies. */
async function fetchReports({ limit = 30 } = {}) {
  const url = buildUrl('reports', [
    ['limit', String(limit)],
    ['sort[]', 'date.created:desc'],
    ['fields[include][]', 'title'],
    ['fields[include][]', 'url'],
    ['fields[include][]', 'date.created'],
    ['fields[include][]', 'source.name'],
    ['fields[include][]', 'primary_country.name'],
    ['fields[include][]', 'primary_country.iso3'],
    ['fields[include][]', 'disaster_type.name'],
    ['filter[field]', 'format.name'],
    ['filter[value][]', 'Situation Report'],
  ]);

  const data = await get(url, { timeout: 15_000, retries: 1, as: 'json' });
  const rows = Array.isArray(data && data.data) ? data.data : [];

  return rows.map((row) => {
    const f = row.fields || {};
    const country = f.primary_country || {};
    const title = String(f.title || '').trim();
    const { ids: theaters } = classify(`${title} ${country.name || ''}`);
    return {
      id: String(row.id),
      title,
      url: f.url || '',
      country: country.name || null,
      iso3: country.iso3 || null,
      sources: (f.source || []).map((s) => s.name).filter(Boolean).slice(0, 3),
      types: (f.disaster_type || []).map((d) => d.name).filter(Boolean),
      createdAt: f.date && f.date.created ? f.date.created : null,
      theaters,
    };
  });
}

/** Currently active disaster records — famine, displacement, epidemics. */
async function fetchDisasters({ limit = 25 } = {}) {
  const url = buildUrl('disasters', [
    ['limit', String(limit)],
    ['sort[]', 'date.created:desc'],
    ['fields[include][]', 'name'],
    ['fields[include][]', 'url'],
    ['fields[include][]', 'status'],
    ['fields[include][]', 'date.created'],
    ['fields[include][]', 'primary_country.name'],
    ['fields[include][]', 'primary_country.iso3'],
    ['fields[include][]', 'primary_type.name'],
    ['filter[field]', 'status'],
    ['filter[value]', 'ongoing'],
  ]);

  const data = await get(url, { timeout: 15_000, retries: 1, as: 'json' });
  const rows = Array.isArray(data && data.data) ? data.data : [];

  return rows.map((row) => {
    const f = row.fields || {};
    const country = f.primary_country || {};
    const name = String(f.name || '').trim();
    const { ids: theaters } = classify(`${name} ${country.name || ''}`);
    return {
      id: String(row.id),
      name,
      url: f.url || '',
      status: f.status || null,
      type: f.primary_type ? f.primary_type.name : null,
      country: country.name || null,
      iso3: country.iso3 || null,
      createdAt: f.date && f.date.created ? f.date.created : null,
      theaters,
    };
  });
}

async function fetchHumanitarian() {
  const [reportsRes, disastersRes] = await Promise.allSettled([
    fetchReports(),
    fetchDisasters(),
  ]);

  return {
    reports: reportsRes.status === 'fulfilled' ? reportsRes.value : [],
    disasters: disastersRes.status === 'fulfilled' ? disastersRes.value : [],
    errors: [
      reportsRes.status === 'rejected'
        ? `reports: ${reportsRes.reason?.message || reportsRes.reason}`
        : null,
      disastersRes.status === 'rejected'
        ? `disasters: ${disastersRes.reason?.message || disastersRes.reason}`
        : null,
    ].filter(Boolean),
  };
}

module.exports = { fetchHumanitarian, fetchReports, fetchDisasters };
