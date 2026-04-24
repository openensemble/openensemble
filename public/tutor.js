// ── TTS / Pronunciation ──────────────────────────────────────────────────────
let _ttsConfigured = false;

function pronounceWord(text, lang) {
  if (_ttsConfigured) {
    fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang }) })
      .then(r => r.json()).then(data => {
        if (data.audio) {
          const audio = new Audio(`data:${data.mimeType || 'audio/mp3'};base64,${data.audio}`);
          audio.play();
        } else { pronounceWordBrowser(text, lang); }
      }).catch(() => pronounceWordBrowser(text, lang));
  } else {
    pronounceWordBrowser(text, lang);
  }
}

function pronounceWordBrowser(text, lang) {
  if (!window.speechSynthesis) { showToast('Audio not available in this browser'); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 0.85;
  const voices = window.speechSynthesis.getVoices();
  const match = voices.find(v => v.lang.startsWith(lang)) || voices.find(v => v.lang.split('-')[0] === lang.split('-')[0]);
  if (match) u.voice = match;
  window.speechSynthesis.speak(u);
}

function renderMarkdown(text) {
  return renderTutorWidgets(renderPronounceButtons(DOMPurify.sanitize(marked.parse(text))));
}

// ── Widget dispatcher ────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function newWidgetId() { return 'tw_' + Math.random().toString(36).slice(2, 8); }

function renderTutorWidgets(html) {
  return html.replace(/<pre><code class="language-tutor-widget">([\s\S]*?)<\/code><\/pre>/g, (_, jsonStr) => {
    try {
      const decoded = jsonStr.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      const data = JSON.parse(decoded);
      const builder = WIDGET_BUILDERS[data.type];
      if (builder) return builder(data);
      return `<pre><code>${jsonStr}</code></pre>`;
    } catch (e) {
      console.warn('[tutor-widget] parse error:', e.message);
      return `<pre><code>${jsonStr}</code></pre>`;
    }
  });
}

const WIDGET_BUILDERS = {
  quiz:          buildQuizWidget,
  fill_blank:    buildFillBlankWidget,
  cloze:         buildClozeWidget,
  flashcard:     buildFlashcardWidget,
  free_response: buildFreeResponseWidget,
  ordering:      buildOrderingWidget,
  matching:      buildMatchingWidget,
  hotspot:       buildHotspotWidget,
  speak:         buildSpeakWidget,
  celebration:   buildCelebrationWidget,
};

// ── Widget stream targets (Map supports multiple pending widgets per turn) ───
// Key: wid. Value: { respEl is resolved by id at render time } — we key on wid
// only and re-resolve DOM nodes each token so renders survive DOM rebuilds.
const _widgetTargets = new Map(); // wid -> { buf: string, kind: string }
let _activeWidgetTarget = null; // wid currently receiving stream

function setWidgetStreamTarget(wid, kind) {
  _widgetTargets.set(wid, { buf: '', kind });
  _activeWidgetTarget = wid;
}

function getActiveWidgetTarget() { return _activeWidgetTarget; }

function clearActiveWidgetTarget() {
  const wid = _activeWidgetTarget;
  _activeWidgetTarget = null;
  return wid;
}

function widgetStreamAppend(text) {
  if (!_activeWidgetTarget) return false;
  const entry = _widgetTargets.get(_activeWidgetTarget);
  if (!entry) return false;
  entry.buf += text;
  paintWidgetStream(_activeWidgetTarget, entry.buf);
  return true;
}

function widgetStreamReplace(text) {
  if (!_activeWidgetTarget) return false;
  const entry = _widgetTargets.get(_activeWidgetTarget);
  if (!entry) return false;
  entry.buf = text;
  paintWidgetStream(_activeWidgetTarget, entry.buf);
  return true;
}

function paintWidgetStream(wid, text) {
  const respEl = document.getElementById(wid + '_resp');
  if (!respEl) return;
  respEl.classList.add('visible');
  const inner = respEl.querySelector('.tutor-response-inner');
  if (inner) inner.innerHTML = renderMarkdown(text);
}

function widgetStreamFinish() {
  const wid = _activeWidgetTarget;
  if (!wid) return null;
  const entry = _widgetTargets.get(wid);
  _widgetTargets.delete(wid);
  _activeWidgetTarget = null;
  return entry?.buf || '';
}

// Back-compat alias — old websocket.js inline code still references this in a
// few places; keep a read-only view so refactor is incremental.
Object.defineProperty(window, '_quizWidgetTarget', {
  get() { return _activeWidgetTarget; },
  set(v) { _activeWidgetTarget = v; },
  configurable: true,
});

// ── Shared submit helper ─────────────────────────────────────────────────────
// kind is the widget type string (e.g. 'quiz', 'fill_blank'); answer is the
// serialized user answer. If routeToWidget=true, model response streams into
// the widget instead of creating a chat bubble.
function submitWidgetAnswer(wid, kind, payload, { routeToWidget = true } = {}) {
  if (typeof ws === 'undefined' || ws?.readyState !== 1) return;
  const parts = [`[Widget answer: ${kind}`];
  if (payload.memoryId) parts.push(`review_id: ${payload.memoryId}`);
  parts.push(`data: ${JSON.stringify(payload.data ?? {})}]`);
  const text = parts.join(' — ');
  if (routeToWidget) setWidgetStreamTarget(wid, kind);
  if (!sessions[activeAgent]) sessions[activeAgent] = [];
  sessions[activeAgent].push({ role: 'user', content: text, ts: Date.now(), hidden: true });
  if (typeof setStreaming === 'function') setStreaming(true);
  if (typeof setTyping === 'function') setTyping(true);
  ws.send(JSON.stringify({ type: 'chat', agent: activeAgent, text }));
}

// ── Quiz widget (multiple choice) ────────────────────────────────────────────
function buildQuizWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  const options = (data.options || []).map(o => {
    return `<div class="tutor-widget-option" data-wid="${wid}" data-label="${esc(o.label)}" onclick="handleQuizAnswer(this,'${wid}','${esc(data.correct || '')}','${esc(data.memoryId || '')}')">
      <span class="opt-label">${esc(o.label)}</span>
      <span>${esc(o.text)}</span>
    </div>`;
  }).join('');
  return `<div class="tutor-widget" id="${wid}" data-kind="quiz">
    ${reviewBadge}
    <div class="tutor-widget-question">${esc(data.question)}</div>
    <div class="tutor-widget-options">${options}</div>
    <div class="tutor-widget-explanation" id="${wid}_expl">${esc(data.explanation)}</div>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

function handleQuizAnswer(el, wid, correct, memoryId) {
  const widget = document.getElementById(wid);
  if (!widget) return;
  const chosen = el.dataset.label;
  const isCorrect = chosen === correct;
  widget.querySelectorAll('.tutor-widget-option').forEach(opt => {
    opt.classList.add('disabled');
    if (opt.dataset.label === correct) opt.classList.add('correct');
    if (opt.dataset.label === chosen && !isCorrect) opt.classList.add('incorrect');
  });
  const expl = document.getElementById(wid + '_expl');
  if (expl) expl.classList.add('visible');
  setTimeout(() => {
    submitWidgetAnswer(wid, 'quiz', {
      memoryId,
      data: { chosen, correct, result: isCorrect ? 'correct' : 'incorrect' },
    });
  }, 800);
}

// ── Fill-in-blank widget ─────────────────────────────────────────────────────
function buildFillBlankWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  const prompt = esc(data.question || data.prompt || '');
  return `<div class="tutor-widget" id="${wid}" data-kind="fill_blank">
    ${reviewBadge}
    <div class="tutor-widget-question">${prompt}</div>
    <div class="tutor-widget-input-row">
      <input type="text" class="tutor-widget-input" id="${wid}_input" placeholder="Your answer" onkeydown="if(event.key==='Enter'){handleFillBlankSubmit('${wid}','${esc(data.memoryId || '')}',${JSON.stringify(data.answers || [data.answer]).replace(/"/g,'&quot;')})}" />
      <button class="tutor-widget-submit" onclick="handleFillBlankSubmit('${wid}','${esc(data.memoryId || '')}',${JSON.stringify(data.answers || [data.answer]).replace(/"/g,'&quot;')})">Submit</button>
    </div>
    <div class="tutor-widget-explanation" id="${wid}_expl">${esc(data.explanation)}</div>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

