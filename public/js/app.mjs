/**
 * Application shell: boot, data refresh, and wiring between the map, the
 * panels and the drawer.
 *
 * Each data source refreshes on its own cadence and fails independently — a
 * dead upstream degrades one panel and leaves the rest of the board live.
 */

import { WarMap } from './map.mjs';
import { getJSON, debounce, utcClock, fmtAge, timeAgoFrom, h, replace } from './util.mjs';
import * as panels from './panels.mjs';

const REFRESH = {
  overview: 90_000,
  geo: 6 * 60_000,
  seismic: 6 * 60_000,
  humanitarian: 15 * 60_000,
};

const dom = {
  compositeValue: document.getElementById('composite-value'),
  compositeBand: document.getElementById('composite-band'),
  gaugeFill: document.getElementById('gauge-fill'),
  gaugeValue: document.getElementById('gauge-value'),
  componentList: document.getElementById('component-list'),

  theaterList: document.getElementById('theater-list'),
  theaterCount: document.getElementById('theater-count'),

  mapContainer: document.getElementById('map-container'),
  mapTooltip: document.getElementById('map-tooltip'),
  toggleDensity: document.getElementById('toggle-density'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomReset: document.getElementById('zoom-reset'),

  wireList: document.getElementById('wire-list'),
  wireMeta: document.getElementById('wire-meta'),
  wireSearch: document.getElementById('wire-search'),
  wireLane: document.getElementById('wire-lane'),

  seismicList: document.getElementById('seismic-list'),
  humanitarianList: document.getElementById('humanitarian-list'),

  tickerTrack: document.getElementById('ticker-track'),
  stressReadout: document.getElementById('stress-readout'),

  clock: document.getElementById('utc-clock'),
  lastUpdated: document.getElementById('last-updated'),
  statusDot: document.getElementById('status-dot'),
  refreshBtn: document.getElementById('refresh-btn'),

  banner: document.getElementById('degraded-banner'),
  bannerDetail: document.getElementById('degraded-detail'),

  drawer: document.getElementById('drawer'),
  drawerTitle: document.getElementById('drawer-title'),
  drawerSub: document.getElementById('drawer-sub'),
  drawerBody: document.getElementById('drawer-body'),
  drawerClose: document.getElementById('drawer-close'),

  methodology: document.getElementById('methodology'),
  methodologyBtn: document.getElementById('methodology-btn'),
  methodologyClose: document.getElementById('methodology-close'),
  sourceStatusList: document.getElementById('source-status-list'),
};

const state = {
  overview: null,
  selectedTheater: null,
  theaterNames: {},
  lastOverviewAt: null,
  map: null,
  loading: false,
};

// ---------------------------------------------------------------------------
// Status chrome
// ---------------------------------------------------------------------------

function setStatus(kind, message) {
  dom.statusDot.dataset.state = kind;
  if (message) dom.lastUpdated.textContent = message;
}

function tickLastUpdated() {
  if (!state.lastOverviewAt) return;
  const mins = (Date.now() - state.lastOverviewAt) / 60_000;
  dom.lastUpdated.textContent = mins < 1 ? 'just now' : `updated ${fmtAge(mins)} ago`;
}

function showDegraded(messages) {
  if (!messages.length) {
    dom.banner.hidden = true;
    return;
  }
  dom.banner.hidden = false;
  dom.bannerDetail.textContent = messages.join(' · ');
}

// ---------------------------------------------------------------------------
// Data loads
// ---------------------------------------------------------------------------

async function loadOverview() {
  if (state.loading) return;
  state.loading = true;
  dom.refreshBtn.classList.add('spinning');
  setStatus('loading', 'refreshing…');

  try {
    const data = await getJSON('/api/overview');
    state.overview = data;
    state.lastOverviewAt = Date.now();

    state.theaterNames = {};
    for (const t of data.theaters || []) state.theaterNames[t.id] = t.short || t.name;

    panels.renderComposite(
      {
        headerValue: dom.compositeValue,
        headerBand: dom.compositeBand,
        gaugeFill: dom.gaugeFill,
        gaugeValue: dom.gaugeValue,
        list: dom.componentList,
      },
      data.composite
    );

    panels.renderTheaters(dom.theaterList, data.theaters, {
      selectedId: state.selectedTheater,
      onSelect: selectTheater,
    });
    dom.theaterCount.textContent = `${(data.theaters || []).length} watched`;

    if (state.map) state.map.setTheaters(data.theaters || []);

    // The wire panel shows the priority ranking unless the user is filtering.
    if (!isFiltering()) {
      panels.renderWire(dom.wireList, data.priority || [], state.theaterNames);
      dom.wireMeta.textContent = `${data.wireMeta ? data.wireMeta.total : 0} items`;
    }

    panels.renderTicker(dom.tickerTrack, (data.markets && data.markets.quotes) || []);
    const stress = data.markets && data.markets.stress;
    dom.stressReadout.textContent =
      stress && stress.value !== null ? `stress ${stress.value}/100` : 'stress —';

    panels.renderSourceStatus(
      dom.sourceStatusList,
      (data.wireMeta && data.wireMeta.sources) || []
    );

    const problems = [];
    if (data.errors && data.errors.length) problems.push(...data.errors);
    const badSources = ((data.wireMeta && data.wireMeta.sources) || []).filter((s) => !s.ok);
    if (badSources.length) {
      problems.push(`${badSources.length} feed${badSources.length === 1 ? '' : 's'} unreachable`);
    }
    showDegraded(problems);

    setStatus(problems.length ? 'degraded' : 'ok', 'just now');
  } catch (err) {
    console.error('overview failed', err);
    setStatus('error', 'connection failed');
    showDegraded([`Dashboard data unavailable: ${err.message}`]);
    if (!state.overview) {
      replace(
        dom.theaterList,
        h('div', { class: 'placeholder', text: 'Could not reach the server. Retrying…' })
      );
    }
  } finally {
    state.loading = false;
    dom.refreshBtn.classList.remove('spinning');
  }
}

async function loadGeo() {
  try {
    const data = await getJSON('/api/geo');
    if (state.map) state.map.setGeoPoints(data.points || []);
  } catch (err) {
    console.warn('geo unavailable', err.message);
  }
}

async function loadSeismic() {
  try {
    const data = await getJSON('/api/seismic');
    panels.renderSeismic(dom.seismicList, data);
  } catch (err) {
    replace(dom.seismicList, h('div', { class: 'placeholder', text: 'Seismic feed unavailable.' }));
  }
}

async function loadHumanitarian() {
  try {
    const data = await getJSON('/api/humanitarian');
    panels.renderHumanitarian(dom.humanitarianList, data);
  } catch (err) {
    replace(
      dom.humanitarianList,
      h('div', { class: 'placeholder', text: 'ReliefWeb feed unavailable.' })
    );
  }
}

// ---------------------------------------------------------------------------
// Wire filtering
// ---------------------------------------------------------------------------

function isFiltering() {
  return Boolean(dom.wireSearch.value.trim()) || dom.wireLane.value !== 'all';
}

const applyWireFilter = debounce(async () => {
  if (!isFiltering()) {
    if (state.overview) {
      panels.renderWire(dom.wireList, state.overview.priority || [], state.theaterNames);
      dom.wireMeta.textContent = `${state.overview.wireMeta.total} items`;
    }
    return;
  }

  const params = new URLSearchParams();
  const q = dom.wireSearch.value.trim();
  if (q) params.set('q', q);
  if (dom.wireLane.value !== 'all') params.set('lane', dom.wireLane.value);
  params.set('limit', '80');

  try {
    const data = await getJSON(`/api/wire?${params}`);
    panels.renderWire(dom.wireList, data.items || [], state.theaterNames);
    dom.wireMeta.textContent = `${data.count} match${data.count === 1 ? '' : 'es'}`;
  } catch (err) {
    replace(dom.wireList, h('div', { class: 'placeholder', text: 'Search failed.' }));
  }
}, 260);

// ---------------------------------------------------------------------------
// Theater drawer
// ---------------------------------------------------------------------------

async function selectTheater(id) {
  if (!id) return closeDrawer();

  state.selectedTheater = id;
  if (state.overview) {
    panels.renderTheaters(dom.theaterList, state.overview.theaters, {
      selectedId: id,
      onSelect: selectTheater,
    });
  }
  if (state.map) state.map.focusTheater(id);

  dom.drawer.hidden = false;
  dom.drawerTitle.textContent = 'Loading…';
  dom.drawerSub.textContent = '';
  replace(dom.drawerBody, h('div', { class: 'placeholder', text: 'Fetching theater detail…' }));

  try {
    const data = await getJSON(`/api/theater/${encodeURIComponent(id)}`);
    panels.renderDrawer(
      { title: dom.drawerTitle, sub: dom.drawerSub, body: dom.drawerBody },
      data
    );
  } catch (err) {
    dom.drawerTitle.textContent = 'Unavailable';
    replace(
      dom.drawerBody,
      h('div', { class: 'placeholder', text: `Could not load theater detail: ${err.message}` })
    );
  }
}

function closeDrawer() {
  dom.drawer.hidden = true;
  state.selectedTheater = null;
  if (state.overview) {
    panels.renderTheaters(dom.theaterList, state.overview.theaters, {
      selectedId: null,
      onSelect: selectTheater,
    });
  }
}

// ---------------------------------------------------------------------------
// Map tooltip
// ---------------------------------------------------------------------------

function handleHover(payload) {
  if (!payload) {
    dom.mapTooltip.hidden = true;
    return;
  }

  if (payload.type === 'theater') {
    const t = payload.theater;
    replace(
      dom.mapTooltip,
      h('b', { text: t.name }),
      h('div', { text: `Level ${t.level} · intensity ${t.reportingIntensity}` }),
      h('small', { text: `${t.itemCount} classified items` })
    );
  } else if (payload.type === 'country' && payload.name) {
    replace(
      dom.mapTooltip,
      h('b', { text: payload.name }),
      payload.theaterId
        ? h('small', { text: state.theaterNames[payload.theaterId] || payload.theaterId })
        : null
    );
  } else {
    dom.mapTooltip.hidden = true;
    return;
  }

  dom.mapTooltip.hidden = false;
  const pad = 14;
  const rect = dom.mapTooltip.getBoundingClientRect();
  let x = payload.x + pad;
  let y = payload.y + pad;
  if (x + rect.width > window.innerWidth - 8) x = payload.x - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = payload.y - rect.height - pad;
  dom.mapTooltip.style.left = `${x}px`;
  dom.mapTooltip.style.top = `${y}px`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function initMap() {
  const map = new WarMap(dom.mapContainer);
  state.map = map;

  map.on('select', ({ theaterId }) => {
    if (theaterId) selectTheater(theaterId);
  });
  map.on('hover', handleHover);

  try {
    const topology = await getJSON('data/countries-50m.json', { timeout: 40_000 });
    map.setTopology(topology);
    map.resize();
    if (state.overview) map.setTheaters(state.overview.theaters || []);
  } catch (err) {
    console.error('map geometry failed to load', err);
    replace(
      dom.mapContainer,
      h('div', { class: 'placeholder', text: 'Map geometry could not be loaded.' })
    );
  }
}

function bindControls() {
  dom.refreshBtn.addEventListener('click', () => {
    loadOverview();
    loadGeo();
  });

  dom.zoomIn.addEventListener('click', () => state.map && state.map.zoomBy(1.6));
  dom.zoomOut.addEventListener('click', () => state.map && state.map.zoomBy(1 / 1.6));
  dom.zoomReset.addEventListener('click', () => state.map && state.map.reset());

  dom.toggleDensity.addEventListener('change', (e) => {
    if (!state.map) return;
    state.map.gDensity.classList.toggle('hidden', !e.target.checked);
  });

  dom.wireSearch.addEventListener('input', applyWireFilter);
  dom.wireLane.addEventListener('change', applyWireFilter);

  dom.drawerClose.addEventListener('click', closeDrawer);

  dom.methodologyBtn.addEventListener('click', () => {
    const open = dom.methodology.hidden;
    dom.methodology.hidden = !open;
    dom.methodologyBtn.setAttribute('aria-expanded', String(open));
  });
  dom.methodologyClose.addEventListener('click', () => {
    dom.methodology.hidden = true;
    dom.methodologyBtn.setAttribute('aria-expanded', 'false');
  });
  dom.methodology.addEventListener('click', (e) => {
    if (e.target === dom.methodology) dom.methodology.hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!dom.methodology.hidden) dom.methodology.hidden = true;
    else if (!dom.drawer.hidden) closeDrawer();
  });

  // Pause polling while hidden; catch up immediately on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadOverview();
  });
}

function startTimers() {
  setInterval(() => {
    dom.clock.textContent = utcClock();
  }, 1000);
  dom.clock.textContent = utcClock();

  setInterval(tickLastUpdated, 20_000);

  setInterval(() => {
    if (document.visibilityState === 'visible') loadOverview();
  }, REFRESH.overview);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadGeo();
  }, REFRESH.geo);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadSeismic();
  }, REFRESH.seismic);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadHumanitarian();
  }, REFRESH.humanitarian);
}

async function boot() {
  bindControls();
  startTimers();

  // Overview and map geometry load in parallel; the secondary panels follow so
  // they never delay first paint.
  await Promise.all([loadOverview(), initMap()]);

  loadGeo();
  loadSeismic();
  loadHumanitarian();
}

boot();
