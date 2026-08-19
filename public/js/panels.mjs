/**
 * Panel renderers. Each takes a container plus data and rebuilds that panel's
 * subtree. Feed-derived strings always go through h()'s text handling.
 */

import { h, replace, fmtAge, fmtNum, fmtPct, direction, sparkPath, timeAgoFrom } from './util.mjs';

const GAUGE_LEN = 157; // arc length of the semicircle in index.html

const LEVEL_WORD = {
  1: 'Background',
  2: 'Low',
  3: 'Active',
  4: 'High',
  5: 'Severe',
};

// ---------------------------------------------------------------------------
// Composite index
// ---------------------------------------------------------------------------

export function renderComposite({ headerValue, headerBand, gaugeFill, gaugeValue, list }, composite) {
  const value = composite && composite.value !== null ? composite.value : null;
  const band = composite && composite.band ? composite.band : null;

  headerValue.textContent = value === null ? '--' : String(value);
  gaugeValue.textContent = value === null ? '--' : String(value);

  headerBand.textContent = band ? band.label : 'awaiting data';
  headerBand.className = 'composite-band' + (band ? ` band-${band.id}` : '');

  const color = band
    ? getComputedStyle(document.documentElement).getPropertyValue(bandVar(band.id)).trim()
    : '';
  if (color) {
    gaugeFill.style.stroke = color;
    headerValue.style.color = color;
  }
  gaugeFill.style.strokeDashoffset = String(
    value === null ? GAUGE_LEN : GAUGE_LEN * (1 - Math.max(0, Math.min(100, value)) / 100)
  );

  const rows = (composite && composite.components ? composite.components : []).map((c) =>
    h(
      'li',
      {},
      h(
        'div',
        { class: 'component-head' },
        h('span', { text: c.label }),
        h('b', { text: c.value === null ? 'n/a' : String(c.value) })
      ),
      h(
        'div',
        { class: 'component-bar' },
        h('i', { style: `width:${c.value === null ? 0 : Math.max(0, Math.min(100, c.value))}%` })
      ),
      h('div', { class: 'component-basis', text: c.basis })
    )
  );
  replace(list, rows);
}

function bandVar(id) {
  return (
    {
      low: '--lvl-2',
      moderate: '--lvl-2',
      guarded: '--lvl-3',
      elevated: '--lvl-4',
      severe: '--lvl-5',
    }[id] || '--lvl-2'
  );
}

// ---------------------------------------------------------------------------
// Theater watchlist
// ---------------------------------------------------------------------------

export function renderTheaters(container, theaters, { selectedId, onSelect }) {
  if (!theaters || !theaters.length) {
    return replace(container, h('div', { class: 'placeholder', text: 'No theater data.' }));
  }

  const rows = theaters.map((t) => {
    const row = h(
      'div',
      {
        class: 'theater-row' + (t.id === selectedId ? ' selected' : ''),
        role: 'listitem',
        tabindex: '0',
        dataset: { theater: t.id },
      },
      h('span', { class: `theater-flag lvl-${t.level}` }),
      h(
        'div',
        { class: 'theater-main' },
        h('div', { class: 'theater-name', text: t.name }),
        h('div', {
          class: 'theater-sub',
          text: `${LEVEL_WORD[t.level] || ''} · ${t.itemCount} item${t.itemCount === 1 ? '' : 's'}${
            t.latestAt ? ' · ' + fmtAge(timeAgoFrom(t.latestAt)) : ''
          }`,
        }),
        t.signalTags && t.signalTags.length
          ? h(
              'div',
              { class: 'sig-tags' },
              t.signalTags
                .slice(0, 4)
                .map((s) => h('span', { class: 'sig-tag', dataset: { tag: s.tag }, text: s.tag }))
            )
          : null
      ),
      h(
        'div',
        { class: 'theater-metric' },
        h('div', {
          class: 'theater-intensity',
          text: String(t.reportingIntensity),
          style: `color: var(--lvl-${t.level})`,
        }),
        h('div', { class: 'theater-count', text: 'intensity' })
      )
    );

    row.addEventListener('click', () => onSelect(t.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(t.id);
      }
    });
    return row;
  });

  return replace(container, rows);
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

