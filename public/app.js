'use strict';

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

const DIFF_TARGETS = { 1: 4, 2: 5, 3: 3 };
const MAX_CAT = 2;

const GRADE_LABELS = [
  [11, 'Nobel Laureate'],
  [10, 'Tenured Professor'],
  [8,  'Post-doc'],
  [6,  'Grad Student'],
  [4,  'Undergrad'],
  [0,  'Rationally Inattentive'],
];

const DIFF_NAMES = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };

// ═══════════════════════════════════════
// STORAGE (try/catch — app works if blocked)
// ═══════════════════════════════════════

const S = {
  get(k, d) {
    try { return JSON.parse(localStorage.getItem('et:' + k)) ?? d; }
    catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('et:' + k, JSON.stringify(v)); }
    catch { /* blocked */ }
  },
  del(k) {
    try { localStorage.removeItem('et:' + k); }
    catch {}
  },
};

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════

let allQuestions = [];

// round = { ids: string[], answers: (boolean|null)[], current: number }
let round = null;

// Per-render mutable state for interactive formats
let _order = { items: [], selected: null };
let _match = { selectedLeft: null, pairs: [] };  // pairs: [left, right][]

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

/** Deterministic shuffle using question id as seed — stable on re-renders. */
function shuffled(arr, seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.addEventListener('click', onClick);
  return b;
}

function qById(id) { return allQuestions.find(q => q.id === id); }

// ═══════════════════════════════════════
// ROUND ASSEMBLY
// ═══════════════════════════════════════

function assembleRound() {
  const seen = new Set(S.get('seen', []));
  const unseen = allQuestions.filter(q => !seen.has(q.id));
  if (unseen.length < 5) return null;

  // Degrade quotas if pool is thin
  const byDiff = { 1: [], 2: [], 3: [] };
  unseen.forEach(q => (byDiff[q.difficulty] ??= []).push(q));

  const targets = { ...DIFF_TARGETS };
  let surplus = 0;

  for (const d of [3, 2, 1]) {
    const avail = (byDiff[d] || []).length;
    if (avail < targets[d]) { surplus += targets[d] - avail; targets[d] = avail; }
  }
  for (const d of [2, 1]) {
    if (surplus <= 0) break;
    const can = Math.min(surplus, (byDiff[d] || []).length - targets[d]);
    if (can > 0) { targets[d] += can; surplus -= can; }
  }

  const catCount = {};
  const easy = [], med = [], hard = [];

  for (const [d, bucket] of [[3, hard], [2, med], [1, easy]]) {
    const pool = randomShuffle(byDiff[d] || []);
    let picked = 0;
    for (const q of pool) {
      if (picked >= targets[d]) break;
      if ((catCount[q.category] || 0) >= MAX_CAT) continue;
      catCount[q.category] = (catCount[q.category] || 0) + 1;
      bucket.push(q);
      picked++;
    }
  }

  // Interleave so difficulty levels are spread across the round, not front-loaded
  const final = randomShuffle([...easy, ...med, ...hard]);

  return final.length >= 5 ? final : null;
}

// ═══════════════════════════════════════
// GRADING
// ═══════════════════════════════════════

function normalise(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const curr = a[i-1] === b[j-1] ? row[j-1] : 1 + Math.min(row[j-1], row[j], prev);
      row[j-1] = prev;
      prev = curr;
    }
    row[n] = prev;
  }
  return row[n];
}

function fuzzyMatch(input, target) {
  const a = normalise(input), b = normalise(target);
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) return false;
  return levenshtein(a, b) <= (maxLen < 8 ? 1 : 2);
}

function gradeAnswer(q, response) {
  switch (q.format) {
    case 'mc':
    case 'higher_lower':
      return response === q.answer;
    case 'tf':
      return response === q.answer;
    case 'numeric': {
      const n = parseFloat(response);
      if (isNaN(n)) return false;
      if (q.tolerance != null) return Math.abs(n - q.answer) <= q.tolerance;
      if (q.tolerance_pct != null)
        return Math.abs(n - q.answer) / Math.abs(q.answer) * 100 <= q.tolerance_pct;
      return false;
    }
    case 'order':
      return Array.isArray(response) &&
        q.items.every((item, i) => item === response[i]);
    case 'match':
      return Array.isArray(response) && q.pairs.length === response.length &&
        q.pairs.every(([l, r]) => {
          const found = response.find(([ul]) => ul === l);
          return found && found[1] === r;
        });
    case 'short':
      return q.accept.some(a => fuzzyMatch(response, a));
    default: return false;
  }
}

