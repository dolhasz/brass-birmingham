'use strict';

/**
 * A small, tolerant XML parser — enough to handle real-world RSS 2.0 and Atom
 * feeds, which are frequently malformed. Builds a lightweight node tree:
 *
 *   { name, attrs, children, text }
 *
 * Namespace prefixes are preserved on `name`, but lookups match either the
 * full name ("dc:date") or the local part ("date"), case-insensitively.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', deg: '°', eacute: 'é', egrave: 'è',
  agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö',
  auml: 'ä', szlig: 'ß', ntilde: 'ñ', copy: '©',
  reg: '®', trade: '™', euro: '€', pound: '£',
  middot: '·', bull: '•', prime: '′', shy: '',
};

function decodeEntities(str) {
  if (!str || str.indexOf('&') === -1) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : m;
  });
}

/** Find the '>' that closes a tag, ignoring '>' inside quoted attributes. */
function findTagEnd(src, start) {
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

const ATTR_RE = /([^\s=/>]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) {
    const key = m[1].toLowerCase();
    const val = m[3] ?? m[4] ?? m[5] ?? '';
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

function parseXML(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  if (typeof src !== 'string' || !src) return root;

  // Strip BOM.
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;

  const addText = (s, decode) => {
    if (!s) return;
    const node = top();
    node.text += decode ? decodeEntities(s) : s;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      addText(src.slice(i), true);
      break;
    }
    if (lt > i) addText(src.slice(i, lt), true);

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end === -1) {
        addText(src.slice(lt + 9), false);
        break;
      }
      addText(src.slice(lt + 9, end), false); // CDATA is literal
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = findTagEnd(src, lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt === -1) {
      addText(src.slice(lt), true);
      break;
    }
    const raw = src.slice(lt + 1, gt);

    if (raw[0] === '/') {
      const name = raw.slice(1).trim().toLowerCase();
      // Pop to the matching open tag; tolerate unclosed children.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) {
          stack.length = d;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const sp = body.search(/[\s]/);
    const name = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
    const attrs = sp === -1 ? {} : parseAttrs(body.slice(sp));

    const node = { name, attrs, children: [], text: '' };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root;
}

function localName(name) {
  const c = name.indexOf(':');
  return c === -1 ? name : name.slice(c + 1);
}

function matches(node, wanted) {
  const w = wanted.toLowerCase();
  return node.name === w || localName(node.name) === localName(w);
}

/** First direct-or-nested descendant matching `name`. */
function find(node, name) {
  if (!node) return null;
  for (const child of node.children) {
    if (matches(child, name)) return child;
  }
  for (const child of node.children) {
    const hit = find(child, name);
    if (hit) return hit;
  }
  return null;
}

/** All descendants matching `name` (does not descend into matches). */
function findAll(node, name, out = []) {
  if (!node) return out;
  for (const child of node.children) {
    if (matches(child, name)) out.push(child);
    else findAll(child, name, out);
  }
  return out;
}

/** Direct children matching `name`. */
function children(node, name) {
  if (!node) return [];
  return node.children.filter((c) => matches(c, name));
}

/** Trimmed text of the first descendant matching `name`. */
function textOf(node, name) {
  const hit = name ? find(node, name) : node;
  return hit ? hit.text.trim() : '';
}

/** Strip HTML tags and collapse whitespace — for feed summaries. */
function stripHtml(html, maxLen = 0) {
  if (!html) return '';
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\s+/g, ' ').trim();
  if (maxLen > 0 && s.length > maxLen) {
    s = s.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
  }
  return s;
}

module.exports = {
  parseXML,
  find,
  findAll,
  children,
  textOf,
  stripHtml,
  decodeEntities,
};
