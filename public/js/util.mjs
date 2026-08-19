/**
 * Shared helpers.
 *
 * Rendering rule for this app: feed content is third-party text and is never
 * interpolated into markup. `h()` only ever assigns strings via textContent,
 * and nothing in the codebase assigns innerHTML from response data.
 */

/** Create an element. Children may be nodes, strings, or nullish (skipped). */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child
    );
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, ...children) {
  clear(node);
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** "3m", "2h", "4d" — compact relative age from minutes. */
export function fmtAge(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}

/** Adaptive precision: big numbers get fewer decimals. */
export function fmtNum(n, forceDigits = null) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits =
    forceDigits !== null ? forceDigits : abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

export function direction(n, deadband = 0.001) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'flat';
  if (n > deadband) return 'up';
  if (n < -deadband) return 'down';
  return 'flat';
}

/** SVG path for a sparkline normalised to the given box. */
export function sparkPath(series, w = 60, hgt = 16, pad = 1.5) {
  if (!Array.isArray(series) || series.length < 2) return '';
  let min = Infinity;
  let max = -Infinity;
  for (const v of series) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '';

  const span = max - min || 1;
  const innerH = hgt - pad * 2;
  const step = w / (series.length - 1);

  let d = '';
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    const x = i * step;
    const y = pad + innerH - ((v - min) / span) * innerH;
    d += (d ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }
  return d;
}

export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** fetch JSON with a timeout; throws on non-2xx. */
export async function getJSON(url, { timeout = 25_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function utcClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function timeAgoFrom(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 60_000;
}