// ═══════════════════════════════════════
// SCREEN MANAGEMENT
// ═══════════════════════════════════════

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => {
    const on = el.id === id;
    el.classList.toggle('active', on);
    el.classList.toggle('hidden', !on);
  });
}

// ═══════════════════════════════════════
// LANDING
// ═══════════════════════════════════════

function showLanding() {
  const stats = S.get('stats', null);
  const seenIds = S.get('seen', []);
  const remaining = allQuestions.length - seenIds.length;

  const statsEl = document.getElementById('stats-display');
  if (stats && stats.rounds > 0) {
    const pct = stats.total > 0 ? Math.round(stats.correct / stats.total * 100) : 0;
    statsEl.textContent =
      `Welcome back — ${stats.rounds} round${stats.rounds !== 1 ? 's' : ''} played, ${pct}% correct, ${remaining} question${remaining !== 1 ? 's' : ''} left`;
    statsEl.classList.remove('hidden');
  } else {
    statsEl.classList.add('hidden');
  }

  const thinEl = document.getElementById('thin-pool-msg');
  if (remaining < 12) {
    thinEl.innerHTML = `Only ${remaining} unseen question${remaining !== 1 ? 's' : ''} left.
      <button class="link-btn" id="btn-reset-inline">Reset history</button> to start fresh.`;
    thinEl.classList.remove('hidden');
    document.getElementById('btn-reset-inline')?.addEventListener('click', resetHistory);
  } else {
    thinEl.classList.add('hidden');
  }

  showScreen('screen-landing');
}

// ═══════════════════════════════════════
// START / RESUME ROUND
// ═══════════════════════════════════════

function startRound() {
  const saved = S.get('round', null);
  if (saved?.ids?.length && saved.answers) {
    round = saved;
    showScreen('screen-round');
    renderQuestion();
    return;
  }

  const qs = assembleRound();
  if (!qs) {
    const thinEl = document.getElementById('thin-pool-msg');
    thinEl.innerHTML = `Not enough unseen questions for a round.
      <button class="link-btn" id="btn-reset-inline">Reset history</button> to play again.`;
    thinEl.classList.remove('hidden');
    document.getElementById('btn-reset-inline')?.addEventListener('click', resetHistory);
    return;
  }

  round = { ids: qs.map(q => q.id), answers: new Array(qs.length).fill(null), current: 0 };
  S.set('round', round);
  showScreen('screen-round');
  renderQuestion();
}

// ═══════════════════════════════════════
// RENDER QUESTION
// ═══════════════════════════════════════

