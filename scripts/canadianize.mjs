#!/usr/bin/env node
/**
 * Normalise question text to Canadian spelling: -ise/-isation -> -ize/-ization,
 * analyse -> analyze, programme -> program. Keeps -our, -re and "defence", which
 * are standard in Canadian English. Safe to re-run (idempotent).
 *
 * The danger in a rule like this is converting words that merely END in -ise but
 * are not the "-ize" verb family: rise, raise, crises, merchandise, otherwise,
 * promise, advise, exercise... Those are protected by the explicit whole-word
 * list below. Matching is on the complete word, never on an ending, because an
 * ending test would also protect real -ize verbs such as "summarise" or
 * "characterise" (both end in "-rise").
 *
 * The OECD's official name is spelled "Organisation" and is left alone.
 *
 * Usage: node scripts/canadianize.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';

// Roots whose "-is-" is part of the word, not the British "-ize" spelling.
const KEEP_ROOTS = [
  'ris', 'rais', 'aris', 'prais', 'nois', 'wis', 'mis',
  'merchandis', 'surpris', 'exercis', 'enterpris', 'expertis', 'compromis',
  'promis', 'premis', 'supervis', 'revis', 'devis', 'compris', 'franchis',
  'disguis', 'demis', 'improvis', 'excis', 'paradis', 'cruis', 'pois',
  'appris', 'televis', 'advis', 'advertis', 'despis', 'bruis', 'concis',
  'precis', 'treatis', 'sunris', 'upris', 'likewis', 'otherwis', 'pris',
];
const KEEP_SUFFIXES = ['e', 'es', 'ed', 'ing', 'er', 'ers'];
const KEEP = new Set([
  ...KEEP_ROOTS.flatMap(r => KEEP_SUFFIXES.map(s => r + s)),
  'crises', 'analyses', 'enterprising',
]);

const WORD = /\b([A-Za-z]+?)(is|ys)(e|es|ed|ing|ation|ations|er|ers)\b/g;

function convert(s) {
  return s
    .replace(WORD, (m, stem, mid, suf) =>
      KEEP.has(m.toLowerCase()) ? m : stem + (mid === 'is' ? 'iz' : 'yz') + suf)
    .replace(/\bprogramme(s?)\b/g, 'program$1')
    .replace(/\bProgramme(s?)\b/g, 'Program$1');
}

// split() with a capture group puts the matched protected name at odd indexes,
// so those segments pass through untouched and nothing else is affected.
const PROTECTED = /(Organisation for Economic Co-operation and Development)/;
const fix = s => s.split(PROTECTED).map((part, i) => (i % 2 ? part : convert(part))).join('');

// Only free text is touched. Ids, tags, sources and typed-answer variants are left alone.
const TEXT_KEYS = ['prompt', 'explanation', 'choices', 'items', 'pairs', 'metric', 'order_by', 'unit'];
const walk = v => typeof v === 'string' ? fix(v) : Array.isArray(v) ? v.map(walk) : v;

let changed = 0;
for (const f of readdirSync('questions').filter(f => f.endsWith('.json'))) {
  const p = `questions/${f}`;
  const arr = JSON.parse(readFileSync(p, 'utf8'));
  for (const q of arr) {
    for (const k of TEXT_KEYS) {
      if (q[k] == null) continue;
      const before = JSON.stringify(q[k]);
      q[k] = walk(q[k]);
      if (JSON.stringify(q[k]) !== before) changed++;
    }
    // answer must keep tracking its choices / items, so transform it too, except
    // for typed answers, which are matched against the accept[] list as written.
    if (typeof q.answer === 'string' && q.format !== 'short') {
      const before = q.answer;
      q.answer = fix(q.answer);
      if (q.answer !== before) changed++;
    }
  }
  writeFileSync(p, JSON.stringify(arr, null, 2) + '\n');
}
console.log(`fields changed: ${changed}`);
