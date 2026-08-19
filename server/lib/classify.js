'use strict';

const { THEATERS } = require('../config');

/**
 * Tag free text with the theaters it appears to concern.
 *
 * Single-word keywords are matched on word boundaries so "india" does not fire
 * on "Indiana" and "iran" does not fire on "Iranian-adjacent" false friends
 * like "tyrannical". Multi-word phrases are matched as substrings, since they
 * are specific enough not to need the guard.
 */

const MATCHERS = THEATERS.map((t) => ({
  id: t.id,
  tests: t.keywords.map((kw) => {
    const k = kw.toLowerCase();
    if (k.includes(' ') || k.includes('-')) {
      return { phrase: k, re: null };
    }
    return { phrase: null, re: new RegExp(`\\b${escapeRe(k)}\\b`, 'i') };
  }),
}));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text
 * @returns {{ids: string[], scores: Object<string, number>}}
 *   ids sorted by descending match count.
 */
function classify(text) {
  if (!text) return { ids: [], scores: {} };
  const hay = String(text).toLowerCase();
  const scores = {};

  for (const m of MATCHERS) {
    let hits = 0;
    for (const t of m.tests) {
      if (t.phrase !== null) {
        if (hay.includes(t.phrase)) hits++;
      } else if (t.re.test(hay)) {
        hits++;
      }
    }
    if (hits > 0) scores[m.id] = hits;
  }

  const ids = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  return { ids, scores };
}

/**
 * Escalation-signal lexicon. These are surfaced as neutral descriptive flags on
 * an item ("this report mentions a strike"), not as an assessment of what is
 * happening — the UI labels them as detected language, and always alongside the
 * source headline so a reader can judge it themselves.
 */
const SIGNAL_TERMS = [
  { tag: 'strike', weight: 3, terms: ['airstrike', 'air strike', 'missile strike', 'strikes hit', 'bombardment', 'shelling'] },
  { tag: 'casualty', weight: 3, terms: ['killed', 'casualties', 'death toll', 'wounded'] },
  { tag: 'escalation', weight: 4, terms: ['escalation', 'escalate', 'retaliation', 'retaliate', 'ultimatum'] },
  { tag: 'mobilisation', weight: 4, terms: ['mobilisation', 'mobilization', 'conscription', 'reservists', 'troop buildup', 'deployment'] },
  { tag: 'nuclear', weight: 5, terms: ['nuclear', 'warhead', 'enrichment', 'icbm'] },
  { tag: 'diplomacy', weight: -2, terms: ['ceasefire', 'truce', 'peace talks', 'negotiation', 'de-escalation', 'agreement reached'] },
  { tag: 'sanctions', weight: 2, terms: ['sanctions', 'embargo', 'export controls'] },
  { tag: 'alliance', weight: 2, terms: ['article 5', 'nato summit', 'mutual defense', 'defence pact'] },
  { tag: 'incursion', weight: 3, terms: ['incursion', 'airspace violation', 'border crossing', 'territorial waters'] },
  { tag: 'displacement', weight: 2, terms: ['displaced', 'refugees', 'evacuation', 'famine'] },
];

const SIGNAL_MATCHERS = SIGNAL_TERMS.map((s) => ({
  tag: s.tag,
  weight: s.weight,
  re: new RegExp(s.terms.map(escapeRe).join('|'), 'i'),
}));

/**
 * @returns {{tags: string[], score: number}} score is a signed intensity hint;
 *   negative values indicate de-escalatory language.
 */
function signals(text) {
  if (!text) return { tags: [], score: 0 };
  const tags = [];
  let score = 0;
  for (const m of SIGNAL_MATCHERS) {
    if (m.re.test(text)) {
      tags.push(m.tag);
      score += m.weight;
    }
  }
  return { tags, score };
}

module.exports = { classify, signals };
