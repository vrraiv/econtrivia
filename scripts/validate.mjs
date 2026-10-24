#!/usr/bin/env node
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const questionsDir = join(__dirname, '..', 'questions');

const VALID_FORMATS = ['mc', 'tf', 'numeric', 'order', 'higher_lower', 'match', 'short'];
const REQUIRE_SOURCE = new Set(['data', 'trends', 'finance']);

const errors = [];
const warnings = [];
const allQuestions = [];

function err(id, msg) { errors.push(`  [${id}] ERROR: ${msg}`); }
function warn(id, msg) { warnings.push(`  [${id}] WARN: ${msg}`); }

function validateMC(q) {
  if (!Array.isArray(q.choices) || q.choices.length !== 4)
    err(q.id, 'mc requires exactly 4 choices');
  else {
    if (!q.choices.includes(q.answer))
      err(q.id, `answer "${q.answer}" not found in choices`);
    if (new Set(q.choices).size !== 4)
      err(q.id, 'duplicate choices detected');
    const ansLen = String(q.answer).length;
    const others = q.choices.filter(c => c !== q.answer);
    const avgLen = others.reduce((s, c) => s + String(c).length, 0) / others.length;
    if (avgLen > 0 && (ansLen > avgLen * 2.5 || ansLen < avgLen * 0.4))
      warn(q.id, `answer length (${ansLen}) vs distractor avg (${avgLen.toFixed(0)}) — check plausibility`);
  }
}

function validateTF(q) {
  if (typeof q.answer !== 'boolean')
    err(q.id, 'tf: answer must be a JSON boolean (true or false)');
}

function validateNumeric(q) {
  if (typeof q.answer !== 'number')
    err(q.id, 'numeric: answer must be a number');
  if (q.unit === undefined)
    warn(q.id, 'numeric: missing unit field');
  if (q.tolerance == null && q.tolerance_pct == null)
    err(q.id, 'numeric: requires tolerance or tolerance_pct');
}

function validateOrder(q) {
  if (!Array.isArray(q.items) || q.items.length !== 4)
    err(q.id, 'order: requires exactly 4 items');
  if (!q.order_by)
    err(q.id, 'order: requires order_by field');
}

function validateHigherLower(q) {
  if (!Array.isArray(q.items) || q.items.length !== 2)
    err(q.id, 'higher_lower: requires exactly 2 items');
  else if (!q.items.includes(q.answer))
    err(q.id, `higher_lower: answer "${q.answer}" must be one of items[]`);
  if (!q.metric)
    err(q.id, 'higher_lower: requires metric field');
}

function validateMatch(q) {
  if (!Array.isArray(q.pairs) || q.pairs.length !== 4)
    err(q.id, 'match: requires exactly 4 pairs');
  else
    q.pairs.forEach((p, i) => {
      if (!Array.isArray(p) || p.length !== 2)
        err(q.id, `match: pair[${i}] must be a [left, right] array`);
    });
}

function validateShort(q) {
  if (typeof q.answer !== 'string')
    err(q.id, 'short: answer must be a string');
  if (!Array.isArray(q.accept) || q.accept.length === 0)
    err(q.id, 'short: requires non-empty accept[]');
  else if (!q.accept.includes(q.answer))
    err(q.id, 'short: answer must appear in accept[]');
}

const validators = {
  mc: validateMC, tf: validateTF, numeric: validateNumeric,
  order: validateOrder, higher_lower: validateHigherLower,
  match: validateMatch, short: validateShort,
};

const files = readdirSync(questionsDir)
  .filter(f => f.endsWith('.json'))
  .sort();

const idsSeen = new Map();