function renderQuestion() {
  const q = qById(round.ids[round.current]);
  if (!q) { endRound(); return; }

  const pct = (round.current / round.ids.length) * 100;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('q-counter').textContent = `${round.current + 1} / ${round.ids.length}`;
  document.getElementById('chip-category').textContent = q.category;

  const diffChip = document.getElementById('chip-difficulty');
  diffChip.textContent = DIFF_NAMES[q.difficulty] || q.difficulty;
  diffChip.className = `chip diff-${q.difficulty}`;

  document.getElementById('question-prompt').textContent = q.prompt;

  const answerArea = document.getElementById('answer-area');
  answerArea.innerHTML = '';
  const feedbackArea = document.getElementById('feedback-area');
  feedbackArea.innerHTML = '';
  feedbackArea.classList.add('hidden');

  const nextBtn = document.getElementById('btn-next');
  nextBtn.classList.add('hidden');

  const alreadyAnswered = round.answers[round.current] !== null;
  buildAnswerUI(q, answerArea, alreadyAnswered);

  if (alreadyAnswered) {
    renderFeedback(q, round.answers[round.current]);
    nextBtn.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// ANSWER UI BUILDERS
// ═══════════════════════════════════════

function buildAnswerUI(q, container, answered, submittedResponse) {
  switch (q.format) {
    case 'mc':           buildMC(q, container, answered); break;
    case 'tf':           buildTF(q, container, answered); break;
    case 'numeric':      buildNumeric(q, container, answered); break;
    case 'order':        buildOrder(q, container, answered, submittedResponse); break;
    case 'higher_lower': buildHL(q, container, answered); break;
    case 'match':        buildMatch(q, container, answered); break;
    case 'short':        buildShort(q, container, answered); break;
  }
}

// ── MC ──────────────────────────────────

function buildMC(q, c, answered) {
  const choices = shuffled(q.choices, q.id);
  const ul = el('ul', 'mc-list');
  choices.forEach(choice => {
    const li = el('li');
    const b = el('button', 'mc-option', choice);
    b.setAttribute('aria-label', choice);
    if (answered) {
      b.disabled = true;
      b.classList.add(choice === q.answer ? 'correct' : 'dim');
    } else {
      b.addEventListener('click', () => submit(q, choice));
    }
    li.appendChild(b);
    ul.appendChild(li);
  });
  c.appendChild(ul);
}

// ── TF ──────────────────────────────────

function buildTF(q, c, answered) {
  const wrap = el('div', 'tf-wrap');
  [['True', true], ['False', false]].forEach(([label, val]) => {
    const b = el('button', 'tf-option', label);
    if (answered) {
      b.disabled = true;
      b.classList.add(val === q.answer ? 'correct' : 'dim');
    } else {
      b.addEventListener('click', () => submit(q, val));
    }
    wrap.appendChild(b);
  });
  c.appendChild(wrap);
}

// ── NUMERIC ─────────────────────────────

function buildNumeric(q, c, answered) {
  const wrap = el('div', 'numeric-wrap');

  if (q.unit) {
    const hint = el('p', 'unit-label', `Answer in: ${q.unit}`);
    wrap.appendChild(hint);
  }

  const input = el('input');
  input.type = 'number';
  input.className = 'numeric-input';
  input.placeholder = 'Enter a number…';
  input.setAttribute('aria-label', 'Your numeric answer');
  if (answered) { input.value = q.answer; input.disabled = true; }

  const submitBtn = el('button', 'btn-primary', 'Submit');
  if (answered) {
    submitBtn.disabled = true;
  } else {
    const go = () => { const v = input.value.trim(); if (v !== '') submit(q, v); };
    submitBtn.addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    setTimeout(() => input.focus(), 50);
  }

  wrap.appendChild(input);
  wrap.appendChild(submitBtn);
  c.appendChild(wrap);
}

// ── ORDER (▲/▼ move buttons) ─────────────

function buildOrder(q, c, answered, submittedItems) {
  // When re-rendering after submit, show what the user actually submitted
  // so they can see exactly which positions were right or wrong.
  // On resume (submittedItems unavailable), fall back to correct order.
  _order = {
    items: answered
      ? (Array.isArray(submittedItems) ? [...submittedItems] : [...q.items])
      : shuffled(q.items, q.id + '_order'),
  };

  const wrap = el('div', 'order-wrap');
  const list = el('ol', 'order-list');
  list.setAttribute('aria-label', `Order items by ${q.order_by}`);

  function redraw() {
    list.innerHTML = '';
    _order.items.forEach((item, idx) => {
      const li = el('li', 'order-item');

      if (answered) {
        const isCorrect = q.items[idx] === item;
        li.classList.add(isCorrect ? 'correct-pos' : 'wrong-pos');
      } else {
        // ▲ / ▼ move buttons
        const moveBtns = el('div', 'order-move-btns');

        const upBtn = el('button', 'order-move-btn', '▲');
        upBtn.setAttribute('aria-label', `Move "${item}" up`);
        if (idx === 0) {
          upBtn.disabled = true;
        } else {
          upBtn.addEventListener('click', e => {
            e.stopPropagation();
            [_order.items[idx - 1], _order.items[idx]] = [_order.items[idx], _order.items[idx - 1]];
            redraw();
          });
        }

        const downBtn = el('button', 'order-move-btn', '▼');
        downBtn.setAttribute('aria-label', `Move "${item}" down`);
        if (idx === _order.items.length - 1) {
          downBtn.disabled = true;
        } else {
          downBtn.addEventListener('click', e => {
            e.stopPropagation();
            [_order.items[idx], _order.items[idx + 1]] = [_order.items[idx + 1], _order.items[idx]];
            redraw();
          });
        }

        moveBtns.appendChild(upBtn);
        moveBtns.appendChild(downBtn);
        li.appendChild(moveBtns);
      }

      const posNum = el('span', 'order-pos-num', String(idx + 1));
      const text = el('span', 'order-item-text', item);
      li.appendChild(posNum);
      li.appendChild(text);

      list.appendChild(li);
    });
  }

  redraw();
  wrap.appendChild(list);

  if (!answered) {
    wrap.appendChild(el('p', 'order-hint', 'Use ▲ ▼ to arrange items, then submit.'));
    wrap.appendChild(btn('Submit order', 'btn-primary order-submit',
      () => submit(q, [..._order.items])));
  }
  c.appendChild(wrap);
}

// ── HIGHER / LOWER ──────────────────────

function buildHL(q, c, answered) {
  const wrap = el('div', 'hl-wrap');
  wrap.appendChild(el('p', 'hl-metric', `Which is higher? ${q.metric}`));
  shuffled(q.items, q.id + '_hl').forEach(item => {
    const b = el('button', 'hl-option', item);
    if (answered) {
      b.disabled = true;
      b.classList.add(item === q.answer ? 'correct' : 'dim');
    } else {
      b.addEventListener('click', () => submit(q, item));
    }
    wrap.appendChild(b);
  });
  c.appendChild(wrap);
}

// ── MATCH ───────────────────────────────

function buildMatch(q, c, answered) {
  if (!answered) {
    _match = { selectedLeft: null, pairs: [] };
  } else {
    _match = { selectedLeft: null, pairs: [...q.pairs] };
  }

  const leftItems = q.pairs.map(([l]) => l);
  const rightItems = shuffled(q.pairs.map(([, r]) => r), q.id + '_match');

  const wrap = el('div', 'match-wrap');
  const grid = el('div', 'match-grid');
  const leftCol = el('div', 'match-col match-left-col');
  const rightCol = el('div', 'match-col match-right-col');

  function redraw() {
    leftCol.innerHTML = '';
    rightCol.innerHTML = '';

    leftItems.forEach(item => {
      const paired = _match.pairs.find(([l]) => l === item);
      const b = el('button', 'match-item match-left', item);
      if (answered)      { b.disabled = true; b.classList.add('correct'); }
      else if (paired)   { b.classList.add('paired'); }
      if (_match.selectedLeft === item) b.classList.add('selected');
      if (!answered) {
        b.addEventListener('click', () => {
          if (_match.pairs.find(([l]) => l === item)) {
            _match.pairs = _match.pairs.filter(([l]) => l !== item);
            _match.selectedLeft = null;
          } else {
            _match.selectedLeft = _match.selectedLeft === item ? null : item;
          }
          redraw(); updateSubmitBtn();
        });
      }
      leftCol.appendChild(b);
    });

    rightItems.forEach(item => {
      const pairedLeft = _match.pairs.find(([, r]) => r === item);
      const b = el('button', 'match-item match-right', item);
      if (answered)       { b.disabled = true; b.classList.add('correct'); }
      else if (pairedLeft){ b.classList.add('paired'); }
      if (!answered) {
        b.addEventListener('click', () => {
          if (!_match.selectedLeft) return;
          const left = _match.selectedLeft;
          _match.pairs = _match.pairs.filter(([l]) => l !== left).filter(([, r]) => r !== item);
          _match.pairs.push([left, item]);
          _match.selectedLeft = null;
          redraw(); updateSubmitBtn();
        });
      }
      rightCol.appendChild(b);
    });
  }

  redraw();
  grid.appendChild(leftCol);
  grid.appendChild(rightCol);
  wrap.appendChild(grid);

  if (!answered) {
    wrap.appendChild(el('p', 'match-hint', 'Tap a left item, then the matching right item.'));
    const submitBtn = el('button', 'btn-primary match-submit', 'Submit matches');
    submitBtn.id = 'match-submit-btn';
    submitBtn.disabled = true;
    submitBtn.addEventListener('click', () => submit(q, [..._match.pairs]));
    wrap.appendChild(submitBtn);
  }

  c.appendChild(wrap);
}

function updateSubmitBtn() {
  const b = document.getElementById('match-submit-btn');
  if (b) b.disabled = _match.pairs.length < 4;
}

// ── SHORT ────────────────────────────────

function buildShort(q, c, answered) {
  const wrap = el('div', 'short-wrap');
  const input = el('input');
  input.type = 'text';
  input.className = 'short-input';
  input.placeholder = 'Type your answer…';
  input.setAttribute('aria-label', 'Short answer');
  if (answered) { input.value = q.answer; input.disabled = true; }

  const submitBtn = el('button', 'btn-primary', 'Submit');
  if (answered) {
    submitBtn.disabled = true;
  } else {
    const go = () => { const v = input.value.trim(); if (v) submit(q, v); };
    submitBtn.addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    setTimeout(() => input.focus(), 50);
  }

  wrap.appendChild(input);
  wrap.appendChild(submitBtn);
  c.appendChild(wrap);
}

// ═══════════════════════════════════════
// SUBMIT & FEEDBACK
// ═══════════════════════════════════════

function submit(q, response) {
  const correct = gradeAnswer(q, response);
  round.answers[round.current] = correct;
  S.set('round', round);

  const seen = new Set(S.get('seen', []));
  seen.add(q.id);
  S.set('seen', [...seen]);

  // Rebuild answer area in answered state to show correct options highlighted
  const answerArea = document.getElementById('answer-area');
  answerArea.innerHTML = '';
  buildAnswerUI(q, answerArea, true, response);

  renderFeedback(q, correct, response);
  const nextBtn = document.getElementById('btn-next');
  nextBtn.classList.remove('hidden');
  nextBtn.focus();
}

function renderFeedback(q, correct, response) {
  const area = document.getElementById('feedback-area');
  area.classList.remove('hidden');

  const badge = el('div', `feedback-badge ${correct ? 'correct' : 'wrong'}`,
    correct ? '✓ Correct' : '✗ Wrong');
  area.appendChild(badge);

  if (!correct) {
    if (q.format === 'order' && Array.isArray(response)) {
      const userAns = el('p', 'feedback-correct-ans');
      userAns.innerHTML = `Your order: <strong>${esc(response.join(' → '))}</strong>`;
      area.appendChild(userAns);
    }
    const ans = el('p', 'feedback-correct-ans');
    ans.innerHTML = `Correct answer: <strong>${esc(formatAnswer(q))}</strong>`;
    area.appendChild(ans);
  }

  area.appendChild(el('p', 'feedback-explanation', q.explanation));

  if (q.source) {
    const link = el('a', 'feedback-source', 'Source ↗');
    link.href = q.source;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    area.appendChild(link);
  }
}

function formatAnswer(q) {
  switch (q.format) {
    case 'tf':    return q.answer ? 'True' : 'False';
    case 'numeric': return `${q.answer}${q.unit ? ' ' + q.unit : ''}`;
    case 'order': return q.items.join(' → ');
    case 'match': return q.pairs.map(([l, r]) => `${l} → ${r}`).join('; ');
    case 'short': return q.accept.length > 1 ? `${q.answer} (or: ${q.accept.slice(1).join(', ')})` : q.answer;
    default:      return String(q.answer);
  }
}

// ═══════════════════════════════════════
// NEXT QUESTION
// ═══════════════════════════════════════

function nextQuestion() {
  round.current++;
  S.set('round', round);
  if (round.current >= round.ids.length) endRound();
  else renderQuestion();
}

// ═══════════════════════════════════════
// END ROUND
// ═══════════════════════════════════════

function endRound() {
  const correct = round.answers.filter(a => a === true).length;
  const total   = round.answers.length;
  S.del('round');

  const stats = S.get('stats', { rounds: 0, correct: 0, total: 0 });
  stats.rounds++;
  stats.correct += correct;
  stats.total   += total;
  S.set('stats', stats);

  const grade = gradeLabel(correct);

  const catMap = {};
  round.ids.forEach((id, i) => {
    const q = qById(id);
    if (!q) return;
    catMap[q.category] ??= { c: 0, t: 0 };
    catMap[q.category].t++;
    if (round.answers[i]) catMap[q.category].c++;
  });

  const catHTML = Object.entries(catMap)
    .sort(([, a], [, b]) => b.c / b.t - a.c / a.t)
    .map(([cat, {c, t}]) => `<span class="cat-result"><strong>${esc(cat)}</strong> ${c}/${t}</span>`)
    .join('');

  const emojiGrid = buildGrid(round.answers);
  const shareText = `📊 ECON PUB TRIVIA\n${correct}/${total} · ${grade}\n\n${emojiGrid}\n\necontrivia.ca`;

  const ec = document.getElementById('end-content');
  ec.innerHTML = `
    <h2 class="end-score">${correct}<span style="font-size:0.45em;font-weight:400;color:var(--text-muted)"> / ${total}</span></h2>
    <p class="end-grade">${esc(grade)}</p>
    <div class="cat-breakdown">${catHTML}</div>
    <div class="end-actions">
      <button id="btn-copy" class="btn-secondary">📋 Copy results</button>
      <button id="btn-play-again" class="btn-primary">Play again</button>
    </div>
    <pre class="emoji-preview" aria-label="Results grid">${esc(emojiGrid)}</pre>
  `;

  document.getElementById('btn-copy').addEventListener('click', () => {
    const copyBtn = document.getElementById('btn-copy');
    navigator.clipboard?.writeText(shareText)
      .then(() => { copyBtn.textContent = '✓ Copied!'; })
      .catch(() => { copyBtn.textContent = '✗ Try again'; });
  });

  document.getElementById('btn-play-again').addEventListener('click', () => {
    round = null;
    showLanding();
  });

  showScreen('screen-end');
}

function gradeLabel(score) {
  for (const [min, label] of GRADE_LABELS) {
    if (score >= min) return label;
  }
  return GRADE_LABELS.at(-1)[1];
}

function buildGrid(answers) {
  const cells = answers.map(a => a ? '🟩' : '🟥');
  const rows = [];
  for (let i = 0; i < cells.length; i += 6) rows.push(cells.slice(i, i + 6).join(''));
  return rows.join('\n');
}

// ═══════════════════════════════════════
// RESET HISTORY
// ═══════════════════════════════════════

function resetHistory() {
  if (!confirm('Reset your question history and stats? This cannot be undone.')) return;
  S.del('seen'); S.del('stats'); S.del('round');
  round = null;
  showLanding();
}

// ═══════════════════════════════════════
// KEYBOARD: Enter advances when Next is visible
// ═══════════════════════════════════════

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const nb = document.getElementById('btn-next');
  if (nb && !nb.classList.contains('hidden') && document.activeElement !== nb &&
      document.activeElement?.tagName !== 'BUTTON') {
    e.preventDefault();
    nextQuestion();
  }
});

// ═══════════════════════════════════════
// WIRE UP PERSISTENT BUTTONS
// ═══════════════════════════════════════

document.getElementById('btn-start').addEventListener('click', startRound);
document.getElementById('btn-next').addEventListener('click', nextQuestion);
document.getElementById('btn-reset-history').addEventListener('click', resetHistory);

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

(async function init() {
  try {
    const res = await fetch('/questions.json');
    if (!res.ok) throw new Error(res.statusText);
    allQuestions = await res.json();
  } catch {
    document.getElementById('app').innerHTML =
      `<p class="error">Could not load questions. Run <code>npm run build</code> first.</p>`;
    return;
  }
  showLanding();
}());