function normalizeForCompare(s) {
  return String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function handleFillBlankSubmit(wid, memoryId, answersJson) {
  const input = document.getElementById(wid + '_input');
  if (!input || input.disabled) return;
  const widget = document.getElementById(wid);
  const user = input.value.trim();
  let answers = [];
  try { answers = typeof answersJson === 'string' ? JSON.parse(answersJson) : answersJson; } catch {}
  if (!Array.isArray(answers)) answers = [answers];
  const isCorrect = answers.some(a => normalizeForCompare(a) === normalizeForCompare(user));
  input.disabled = true;
  widget.querySelector('.tutor-widget-submit')?.setAttribute('disabled', 'true');
  input.classList.add(isCorrect ? 'correct' : 'incorrect');
  const expl = document.getElementById(wid + '_expl');
  if (expl) {
    if (!isCorrect) expl.innerHTML = `Expected: <strong>${esc(answers[0])}</strong><br>` + expl.innerHTML;
    expl.classList.add('visible');
  }
  submitWidgetAnswer(wid, 'fill_blank', {
    memoryId,
    data: { user, expected: answers, result: isCorrect ? 'correct' : 'incorrect' },
  });
}

// ── Cloze widget (inline [[blanks]]) ─────────────────────────────────────────
function buildClozeWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  const blanks = [];
  const template = (data.template || data.text || '').replace(/\[\[([^\]]+)\]\]/g, (_, answer) => {
    const i = blanks.length;
    blanks.push(answer);
    return `<input type="text" class="tutor-widget-cloze-input" id="${wid}_b${i}" data-wid="${wid}" placeholder="…" />`;
  });
  const blanksJson = JSON.stringify(blanks).replace(/"/g, '&quot;');
  return `<div class="tutor-widget" id="${wid}" data-kind="cloze" data-blanks="${blanksJson}">
    ${reviewBadge}
    <div class="tutor-widget-cloze-body">${template}</div>
    <button class="tutor-widget-submit" onclick="handleClozeSubmit('${wid}','${esc(data.memoryId || '')}')">Check</button>
    <div class="tutor-widget-explanation" id="${wid}_expl">${esc(data.explanation)}</div>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

function handleClozeSubmit(wid, memoryId) {
  const widget = document.getElementById(wid);
  if (!widget) return;
  let blanks = [];
  try { blanks = JSON.parse(widget.dataset.blanks.replace(/&quot;/g, '"')); } catch {}
  const userAnswers = blanks.map((_, i) => document.getElementById(`${wid}_b${i}`)?.value?.trim() || '');
  const correctness = blanks.map((expected, i) =>
    normalizeForCompare(expected) === normalizeForCompare(userAnswers[i]));
  const allCorrect = correctness.every(Boolean);
  blanks.forEach((expected, i) => {
    const input = document.getElementById(`${wid}_b${i}`);
    if (!input) return;
    input.disabled = true;
    input.classList.add(correctness[i] ? 'correct' : 'incorrect');
    if (!correctness[i]) input.title = `Expected: ${expected}`;
  });
  widget.querySelector('.tutor-widget-submit')?.setAttribute('disabled', 'true');
  const expl = document.getElementById(wid + '_expl');
  if (expl) expl.classList.add('visible');
  submitWidgetAnswer(wid, 'cloze', {
    memoryId,
    data: { user: userAnswers, expected: blanks, correctness, result: allCorrect ? 'correct' : 'incorrect' },
  });
}

// ── Flashcard widget (self-rated SRS) ────────────────────────────────────────
function buildFlashcardWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  return `<div class="tutor-widget" id="${wid}" data-kind="flashcard">
    ${reviewBadge}
    <div class="tutor-widget-flashcard-front">${esc(data.front || data.question)}</div>
    <div class="tutor-widget-flashcard-back" id="${wid}_back" hidden>${esc(data.back || data.answer)}</div>
    <div class="tutor-widget-flashcard-actions">
      <button class="tutor-widget-submit" id="${wid}_reveal" onclick="handleFlashcardReveal('${wid}')">Reveal</button>
      <div class="tutor-widget-flashcard-ratings" id="${wid}_ratings" hidden>
        <button data-rating="again" onclick="handleFlashcardRate('${wid}','${esc(data.memoryId || '')}','again')">Again</button>
        <button data-rating="hard"  onclick="handleFlashcardRate('${wid}','${esc(data.memoryId || '')}','hard')">Hard</button>
        <button data-rating="good"  onclick="handleFlashcardRate('${wid}','${esc(data.memoryId || '')}','good')">Good</button>
        <button data-rating="easy"  onclick="handleFlashcardRate('${wid}','${esc(data.memoryId || '')}','easy')">Easy</button>
      </div>
    </div>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

function handleFlashcardReveal(wid) {
  const back = document.getElementById(wid + '_back');
  const reveal = document.getElementById(wid + '_reveal');
  const ratings = document.getElementById(wid + '_ratings');
  if (back) back.hidden = false;
  if (reveal) reveal.style.display = 'none';
  if (ratings) ratings.hidden = false;
}

function handleFlashcardRate(wid, memoryId, rating) {
  const ratings = document.getElementById(wid + '_ratings');
  if (!ratings || ratings.dataset.submitted) return;
  ratings.dataset.submitted = '1';
  ratings.querySelectorAll('button').forEach(b => {
    b.disabled = true;
    if (b.dataset.rating === rating) b.classList.add('selected');
  });
  // Flashcard does NOT route to widget — no streaming response needed.
  submitWidgetAnswer(wid, 'flashcard', {
    memoryId,
    data: { rating },
  }, { routeToWidget: false });
}

// ── Free response widget ─────────────────────────────────────────────────────
function buildFreeResponseWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  const rubricBlock = Array.isArray(data.rubric) && data.rubric.length
    ? `<details class="tutor-widget-rubric"><summary>Grading rubric (${data.rubric.length})</summary><ul>${data.rubric.map(r => `<li>${esc(r)}</li>`).join('')}</ul></details>`
    : '';
  const rubricJson = JSON.stringify(data.rubric || []).replace(/"/g, '&quot;');
  return `<div class="tutor-widget" id="${wid}" data-kind="free_response" data-rubric="${rubricJson}">
    ${reviewBadge}
    <div class="tutor-widget-question">${esc(data.question || data.prompt)}</div>
    <textarea class="tutor-widget-textarea" id="${wid}_text" rows="4" placeholder="Write your answer…"></textarea>
    ${rubricBlock}
    <button class="tutor-widget-submit" onclick="handleFreeResponseSubmit('${wid}','${esc(data.memoryId || '')}')">Submit for grading</button>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

function handleFreeResponseSubmit(wid, memoryId) {
  const widget = document.getElementById(wid);
  if (!widget) return;
  const textarea = document.getElementById(wid + '_text');
  if (!textarea || textarea.disabled) return;
  const text = textarea.value.trim();
  if (!text) { textarea.focus(); return; }
  textarea.disabled = true;
  widget.querySelector('.tutor-widget-submit')?.setAttribute('disabled', 'true');
  let rubric = [];
  try { rubric = JSON.parse(widget.dataset.rubric.replace(/&quot;/g, '"')); } catch {}
  submitWidgetAnswer(wid, 'free_response', {
    memoryId,
    data: { text, rubric },
  });
}

// ── Ordering widget (drag to reorder) ────────────────────────────────────────
function buildOrderingWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  const items = Array.isArray(data.items) ? data.items : [];
  const correctOrder = Array.isArray(data.correctOrder) ? data.correctOrder : items.map((_, i) => i);
  // Shuffle indices (deterministic per render)
  const shuffled = items.map((_, i) => i).sort(() => Math.random() - 0.5);
  const dataJson = JSON.stringify({ items, correctOrder }).replace(/"/g, '&quot;');
  const lis = shuffled.map(i => `<li class="tutor-widget-order-item" draggable="true" data-idx="${i}">☰ ${esc(items[i])}</li>`).join('');
  return `<div class="tutor-widget" id="${wid}" data-kind="ordering" data-payload="${dataJson}">
    ${reviewBadge}
    <div class="tutor-widget-question">${esc(data.instruction || data.question || 'Put in correct order:')}</div>
    <ul class="tutor-widget-order-list" id="${wid}_list" ondragover="event.preventDefault()">${lis}</ul>
    <button class="tutor-widget-submit" onclick="handleOrderingSubmit('${wid}','${esc(data.memoryId || '')}')">Submit</button>
    <div class="tutor-widget-explanation" id="${wid}_expl">${esc(data.explanation)}</div>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

// Delegated drag-and-drop attached lazily on first widget render
let _orderingDelegated = false;
function ensureOrderingDnd() {
  if (_orderingDelegated) return;
  _orderingDelegated = true;
  let dragEl = null;
  document.addEventListener('dragstart', e => {
    const li = e.target.closest?.('.tutor-widget-order-item');
    if (!li) return;
    dragEl = li;
    li.classList.add('dragging');
  });
  document.addEventListener('dragend', () => { if (dragEl) dragEl.classList.remove('dragging'); dragEl = null; });
  document.addEventListener('dragover', e => {
    const list = e.target.closest?.('.tutor-widget-order-list');
    if (!list || !dragEl || list !== dragEl.parentElement) return;
    e.preventDefault();
    const after = [...list.querySelectorAll('.tutor-widget-order-item:not(.dragging)')].find(el => {
      const rect = el.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });
    if (after) list.insertBefore(dragEl, after); else list.appendChild(dragEl);
  });
}
// Kick off DnD hookup when module loads
ensureOrderingDnd();

function handleOrderingSubmit(wid, memoryId) {
  const widget = document.getElementById(wid);
  if (!widget || widget.dataset.submitted) return;
  widget.dataset.submitted = '1';
  let payload = { items: [], correctOrder: [] };
  try { payload = JSON.parse(widget.dataset.payload.replace(/&quot;/g, '"')); } catch {}
  const list = document.getElementById(wid + '_list');
  const userOrder = [...list.querySelectorAll('.tutor-widget-order-item')].map(li => Number(li.dataset.idx));
  const isCorrect = userOrder.every((v, i) => v === payload.correctOrder[i]);
  list.querySelectorAll('.tutor-widget-order-item').forEach((li, i) => {
    li.setAttribute('draggable', 'false');
    const expectedIdx = payload.correctOrder[i];
    li.classList.add(Number(li.dataset.idx) === expectedIdx ? 'correct' : 'incorrect');
  });
  widget.querySelector('.tutor-widget-submit')?.setAttribute('disabled', 'true');
  const expl = document.getElementById(wid + '_expl');
  if (expl) expl.classList.add('visible');
  submitWidgetAnswer(wid, 'ordering', {
    memoryId,
    data: { userOrder, correctOrder: payload.correctOrder, result: isCorrect ? 'correct' : 'incorrect' },
  });
}

// ── Matching widget (click-to-pair) ──────────────────────────────────────────
function buildMatchingWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  const left = Array.isArray(data.left) ? data.left : [];
  const right = Array.isArray(data.right) ? data.right : [];
  const pairs = Array.isArray(data.pairs) ? data.pairs : left.map((_, i) => [i, i]);
  // Shuffle right side for the user
  const shuffledRight = right.map((_, i) => i).sort(() => Math.random() - 0.5);
  const payload = JSON.stringify({ pairs, left, right }).replace(/"/g, '&quot;');
  const leftHtml = left.map((t, i) => `<button class="tutor-widget-match-left" data-idx="${i}" onclick="handleMatchingPick('${wid}','left',${i})">${esc(t)}</button>`).join('');
  const rightHtml = shuffledRight.map(i => `<button class="tutor-widget-match-right" data-idx="${i}" onclick="handleMatchingPick('${wid}','right',${i})">${esc(right[i])}</button>`).join('');
  return `<div class="tutor-widget" id="${wid}" data-kind="matching" data-payload="${payload}">
    ${reviewBadge}
    <div class="tutor-widget-question">${esc(data.instruction || 'Match the pairs:')}</div>
    <div class="tutor-widget-matching">
      <div class="tutor-widget-match-col">${leftHtml}</div>
      <div class="tutor-widget-match-col">${rightHtml}</div>
    </div>
    <div class="tutor-widget-explanation" id="${wid}_expl">${esc(data.explanation)}</div>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

// Per-widget pairing state: wid -> { leftSel, rightSel, userPairs: [[l,r]] }
const _matchingState = new Map();

function handleMatchingPick(wid, side, idx) {
  const widget = document.getElementById(wid);
  if (!widget || widget.dataset.submitted) return;
  let st = _matchingState.get(wid);
  if (!st) { st = { leftSel: null, rightSel: null, userPairs: [] }; _matchingState.set(wid, st); }
  const btn = widget.querySelector(`.tutor-widget-match-${side}[data-idx="${idx}"]`);
  if (!btn || btn.disabled) return;
  // Deselect others on same side
  widget.querySelectorAll(`.tutor-widget-match-${side}`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  st[side + 'Sel'] = idx;
  if (st.leftSel != null && st.rightSel != null) {
    const pair = [st.leftSel, st.rightSel];
    st.userPairs.push(pair);
    const leftBtn = widget.querySelector(`.tutor-widget-match-left[data-idx="${st.leftSel}"]`);
    const rightBtn = widget.querySelector(`.tutor-widget-match-right[data-idx="${st.rightSel}"]`);
    [leftBtn, rightBtn].forEach(b => { if (!b) return; b.disabled = true; b.classList.remove('selected'); b.classList.add('paired'); });
    st.leftSel = st.rightSel = null;
    // If all pairs made, auto-submit
    let payload = { pairs: [], left: [], right: [] };
    try { payload = JSON.parse(widget.dataset.payload.replace(/&quot;/g, '"')); } catch {}
    if (st.userPairs.length >= Math.min(payload.left.length, payload.right.length)) {
      finalizeMatching(wid);
    }
  }
}

function finalizeMatching(wid) {
  const widget = document.getElementById(wid);
  if (!widget || widget.dataset.submitted) return;
  widget.dataset.submitted = '1';
  const st = _matchingState.get(wid);
  let payload = { pairs: [] };
  try { payload = JSON.parse(widget.dataset.payload.replace(/&quot;/g, '"')); } catch {}
  const expectedSet = new Set(payload.pairs.map(p => `${p[0]}:${p[1]}`));
  const userPairs = st?.userPairs || [];
  const correctCount = userPairs.filter(p => expectedSet.has(`${p[0]}:${p[1]}`)).length;
  const isCorrect = correctCount === payload.pairs.length;
  // Re-color per correctness
  userPairs.forEach(([l, r]) => {
    const ok = expectedSet.has(`${l}:${r}`);
    const lb = widget.querySelector(`.tutor-widget-match-left[data-idx="${l}"]`);
    const rb = widget.querySelector(`.tutor-widget-match-right[data-idx="${r}"]`);
    [lb, rb].forEach(b => { if (!b) return; b.classList.remove('paired'); b.classList.add(ok ? 'correct' : 'incorrect'); });
  });
  const memoryId = widget.dataset.memoryId || '';
  const expl = document.getElementById(wid + '_expl');
  if (expl) expl.classList.add('visible');
  submitWidgetAnswer(wid, 'matching', {
    memoryId,
    data: { userPairs, correctCount, totalPairs: payload.pairs.length, result: isCorrect ? 'correct' : 'incorrect' },
  });
}

// ── Hotspot widget (click a region on an image) ──────────────────────────────
function buildHotspotWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  const regions = Array.isArray(data.regions) ? data.regions : [];
  const target = data.target || regions[0]?.id;
  const payload = JSON.stringify({ regions, target }).replace(/"/g, '&quot;');
  const regionSvg = regions.map(r =>
    `<circle cx="${r.x}" cy="${r.y}" r="${r.r || 16}" data-id="${esc(r.id)}" class="tutor-widget-hotspot-region" />`
  ).join('');
  const imgUrl = String(data.imageUrl || '').replace(/"/g, '');
  return `<div class="tutor-widget" id="${wid}" data-kind="hotspot" data-payload="${payload}">
    ${reviewBadge}
    <div class="tutor-widget-question">${esc(data.question || 'Click the correct region.')}</div>
    <div class="tutor-widget-hotspot-wrap" onclick="handleHotspotClick(event, '${wid}', '${esc(data.memoryId || '')}')">
      <img src="${imgUrl}" class="tutor-widget-hotspot-img" onload="this.parentElement.querySelector('svg').setAttribute('viewBox','0 0 ' + this.naturalWidth + ' ' + this.naturalHeight)" />
      <svg class="tutor-widget-hotspot-svg" preserveAspectRatio="xMidYMid meet">${regionSvg}</svg>
    </div>
    <div class="tutor-widget-explanation" id="${wid}_expl">${esc(data.explanation)}</div>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

function handleHotspotClick(event, wid, memoryId) {
  const widget = document.getElementById(wid);
  if (!widget || widget.dataset.submitted) return;
  let payload = { regions: [], target: '' };
  try { payload = JSON.parse(widget.dataset.payload.replace(/&quot;/g, '"')); } catch {}
  const img = widget.querySelector('.tutor-widget-hotspot-img');
  if (!img) return;
  const rect = img.getBoundingClientRect();
  // Translate click coords into image coords
  const scaleX = img.naturalWidth / rect.width;
  const scaleY = img.naturalHeight / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const clicked = payload.regions.find(r => {
    const rad = r.r || 16;
    return (x - r.x) ** 2 + (y - r.y) ** 2 <= rad * rad;
  });
  const clickedId = clicked?.id || null;
  const isCorrect = clickedId === payload.target;
  widget.dataset.submitted = '1';
  widget.querySelectorAll('.tutor-widget-hotspot-region').forEach(el => {
    const rid = el.dataset.id;
    if (rid === payload.target) el.classList.add('correct');
    else if (rid === clickedId) el.classList.add('incorrect');
  });
  const expl = document.getElementById(wid + '_expl');
  if (expl) expl.classList.add('visible');
  submitWidgetAnswer(wid, 'hotspot', {
    memoryId,
    data: { clicked: clickedId, target: payload.target, result: isCorrect ? 'correct' : 'incorrect' },
  });
}

// ── Speak widget (browser mic → /api/stt) ────────────────────────────────────
function buildSpeakWidget(data) {
  const wid = newWidgetId();
  const reviewBadge = data.memoryId ? `<div class="tutor-widget-review-badge">Spaced Review</div>` : '';
  const target = esc(data.targetText || data.target || '');
  const lang = esc(data.lang || 'en');
  return `<div class="tutor-widget" id="${wid}" data-kind="speak" data-target="${target}" data-lang="${lang}">
    ${reviewBadge}
    <div class="tutor-widget-question">${esc(data.prompt || data.question || 'Say this phrase:')}</div>
    <div class="tutor-widget-speak-target">${target}</div>
    <div class="tutor-widget-speak-actions">
      <button class="tutor-widget-submit" id="${wid}_rec" onclick="handleSpeakRecord('${wid}','${esc(data.memoryId || '')}')">🎙 Record</button>
      <span class="tutor-widget-speak-status" id="${wid}_status"></span>
    </div>
    <div class="tutor-widget-response" id="${wid}_resp"><div class="tutor-response-inner"></div></div>
  </div>`;
}

let _speakRecorderState = new Map(); // wid -> { recorder, chunks, stream }
async function handleSpeakRecord(wid, memoryId) {
  const widget = document.getElementById(wid);
  if (!widget) return;
  const btn = document.getElementById(wid + '_rec');
  const status = document.getElementById(wid + '_status');
  const existing = _speakRecorderState.get(wid);
  if (existing?.recorder?.state === 'recording') {
    existing.recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    _speakRecorderState.set(wid, { recorder, chunks, stream });
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn.textContent = '⏳ Transcribing…';
      btn.disabled = true;
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'speech.webm');
        form.append('lang', widget.dataset.lang || 'en');
        const token = localStorage.getItem('oe_token');
        const resp = await fetch('/api/stt', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: form,
        });
        if (!resp.ok) {
          const body = await resp.text();
          status.textContent = `STT error: ${resp.status}`;
          btn.disabled = false; btn.textContent = '🎙 Retry';
          console.warn('[speak] STT failed:', body);
          return;
        }
        const { transcript } = await resp.json();
        status.textContent = `Heard: "${transcript}"`;
        const target = widget.dataset.target || '';
        const distance = normalizeForCompare(transcript) === normalizeForCompare(target) ? 0 : 1;
        submitWidgetAnswer(wid, 'speak', {
          memoryId,
          data: { transcript, target, closeEnough: distance === 0 },
        });
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
        btn.disabled = false; btn.textContent = '🎙 Retry';
      }
    };
    recorder.start();
    btn.textContent = '⏹ Stop';
    status.textContent = 'Recording…';
  } catch (e) {
    if (e.name === 'NotAllowedError') status.textContent = 'Microphone permission denied.';
    else status.textContent = `Mic error: ${e.message}`;
  }
}