for (const file of files) {
  const category = file.replace('.json', '');
  let arr;
  try {
    arr = JSON.parse(readFileSync(join(questionsDir, file), 'utf8'));
  } catch (e) {
    errors.push(`[${file}] JSON parse failed: ${e.message}`);
    continue;
  }
  if (!Array.isArray(arr)) {
    errors.push(`[${file}] must be a JSON array`);
    continue;
  }

  for (const q of arr) {
    if (!q.id) { errors.push(`[${file}] question missing id`); continue; }

    if (!q.format || !VALID_FORMATS.includes(q.format))
      err(q.id, `invalid format "${q.format}"`);
    if (![1, 2, 3].includes(q.difficulty))
      err(q.id, `difficulty must be 1, 2, or 3 (got ${q.difficulty})`);
    if (!q.prompt) err(q.id, 'missing prompt');
    if (!q.explanation) err(q.id, 'missing explanation');
    if (q.category !== category)
      warn(q.id, `category "${q.category}" ≠ filename "${category}"`);

    if ((REQUIRE_SOURCE.has(q.category) || q.time_sensitive) && !q.source)
      err(q.id, `source required for category "${q.category}" or time_sensitive question`);
    if (q.time_sensitive && q.as_of == null)
      err(q.id, 'as_of required when time_sensitive is true');

    if (idsSeen.has(q.id))
      errors.push(`  [${q.id}] duplicate ID — also in ${idsSeen.get(q.id)}`);
    else
      idsSeen.set(q.id, file);

    validators[q.format]?.(q);
    allQuestions.push(q);
  }
}

// Near-duplicate prompt check (token Jaccard > 0.6)
function tokenize(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(s => s.length > 2)
  );
}
function jaccard(a, b) {
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}
const promptTokens = allQuestions.map(q => ({ id: q.id, tokens: tokenize(q.prompt) }));
for (let i = 0; i < promptTokens.length; i++) {
  for (let j = i + 1; j < promptTokens.length; j++) {
    const score = jaccard(promptTokens[i].tokens, promptTokens[j].tokens);
    if (score > 0.6)
      warnings.push(`  [${promptTokens[i].id}] near-duplicate prompt with ${promptTokens[j].id} (Jaccard ${score.toFixed(2)})`);
  }
}

// Distribution report
const catMap = {};
const diffMap = { 1: 0, 2: 0, 3: 0 };
const fmtMap = {};
for (const q of allQuestions) {
  catMap[q.category] = (catMap[q.category] || 0) + 1;
  diffMap[q.difficulty] = (diffMap[q.difficulty] || 0) + 1;
  fmtMap[q.format] = (fmtMap[q.format] || 0) + 1;
}
const n = allQuestions.length;

console.log('\n=== ECON TRIVIA VALIDATOR ===');
console.log(`Total questions loaded: ${n}`);

if (errors.length) {
  console.error('\nERRORS:');
  errors.forEach(e => console.error(e));
}
if (warnings.length) {
  console.warn('\nWARNINGS:');
  warnings.forEach(w => console.warn(w));
}

if (n > 0) {
  console.log('\nDifficulty:');
  console.log(`  Easy   (1): ${diffMap[1] || 0} (${(((diffMap[1]||0)/n)*100).toFixed(1)}%)  target 30%`);
  console.log(`  Medium (2): ${diffMap[2] || 0} (${(((diffMap[2]||0)/n)*100).toFixed(1)}%)  target 45%`);
  console.log(`  Hard   (3): ${diffMap[3] || 0} (${(((diffMap[3]||0)/n)*100).toFixed(1)}%)  target 25%`);

  console.log('\nFormats:');
  for (const [fmt, cnt] of Object.entries(fmtMap).sort(([,a],[,b]) => b - a))
    console.log(`  ${fmt.padEnd(14)}: ${cnt} (${(cnt/n*100).toFixed(1)}%)`);

  console.log('\nCategories:');
  for (const [cat, cnt] of Object.entries(catMap).sort(([,a],[,b]) => b - a))
    console.log(`  ${cat.padEnd(15)}: ${cnt}`);
}

if (errors.length > 0) {
  console.error(`\nValidation FAILED — ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
} else {
  console.log(`\nValidation PASSED${warnings.length ? ` — ${warnings.length} warning(s)` : ''}.`);
}
