#!/usr/bin/env node
/**
 * Normalise question text to Canadian spelling: -ise/-isation -> -ize/-ization,
 * analyse -> analyze, programme -> program. Keeps -our, -re and "defence", which
 * are standard in Canadian English. Safe to re-run (idempotent).
 *
 * The danger in a rule like this is converting words that merely END in -ise but
 * are not the "-ize" verb family: rise, crises, imprecise, pairwise, appraise,
 * chastise, names like Louise... A hand-kept list of exceptions can never be
 * complete, so a word is converted only when its "-ize" form is a real English
 * word (checked against the `word-list` dictionary, using the base "-ize"/"-yze"
 * form so inflections like "organisations" still match).
 *
 * The dictionary can't help where both spellings are real but different words
 * (prise/prize, braise/braize, surprise/surprize). Those are protected by the
 * explicit whole-word list below. Matching is on the complete word, never on an
 * ending, because an ending test would also protect real -ize verbs such as
 * "summarise" or "characterise" (both end in "-rise").
 *
 * Official names are left alone: the OECD's "Organisation", and any capitalised
 * "Programme" (UN Development Programme, World Food Programme...). Lowercase
 * "programme" becomes "program".
 *
 * Usage: node scripts/canadianize.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import wordListPath from 'word-list';

const DICT = new Set(readFileSync(wordListPath, 'utf8').split('\n'));

// Roots whose "-is-" is part of the word, not the British "-ize" spelling. Only
// needed where the "-ize" form is ALSO a dictionary word; the rest are caught by
// the dictionary check and are listed here for clarity.
const KEEP_ROOTS = [
  'pris', 'repris', 'empris', 'mispris', 'brais', 'seis', 'disseis',
  'ris', 'rais', 'aris', 'prais', 'nois', 'wis', 'mis',
  'merchandis', 'surpris', 'exercis', 'enterpris', 'expertis', 'compromis',
  'promis', 'premis', 'supervis', 'revis', 'devis', 'compris', 'franchis',
  'disguis', 'demis', 'improvis', 'excis', 'paradis', 'cruis', 'pois',
  'appris', 'televis', 'advis', 'advertis', 'despis', 'bruis', 'concis',
  'precis', 'treatis', 'sunris', 'upris', 'likewis', 'otherwis',
];
const KEEP_SUFFIXES = ['e', 'es', 'ed', 'ing', 'er', 'ers'];
const KEEP = new Set([
  ...KEEP_ROOTS.flatMap(r => KEEP_SUFFIXES.map(s => r + s)),
  'crises', 'analyses', 'enterprising',
]);

const WORD = /\b([A-Za-z]+?)(is|ys)(e|es|ed|ing|ation|ations|er|ers)\b/g;

function convert(s) {
  return s
    .replace(WORD, (m, stem, mid, suf) => {
      const z = mid === 'is' ? 'iz' : 'yz';
      if (KEEP.has(m.toLowerCase()) || !DICT.has((stem + z + 'e').toLowerCase())) return m;
      return stem + z + suf;
    })
    .replace(/\bprogramme(s?)\b/g, 'program$1');
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