// ── Celebration widget (inline — no stream) ──────────────────────────────────
function buildCelebrationWidget(data) {
  const wid = newWidgetId();
  const icon = data.icon || '🎉';
  const label = esc(data.label || 'Nice work!');
  const kind = esc(data.kind || 'milestone');
  // Trigger overlay animation once on render
  setTimeout(() => { if (typeof showCelebration === 'function') showCelebration({ kind: data.kind, label: data.label, icon: data.icon }); }, 120);
  return `<div class="tutor-widget tutor-widget-celebration" id="${wid}" data-kind="celebration">
    <div class="tutor-celebration-icon">${icon}</div>
    <div class="tutor-celebration-kind">${kind}</div>
    <div class="tutor-celebration-label">${label}</div>
  </div>`;
}

// Preload voices (some browsers load them async)
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

// Post-process HTML to replace ⟨pronounce:LANG:TEXT⟩ markers with audio buttons
function renderPronounceButtons(html) {
  return html.replace(/⟨pronounce:([^:⟩]+):([^⟩]+)⟩/g, (_, lang, text) => {
    const safeLang = lang.replace(/['"\\]/g, '');
    const safeText = text.replace(/['"\\]/g, '');
    const display = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return `<button class="pronounce-btn" onclick="pronounceWord('${safeText}','${safeLang}')" title="Listen to pronunciation"><span class="pronounce-icon">🔊</span> ${display}</button>`;
  });
}

// ── Tutor nudge toast ────────────────────────────────────────────────────────
function showTutorNudge(msg) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = 587.33;
    gain.gain.setValueAtTime(0.10, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch {}

  const banner = document.createElement('div');
  banner.className = 'tutor-nudge-banner reminder-banner';
  const subjectAttr = (msg.subject || '').replace(/[^a-z0-9_-]/gi, '');
  banner.innerHTML = `
    <div class="reminder-content">
      <span class="reminder-icon">🎓</span>
      <div class="reminder-text">
        <div class="reminder-label">${esc(msg.message || 'Time to study!')}</div>
        <div class="reminder-time">Tutor · ${new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    </div>
    <button class="reminder-dismiss" data-tutor-start="${subjectAttr}">Start</button>
    <button class="reminder-dismiss" onclick="this.parentElement.remove()">Later</button>
  `;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('visible'));
  const startBtn = banner.querySelector('[data-tutor-start]');
  if (startBtn) startBtn.addEventListener('click', () => {
    banner.remove();
    const text = msg.subject ? `Let's review ${msg.subject}` : "Let's start a tutor session";
    try {
      if (typeof ws !== 'undefined' && ws?.readyState === 1 && typeof activeAgent !== 'undefined') {
        ws.send(JSON.stringify({ type: 'chat', agent: activeAgent, text }));
        if (typeof setStreaming === 'function') setStreaming(true);
        if (typeof setTyping === 'function') setTyping(true);
      }
    } catch (e) { console.warn('[tutor-nudge] start failed:', e.message); }
  });
  setTimeout(() => banner.remove(), 30_000);
}

// ── Celebration overlay (rate-limited) ───────────────────────────────────────
let _lastCelebrationAt = 0;
function showCelebration(msg) {
  const now = Date.now();
  if (now - _lastCelebrationAt < 5 * 60_000) return;
  _lastCelebrationAt = now;
  const { kind = 'achievement', label = 'Nice work!', icon = '🎉' } = msg || {};
  const overlay = document.createElement('div');
  overlay.className = 'tutor-celebration';
  overlay.innerHTML = `
    <div class="tutor-celebration-card">
      <div class="tutor-celebration-icon">${icon}</div>
      <div class="tutor-celebration-kind">${String(kind).replace(/_/g, ' ')}</div>
      <div class="tutor-celebration-label">${esc(label)}</div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));
  setTimeout(() => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 400); }, 3_000);
}

// Capture user timezone once per session so streak math uses the right day boundary.
(function captureTz() {
  if (sessionStorage.getItem('oe_tutor_tz_sent')) return;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;
    const token = localStorage.getItem('oe_token');
    if (!token) { setTimeout(captureTz, 5_000); return; }
    fetch('/api/tutor/tz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tz }),
    }).then(r => { if (r.ok) sessionStorage.setItem('oe_tutor_tz_sent', '1'); }).catch(() => {});
  } catch {}
})();
