/**
 * SVG world map with pan/zoom, theater highlighting and a reporting-density
 * overlay.
 *
 * Zoom is implemented by moving the viewBox rather than applying a transform:
 * the geometry stays in world coordinates, paths are never rebuilt, and text
 * and strokes stay crisp at every zoom level.
 */

import { decodeTopology, toPath, project, graticulePath, WORLD } from './topo.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

const LEVEL_CLASS = {
  1: 'lvl-1',
  2: 'lvl-2',
  3: 'lvl-3',
  4: 'lvl-4',
  5: 'lvl-5',
};

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

export class WarMap {
  constructor(container) {
    this.container = container;
    this.listeners = { select: [], hover: [] };
    this.theaters = [];
    this.geoPoints = [];
    this.countryNodes = new Map(); // iso -> <path>
    this.view = { x: 0, y: 0, w: WORLD.width, h: WORLD.height };
    this.anim = null;

    this._buildSkeleton();
    this._bindInteraction();
  }

  on(event, cb) {
    if (this.listeners[event]) this.listeners[event].push(cb);
    return this;
  }

  _emit(event, payload) {
    for (const cb of this.listeners[event] || []) cb(payload);
  }

  _buildSkeleton() {
    const svg = el('svg', {
      class: 'warmap',
      viewBox: `0 0 ${WORLD.width} ${WORLD.height}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'World map of monitored conflict theaters',
    });

    const defs = el('defs');
    // Soft radial falloff for the reporting-density blobs.
    const grad = el('radialGradient', { id: 'densityFade' });
    grad.appendChild(el('stop', { offset: '0%', 'stop-color': 'var(--density-core)', 'stop-opacity': '0.85' }));
    grad.appendChild(el('stop', { offset: '100%', 'stop-color': 'var(--density-edge)', 'stop-opacity': '0' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    this.gOcean = el('rect', {
      class: 'wm-ocean',
      x: 0,
      y: 0,
      width: WORLD.width,
      height: WORLD.height,
    });
    svg.appendChild(this.gOcean);

    this.gGraticule = el('path', { class: 'wm-graticule', d: graticulePath(20) });
    svg.appendChild(this.gGraticule);

    this.gCountries = el('g', { class: 'wm-countries' });
    this.gDensity = el('g', { class: 'wm-density' });
    this.gMarkers = el('g', { class: 'wm-markers' });

    svg.appendChild(this.gCountries);
    svg.appendChild(this.gDensity);
    svg.appendChild(this.gMarkers);

    this.svg = svg;
    this.container.appendChild(svg);
  }

  /** @param {object} topology raw world-atlas TopoJSON */
  setTopology(topology) {
    const features = decodeTopology(topology, 'countries');
    const frag = document.createDocumentFragment();

    for (const f of features) {
      const d = toPath(f);
      if (!d) continue;
      const path = el('path', {
        d,
        class: 'wm-country',
        'data-iso': f.id,
        'data-name': f.name,
      });
      frag.appendChild(path);
      if (f.id) this.countryNodes.set(f.id, path);
      // Disputed territories in this dataset carry no ISO id, so also index by
      // name — that is the only handle config has for them.
      if (f.name) this.countryNodes.set(f.name.toLowerCase(), path);
    }
    this.gCountries.appendChild(frag);
    return this;
  }

  /**
   * @param {Array} theaters status objects: {id,name,short,lat,lon,countries,level,reportingIntensity}
   */
  setTheaters(theaters) {
    this.theaters = theaters || [];

    // Reset country classes, then paint by the highest level claiming each one.
    for (const node of this.countryNodes.values()) {
      node.setAttribute('class', 'wm-country');
      node.removeAttribute('data-theater');
    }

    const claim = new Map(); // country key -> theater
    for (const t of this.theaters) {
      for (const ref of t.countries || []) {
        const key = this.countryNodes.has(ref) ? ref : String(ref).toLowerCase();
        const prev = claim.get(key);
        if (!prev || (t.level || 0) > (prev.level || 0)) claim.set(key, t);
      }
    }
    for (const [key, t] of claim) {
      const node = this.countryNodes.get(key);
      if (!node) continue;
      node.setAttribute('class', `wm-country active ${LEVEL_CLASS[t.level] || 'lvl-1'}`);
      node.setAttribute('data-theater', t.id);
    }

    this._renderMarkers();
    return this;
  }

  setGeoPoints(points) {
    this.geoPoints = Array.isArray(points) ? points : [];
    this._renderDensity();
    return this;
  }

  _renderMarkers() {
    this.gMarkers.textContent = '';
    const frag = document.createDocumentFragment();

    for (const t of this.theaters) {
      const [x, y] = project(t.lon, t.lat);
      const g = el('g', {
        class: `wm-marker ${LEVEL_CLASS[t.level] || 'lvl-1'}`,
        'data-theater': t.id,
        'data-level': t.level || 1,
        tabindex: '0',
        role: 'button',
        'aria-label': `${t.name}, level ${t.level} of 5`,
      });

      // Pulse ring only for the theaters currently drawing the most reporting —
      // if everything pulses, nothing reads as urgent.
      if ((t.level || 0) >= 4) {
        g.appendChild(el('circle', { class: 'wm-pulse', cx: x, cy: y, r: 6 }));
      }
      g.appendChild(el('circle', { class: 'wm-dot', cx: x, cy: y, r: 5 }));
      g.appendChild(el('circle', { class: 'wm-hit', cx: x, cy: y, r: 14 }));

      const label = el('text', { class: 'wm-label', x: x + 12, y: y + 4 });
      label.textContent = t.short || t.name;
      g.appendChild(label);

      frag.appendChild(g);
    }

    this.gMarkers.appendChild(frag);
    this._rescaleOverlays();
  }

  _renderDensity() {
    this.gDensity.textContent = '';
    if (!this.geoPoints.length) return;

    const max = this.geoPoints.reduce((m, p) => Math.max(m, p.count || 1), 1);
    const frag = document.createDocumentFragment();

    for (const p of this.geoPoints) {
      const [x, y] = project(p.lon, p.lat);
      // sqrt keeps a handful of very loud locations from swamping the map.
      const rel = Math.sqrt((p.count || 1) / max);
      frag.appendChild(
        el('circle', {
          class: 'wm-density-pt',
          cx: x,
          cy: y,
          r: 4 + rel * 26,
          'data-count': p.count || 1,
          'data-name': p.name || '',
          'data-theater': p.theaterId || '',
        })
      );
    }
    this.gDensity.appendChild(frag);
    this._rescaleOverlays();
  }

  // -- view ----------------------------------------------------------------

  _applyView() {
    const v = this.view;
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    this._rescaleOverlays();
  }

  /** Screen-space size for markers: counteract the current zoom. */
  _rescaleOverlays() {
    const k = this.view.w / WORLD.width; // 1 at full extent, smaller when zoomed
    const s = Math.max(0.16, Math.min(1, k));

    this.gMarkers.style.setProperty('--marker-scale', String(s));
    this.svg.style.setProperty('--zoom-k', String(s));

    // Labels collide badly at full extent, where two dozen markers compete for
    // the same few hundred pixels. Show only the loudest theaters when zoomed
    // out, and reveal the rest as the view tightens.
    const labelFloor = s > 0.7 ? 4 : s > 0.4 ? 3 : 0;

    for (const g of this.gMarkers.children) {
      const dot = g.querySelector('.wm-dot');
      const hit = g.querySelector('.wm-hit');
      const pulse = g.querySelector('.wm-pulse');
      const text = g.querySelector('.wm-label');
      if (dot) dot.setAttribute('r', String(5 * s));
      if (hit) hit.setAttribute('r', String(14 * s));
      if (pulse) pulse.setAttribute('r', String(6 * s));
      if (text) {
        const level = Number(g.getAttribute('data-level')) || 1;
        text.style.display = level >= labelFloor ? '' : 'none';
        text.setAttribute('font-size', String(22 * s));
        const cx = Number(dot.getAttribute('cx'));
        const cy = Number(dot.getAttribute('cy'));
        text.setAttribute('x', String(cx + 12 * s));
        text.setAttribute('y', String(cy + 6 * s));
      }
    }
  }

  _scale() {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return 1;
    return Math.min(rect.width / this.view.w, rect.height / this.view.h);
  }

  _clientToWorld(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    const scale = this._scale();
    const renderedW = this.view.w * scale;
    const renderedH = this.view.h * scale;
    const offX = (rect.width - renderedW) / 2;
    const offY = (rect.height - renderedH) / 2;
    return [
      this.view.x + (clientX - rect.left - offX) / scale,
      this.view.y + (clientY - rect.top - offY) / scale,
    ];
  }

  _clampView() {
    const v = this.view;
    const maxW = WORLD.width;
    const minW = 120; // ~12 degrees across
    const aspect = v.h / v.w || 0.5;

    v.w = Math.max(minW, Math.min(maxW, v.w));
    v.h = v.w * aspect;

    // Keep at least a third of the viewport over the world.
    const slackX = v.w * 0.66;
    const slackY = v.h * 0.66;
    v.x = Math.max(-slackX, Math.min(WORLD.width - v.w + slackX, v.x));
    v.y = Math.max(-slackY, Math.min(WORLD.height - v.h + slackY, v.y));
  }

  zoomAt(clientX, clientY, factor) {
    const [wx, wy] = this._clientToWorld(clientX, clientY);
    const v = this.view;
    const nw = v.w / factor;
    const ratio = nw / v.w;

    v.x = wx - (wx - v.x) * ratio;
    v.y = wy - (wy - v.y) * ratio;
    v.w = nw;
    v.h = v.h * ratio;

    this._clampView();
    this._applyView();
  }

  zoomBy(factor) {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  reset() {
    this._animateTo({ x: 0, y: 0, w: WORLD.width, h: WORLD.height });
  }

  /** Zoom to a theater's neighbourhood. */
  focusTheater(id, spanDegrees = 46) {
    const t = this.theaters.find((x) => x.id === id);
    if (!t) return;
    const [cx, cy] = project(t.lon, t.lat);
    const w = spanDegrees * WORLD.scale;
    const aspect = this.view.h / this.view.w || 0.5;
    this._animateTo({ x: cx - w / 2, y: cy - (w * aspect) / 2, w, h: w * aspect });
  }

  _animateTo(target, duration = 480) {
    if (this.anim) cancelAnimationFrame(this.anim);
    const start = { ...this.view };
    const t0 = performance.now();
    const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const e = ease(p);
      this.view = {
        x: start.x + (target.x - start.x) * e,
        y: start.y + (target.y - start.y) * e,
        w: start.w + (target.w - start.w) * e,
        h: start.h + (target.h - start.h) * e,
      };
      this._clampView();
      this._applyView();
      if (p < 1) this.anim = requestAnimationFrame(step);
      else this.anim = null;
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Match the viewBox aspect to the element so the world is not stretched. */
  resize() {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const aspect = rect.height / rect.width;
    this.view.h = this.view.w * aspect;
    this._clampView();
    this._applyView();
  }

  // -- interaction ---------------------------------------------------------

  _bindInteraction() {
    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;

    this.svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.pow(1.0015, -e.deltaY);
        this.zoomAt(e.clientX, e.clientY, factor);
      },
      { passive: false }
    );

    this.svg.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
      this.svg.setPointerCapture(e.pointerId);
      this.svg.classList.add('dragging');
    });

    this.svg.addEventListener('pointermove', (e) => {
      if (!dragging) {
        this._handleHover(e);
        return;
      }
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      lastX = e.clientX;
      lastY = e.clientY;

      const scale = this._scale();
      this.view.x -= dx / scale;
      this.view.y -= dy / scale;
      this._clampView();
      this._applyView();
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      this.svg.classList.remove('dragging');
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      if (!moved) this._handleClick(e);
    };

    this.svg.addEventListener('pointerup', endDrag);
    this.svg.addEventListener('pointercancel', endDrag);

    this.svg.addEventListener('keydown', (e) => {
      const marker = e.target.closest && e.target.closest('.wm-marker');
      if (marker && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this._emit('select', { theaterId: marker.getAttribute('data-theater') });
      }
    });

    window.addEventListener('resize', () => this.resize());
  }

  _handleClick(e) {
    const marker = e.target.closest && e.target.closest('.wm-marker');
    if (marker) {
      this._emit('select', { theaterId: marker.getAttribute('data-theater') });
      return;
    }
    const country = e.target.closest && e.target.closest('.wm-country[data-theater]');
    if (country) {
      this._emit('select', { theaterId: country.getAttribute('data-theater') });
      return;
    }
    this._emit('select', { theaterId: null });
  }

  _handleHover(e) {
    const marker = e.target.closest && e.target.closest('.wm-marker');
    if (marker) {
      const t = this.theaters.find((x) => x.id === marker.getAttribute('data-theater'));
      if (t) return this._emit('hover', { type: 'theater', theater: t, x: e.clientX, y: e.clientY });
    }
    const country = e.target.closest && e.target.closest('.wm-country');
    if (country) {
      return this._emit('hover', {
        type: 'country',
        name: country.getAttribute('data-name'),
        theaterId: country.getAttribute('data-theater'),
        x: e.clientX,
        y: e.clientY,
      });
    }
    this._emit('hover', null);
  }
}
