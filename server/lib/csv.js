'use strict';

/**
 * Minimal RFC 4180-ish CSV parser: quoted fields, doubled quotes, CRLF or LF.
 * Returns an array of row arrays.
 */
function parseCSV(text) {
  const rows = [];
  if (!text) return rows;

  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse CSV with a header row into objects keyed by lowercased header name. */
function parseCSVObjects(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0].trim() === '') continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (rows[r][c] ?? '').trim();
    }
    out.push(obj);
  }
  return out;
}

function num(v) {
  if (v === undefined || v === null || v === '' || v === 'N/A') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { parseCSV, parseCSVObjects, num };