export function renderWire(container, items, theaterNames = {}) {
  if (!items || !items.length) {
    return replace(
      container,
      h('div', { class: 'placeholder', text: 'No matching items.' })
    );
  }

  const nodes = items.map((it) =>
    h(
      'a',
      {
        class: 'wire-item',
        href: it.url || '#',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      h(
        'div',
        { class: 'wire-head' },
        h('span', { class: 'wire-source', text: it.source || 'unknown' }),
        it.corroboration > 1
          ? h('span', { class: 'wire-corr', text: `×${it.corroboration}` })
          : null,
        h('span', { class: 'wire-age', text: fmtAge(it.ageMinutes) })
      ),
      h('div', { class: 'wire-title', text: it.title }),
      it.theaters && it.theaters.length
        ? h(
            'div',
            { class: 'wire-tags' },
            it.theaters
              .slice(0, 3)
              .map((tid) =>
                h('span', { class: 'wire-theater', text: theaterNames[tid] || tid })
              )
          )
        : null
    )
  );

  return replace(container, nodes);
}

// ---------------------------------------------------------------------------
// Market ticker
// ---------------------------------------------------------------------------

export function renderTicker(container, quotes) {
  if (!quotes || !quotes.length) {
    return replace(container, h('span', { class: 'placeholder', text: 'Market data unavailable.' }));
  }

  const nodes = quotes.map((q) => {
    if (!q.available) {
      return h(
        'div',
        { class: 'tick unavailable' },
        h('div', { class: 'tick-name', text: q.name }),
        h('div', { class: 'tick-row' }, h('span', { class: 'tick-price', text: '—' }))
      );
    }

    const dir = direction(q.changePct, 0.005);
    const d = sparkPath(q.series || [], 62, 15);

    return h(
      'div',
      { class: 'tick', title: `${q.name}${q.unit ? ' · ' + q.unit : ''}${q.asOf ? ' · ' + q.asOf : ''}` },
      h('div', { class: 'tick-name', text: q.name }),
      h(
        'div',
        { class: 'tick-row' },
        h('span', { class: 'tick-price', text: fmtNum(q.last) }),
        h('span', { class: `tick-change ${dir}`, text: fmtPct(q.changePct) })
      ),
      d ? sparkSvg(d, dir) : null
    );
  });

  return replace(container, nodes);
}

function sparkSvg(d, dir) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `spark ${dir}`);
  svg.setAttribute('width', '62');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 62 15');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

// ---------------------------------------------------------------------------
// Seismic
// ---------------------------------------------------------------------------

