/**
 * Minimal TopoJSON decoder.
 *
 * TopoJSON stores shared boundaries once as delta-encoded, quantised "arcs";
 * each geometry then references arcs by index, with a negative index meaning
 * "traverse this arc backwards" (encoded as the one's complement, ~i).
 * Decoding is: undo the deltas, undo the quantisation, then stitch arcs into
 * rings.
 *
 * This exists so the map has no runtime dependency on d3 or the topojson
 * client library — the whole app ships as plain modules with no build step.
 */

/** Undo delta encoding and quantisation for every arc, once. */
function buildArcs(topology) {
  const t = topology.transform;
  const sx = t ? t.scale[0] : 1;
  const sy = t ? t.scale[1] : 1;
  const tx = t ? t.translate[0] : 0;
  const ty = t ? t.translate[1] : 0;

  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    const pts = new Array(arc.length);
    for (let i = 0; i < arc.length; i++) {
      x += arc[i][0];
      y += arc[i][1];
      pts[i] = t ? [x * sx + tx, y * sy + ty] : [arc[i][0], arc[i][1]];
    }
    return pts;
  });
}

/** Stitch a list of arc indices into a single closed ring of [lon, lat]. */
function ringFrom(indices, arcs) {
  const ring = [];
  for (const idx of indices) {
    const reversed = idx < 0;
    const arc = arcs[reversed ? ~idx : idx];
    if (!arc || !arc.length) continue;

    const seq = reversed ? arc.slice().reverse() : arc;
    // Consecutive arcs share their join point — drop the duplicate.
    if (ring.length) ring.push(...seq.slice(1));
    else ring.push(...seq);
  }
  return ring;
}

function geometryToPolygons(geom, arcs) {
  if (!geom) return [];
  if (geom.type === 'Polygon') {
    return [geom.arcs.map((r) => ringFrom(r, arcs))];
  }
  if (geom.type === 'MultiPolygon') {
    return geom.arcs.map((poly) => poly.map((r) => ringFrom(r, arcs)));
  }
  return [];
}

/**
 * @returns {Array<{id: string, name: string, polygons: number[][][][]}>}
 *   polygons[p][ring][point] = [lon, lat]
 */
export function decodeTopology(topology, objectName = 'countries') {
  const obj = topology.objects && topology.objects[objectName];
  if (!obj || !Array.isArray(obj.geometries)) return [];

  const arcs = buildArcs(topology);
  const out = [];

  for (const geom of obj.geometries) {
    const polygons = geometryToPolygons(geom, arcs);
    if (!polygons.length) continue;
    out.push({
      id: geom.id !== undefined && geom.id !== null ? String(geom.id) : '',
      name: (geom.properties && geom.properties.name) || '',
      polygons,
    });
  }
  return out;
}

/**
 * Equirectangular (plate carrée) projection into a fixed world-space canvas.
 *
 * Projecting once into world space and then handling zoom with an SVG
 * transform keeps interaction cheap: pan and zoom never reproject or rebuild
 * path data, they just change one matrix.
 */
export const WORLD = { scale: 10, width: 3600, height: 1800 };

export function project(lon, lat) {
  return [(lon + 180) * WORLD.scale, (90 - lat) * WORLD.scale];
}

/**
 * Remove the ±180° wrap from a ring's longitudes.
 *
 * Source data stores every longitude inside [-180, 180], so a landmass that
 * straddles the antimeridian (Russia's Chukotka, Fiji, Antarctica) contains a
 * jump from ~+179 to ~-179. Drawn literally, that jump is a horizontal line
 * straight across the map. Accumulating a ±360 offset at each jump makes the
 * ring continuous again so it can be placed deliberately.
 */
function unwrapRing(ring) {
  const out = new Array(ring.length);
  let offset = 0;
  out[0] = ring[0];
  for (let i = 1; i < ring.length; i++) {
    const delta = ring[i][0] - ring[i - 1][0];
    if (delta > 180) offset -= 360;
    else if (delta < -180) offset += 360;
    out[i] = [ring[i][0] + offset, ring[i][1]];
  }
  return out;
}

/**
 * Emit path data for one ring, drawing it once per 360° shift that lands any
 * part of it on the canvas. Longitudes are clamped to the map edge, so a
 * landmass crossing the antimeridian renders as two pieces meeting the left
 * and right borders — which is what it should look like — instead of one
 * band spanning the world.
 */
function ringPathData(ring, r) {
  const unwrapped = unwrapRing(ring);

  let min = Infinity;
  let max = -Infinity;
  for (const p of unwrapped) {
    if (p[0] < min) min = p[0];
    if (p[0] > max) max = p[0];
  }

  const offsets = [0];
  if (max > 180) offsets.push(-360);
  if (min < -180) offsets.push(360);

  const out = [];
  for (const offset of offsets) {
    if (max + offset < -180 || min + offset > 180) continue;

    let d = '';
    let prevX = null;
    let prevY = null;
    for (const pt of unwrapped) {
      const lon = Math.max(-180, Math.min(180, pt[0] + offset));
      const [x, y] = project(lon, pt[1]);
      const rx = r(x);
      const ry = r(y);
      if (rx === prevX && ry === prevY) continue; // same rounded pixel
      d += (d ? 'L' : 'M') + rx + ' ' + ry;
      prevX = rx;
      prevY = ry;
    }
    if (d) out.push(d + 'Z');
  }
  return out;
}

/** Build an SVG path `d` for one decoded feature. */
export function toPath(feature, precision = 1) {
  const parts = [];
  const p = Math.pow(10, precision);
  const r = (n) => Math.round(n * p) / p;

  for (const polygon of feature.polygons) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      parts.push(...ringPathData(ring, r));
    }
  }
  return parts.join('');
}

/** Graticule path at a given degree interval — the war-room grid. */
export function graticulePath(step = 20) {
  const parts = [];
  for (let lon = -180; lon <= 180; lon += step) {
    const [x, y0] = project(lon, 90);
    const [, y1] = project(lon, -90);
    parts.push(`M${x} ${y0}L${x} ${y1}`);
  }
  for (let lat = -80; lat <= 80; lat += step) {
    const [x0, y] = project(-180, lat);
    const [x1] = project(180, lat);
    parts.push(`M${x0} ${y}L${x1} ${y}`);
  }
  return parts.join('');
}