export function renderSeismic(container, data) {
  const events = (data && data.events) || [];
  if (!events.length) {
    return replace(container, h('div', { class: 'placeholder', text: 'No recent M4.5+ events.' }));
  }

  // Anything flagged floats to the top; the rest is chronological.
  const flagged = events.filter((e) => e.explosionLike || e.type !== 'earthquake');
  const rest = events.filter((e) => !(e.explosionLike || e.type !== 'earthquake'));
  const ordered = [...flagged, ...rest].slice(0, 25);

  const nodes = ordered.map((e) =>
    h(
      'a',
      {
        class: 'mini-item' + (e.explosionLike || e.type !== 'earthquake' ? ' flagged' : ''),
        href: e.url || '#',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      h(
        'div',
        { class: 'mini-head' },
        h('span', { class: 'mini-mag', text: `M${fmtNum(e.mag, 1)}` }),
        h('span', { text: e.depthKm !== null ? `${fmtNum(e.depthKm, 0)}km` : '' }),
        h('span', { class: 'wire-age', text: fmtAge(timeAgoFrom(e.time)) })
      ),
      h('div', { text: e.place || 'unknown location' }),
      e.nearTestSite
        ? h('div', {
            class: 'mini-flag',
            text: `near ${e.nearTestSite.name} (${e.nearTestSite.km}km)`,
          })
        : null,
      e.type !== 'earthquake'
        ? h('div', { class: 'mini-flag', text: `USGS type: ${e.type}` })
        : null
    )
  );

  return replace(container, nodes);
}

// ---------------------------------------------------------------------------
// Humanitarian
// ---------------------------------------------------------------------------

export function renderHumanitarian(container, data) {
  const disasters = (data && data.disasters) || [];
  const reports = (data && data.reports) || [];

  if (!disasters.length && !reports.length) {
    return replace(container, h('div', { class: 'placeholder', text: 'No data available.' }));
  }

  const nodes = [];

  for (const d of disasters.slice(0, 8)) {
    nodes.push(
      h(
        'a',
        { class: 'mini-item', href: d.url || '#', target: '_blank', rel: 'noopener noreferrer' },
        h(
          'div',
          { class: 'mini-head' },
          h('span', { class: 'mini-mag', text: d.country || '—' }),
          h('span', { text: d.type || '' })
        ),
        h('div', { text: d.name })
      )
    );
  }

  for (const r of reports.slice(0, 10)) {
    nodes.push(
      h(
        'a',
        { class: 'mini-item', href: r.url || '#', target: '_blank', rel: 'noopener noreferrer' },
        h(
          'div',
          { class: 'mini-head' },
          h('span', { class: 'mini-mag', text: r.country || '—' }),
          h('span', { class: 'wire-age', text: fmtAge(timeAgoFrom(r.createdAt)) })
        ),
        h('div', { text: r.title })
      )
    );
  }

  return replace(container, nodes);
}

// ---------------------------------------------------------------------------
// Theater drawer
// ---------------------------------------------------------------------------

export function renderDrawer({ title, sub, body }, data) {
  const t = data.theater;
  const s = t.status || {};

  title.textContent = t.name;
  sub.textContent = `${t.region} · ${t.context}`;

  const stats = h(
    'div',
    { class: 'stat-grid' },
    stat('Reporting intensity', String(s.reportingIntensity ?? '—'), 'relative to all theaters'),
    stat(`Level ${s.level ?? '—'}`, LEVEL_WORD[s.level] || '—', `baseline ${t.baseline}`),
    stat('Items (24h+)', String(s.itemCount ?? 0), 'classified wire items'),
    stat('Latest', s.latestAt ? fmtAge(timeAgoFrom(s.latestAt)) : '—', 'most recent item')
  );

  const children = [stats];

  if (s.gdelt && (s.gdelt.latestVolume !== null || s.gdelt.latestTone !== null)) {
    children.push(
      h('div', { class: 'drawer-section-title', text: 'GDELT signal (7 day)' }),
      h(
        'div',
        { class: 'stat-grid' },
        stat(
          'Coverage volume',
          s.gdelt.latestVolume !== null ? fmtNum(s.gdelt.latestVolume, 3) + '%' : '—',
          s.gdelt.volumeTrend !== null && s.gdelt.volumeTrend !== undefined
            ? `${fmtPct(s.gdelt.volumeTrend, 0)} vs earlier`
            : 'share of monitored coverage'
        ),
        stat(
          'Coverage tone',
          s.gdelt.latestTone !== null ? fmtNum(s.gdelt.latestTone, 2) : '—',
          'negative = more negative'
        )
      )
    );
  }

  if (s.signalTags && s.signalTags.length) {
    children.push(
      h('div', { class: 'drawer-section-title', text: 'Detected language' }),
      h(
        'div',
        { class: 'sig-tags' },
        s.signalTags.map((x) =>
          h('span', { class: 'sig-tag', dataset: { tag: x.tag }, text: `${x.tag} ×${x.n}` })
        )
      )
    );
  }

  if (data.wire && data.wire.length) {
    children.push(h('div', { class: 'drawer-section-title', text: 'From monitored sources' }));
    const list = h('div', {});
    renderWire(list, data.wire.slice(0, 15));
    children.push(list);
  }

  if (data.drilldown && data.drilldown.length) {
    children.push(h('div', { class: 'drawer-section-title', text: 'Wider search' }));
    const list = h('div', {});
    renderWire(list, data.drilldown.slice(0, 15));
    children.push(list);
  }

  if (data.errors && data.errors.length) {
    children.push(
      h('div', { class: 'drawer-section-title', text: 'Source issues' }),
      h(
        'div',
        { class: 'source-status' },
        data.errors.map((e) => h('div', { class: 'src-bad', text: e }))
      )
    );
  }

  return replace(body, children);
}

function stat(label, value, note) {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'stat-label', text: label }),
    h('div', { class: 'stat-value', text: value }),
    note ? h('div', { class: 'stat-note', text: note }) : null
  );
}

// ---------------------------------------------------------------------------
// Source status (methodology dialog)
// ---------------------------------------------------------------------------

export function renderSourceStatus(container, sources) {
  if (!sources || !sources.length) {
    return replace(container, h('span', { text: 'Source status unavailable.' }));
  }
  const nodes = sources.map((s) =>
    h(
      'div',
      {},
      h('span', { class: s.ok ? 'src-ok' : 'src-bad', text: s.ok ? '● ' : '○ ' }),
      h('span', { text: `${s.name} — ${s.ok ? `${s.count} items` : s.error || 'unavailable'}` })
    )
  );
  return replace(container, nodes);
}
