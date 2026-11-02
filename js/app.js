(() => {
  const $ = s => document.querySelector(s);
  const STREETS = ['flop', 'turn', 'river'];
  const { fmt, pct } = Engine;
  // Label tables that follow the current language.
  const L10 = (zh, en) => new Proxy({}, { get: (_, k) => (I18N.lang === 'en' ? en : zh)[k] });
  const STR = L10({ pre: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' }, { pre: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' });
  const ACT = L10({ fold: '弃牌', call: '跟注', raise: '加注' }, { fold: 'fold', call: 'call', raise: 'raise' });
  const SIT = L10({ first: '先行动/被过牌', facing: '面对下注', raise: '面对加注', pre: '翻前' }, { first: 'First to act / checked to', facing: 'Facing a bet', raise: 'Facing a raise', pre: 'Preflop' });
  const POTS = L10({ srp: '单次加注底池', '3bet': '3-bet 底池', '4bet': '4-bet 底池', multi: '多人底池', pre: '翻前' }, { srp: 'Single-raised pot', '3bet': '3-bet pot', '4bet': '4-bet pot', multi: 'Multiway pot', pre: 'Preflop' });
  const sgn = x => (x >= 0 ? '+' : '') + x.toFixed(2);
  const RESTART = { restart: true }, SPOT_DONE = { spotDone: true };

  let mode = 'full';
  let pending = null;
  let handDecisions = [];
  let curH = null;
  let curHH = [];

  // ---------- persistence ----------
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full: keep running */ } };
  function blank() { return { hands: 0, decisions: 0, best: 0, good: 0, inacc: 0, blunder: 0, evLoss: 0, postN: 0, net: 0, by: {} }; }

  // Saved-data schema version. Bump it when stored shapes change and add a migration step below.
  const DATA_VERSION = 2;
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const RATINGS = ['best', 'good', 'inacc', 'blunder'];
  const validRec = r => isObj(r) && isObj(r.cfg) && Array.isArray(r.hero) && Array.isArray(r.board) && Array.isArray(r.options)
    && r.options.length > 0 && r.options.some(o => o.id === r.chosen) && r.options.some(o => o.id === r.best) && RATINGS.includes(r.rating);
  function loadStats() {
    const s = { ...blank(), ...(isObj(load('gto-trainer-stats', {})) ? load('gto-trainer-stats', {}) : {}) };
    for (const k of Object.keys(blank())) if (k !== 'by' && !Number.isFinite(s[k])) s[k] = 0;
    if (!isObj(s.by)) s.by = {};
    return s;
  }
  (function migrateData() {
    const v = load('gto-trainer-version', 1);
    if (v > DATA_VERSION) return; // data written by a newer build: leave it untouched
    // v1 -> v2: records gained schema guarantees; drop anything an old build left half-written.
    const rv = load('gto-trainer-review', []);
    save('gto-trainer-review', Array.isArray(rv) ? rv.filter(validRec) : []);
    const hh = load('gto-trainer-hh', []);
    save('gto-trainer-hh', Array.isArray(hh) ? hh.filter(x => isObj(x) && Array.isArray(x.lines)) : []);
    const rc = load('gto-trainer-recent', []);
    save('gto-trainer-recent', Array.isArray(rc) ? rc.filter(r => RATINGS.includes(r)) : []);
    save('gto-trainer-version', DATA_VERSION);
  })();
  let stats = loadStats();
  let reviews = load('gto-trainer-review', []).filter(validRec);
  let histories = load('gto-trainer-hh', []);
  const saveStats = () => { save('gto-trainer-stats', stats); renderStats(); };

  function renderStats() {
    const acc = stats.decisions ? Math.round(100 * (stats.best + stats.good) / stats.decisions) : 0;
    const avgLoss = stats.postN ? stats.evLoss / stats.postN : 0;
    $('#stats').innerHTML =
      `<span>${tr('手数', 'Hands')} <b>${stats.hands}</b></span><span>${tr('决策', 'Decisions')} <b>${stats.decisions}</b></span>` +
      `<span>${tr('准确率', 'Accuracy')} <b>${acc}%</b></span><span>${tr('平均 EV 损失', 'Avg EV loss')} <b>${avgLoss.toFixed(2)}bb</b></span>` +
      `<span>${tr('净盈亏', 'Net')} <b>${sgn(stats.net)}bb</b></span>`;
  }

  // Every graded decision updates totals, per-category stats, and the review log.
  function recordDecision(rec) {
    lastRating = rec.rating;
    pushRecent(rec.rating);
    stats.decisions++;
    stats[rec.rating]++;
    if (rec.loss !== null) { stats.postN++; stats.evLoss += rec.loss; }
    const ok = rec.rating === 'best' || rec.rating === 'good';
    const dims = { street: rec.st, pos: rec.heroPos, sit: rec.sit, cls: rec.cls || '-', pot: rec.potType || '-', game: rec.cfg.game };
    for (const [dim, val] of Object.entries(dims)) {
      const b = (stats.by[dim] = stats.by[dim] || {});
      const e = (b[val] = b[val] || { n: 0, ok: 0, loss: 0, nEv: 0 });
      e.n++; if (ok) e.ok++;
      if (rec.loss !== null) { e.loss += rec.loss; e.nEv++; }
    }
    saveStats();
    if (!rec.replay) {
      reviews.unshift(rec);
      if (reviews.length > 300) reviews.length = 300;
      save('gto-trainer-review', reviews);
    }
  }

  // ---------- rendering ----------
  const cardHTML = (c, cls = '') => `<div class="card s-${SUITS[c & 3]} ${cls}"><span class="r">${RANKS[c >> 2] === 'T' ? '10' : RANKS[c >> 2]}</span><span class="s">${SUIT_SYM[SUITS[c & 3]]}</span></div>`;
  const BACK = '<div class="card back"></div>';
  const miniCards = cs => cs.map(c => `<span class="mini s-${SUITS[c & 3]}">${RANKS[c >> 2] === 'T' ? '10' : RANKS[c >> 2]}${SUIT_SYM[SUITS[c & 3]]}</span>`).join('');
  const cstr = cs => cs.map(c => RANKS[c >> 2] + SUIT_SYM[SUITS[c & 3]]).join(' ');

  function oppList(h) {
    if (h.opps) return h.opps.filter(o => o.live);
    if (h.villainPos && h.villainPos !== '—') return [{ pos: h.villainPos, vil: h.vil, bet: h.vilBet }];
    return [];
  }

  function renderTable(h, reveal = false, newCards = 0) {
    const opps = oppList(h);
    const o1 = opps[0], o2 = opps[1];
    $('#villain-pos').textContent = o1 ? `${o1.pos} ${posName(o1.pos)}` : '';
    $('#hero-pos').textContent = `${h.heroPos} ${posName(h.heroPos)}`;
    renderSeats(h);
    const back = o => (reveal && o && o.vil ? o.vil.map(c => cardHTML(c)).join('') : o ? BACK + BACK : '');
    $('#villain-cards').innerHTML = back(o1);
    $('#villain2-row').hidden = !o2;
    if (o2) {
      $('#villain2-pos').textContent = `${o2.pos} ${posName(o2.pos)}`;
      $('#villain2-cards').innerHTML = back(o2);
      $('#villain2-stack').textContent = h.stack !== undefined ? `${fmt(h.stack - (o2.bet || 0))} bb` : '';
      $('#villain2-bet').textContent = o2.bet ? `${tr('下注', 'Bet')} ${fmt(o2.bet)}` : '';
    }
    $('#hero-cards').innerHTML = h.hero.map(c => cardHTML(c)).join('');
    let b = '';
    for (let i = 0; i < 5; i++) b += h.board[i] !== undefined ? cardHTML(h.board[i], i >= h.board.length - newCards ? 'new' : '') : '<div class="card slot"></div>';
    $('#board').innerHTML = b;
    const vb = h.opps ? opps.reduce((s, o) => s + (o.bet || 0), 0) : h.vilBet || 0;
    $('#pot').textContent = `${fmt((h.pot || 0) + (h.heroBet || 0) + vb)} bb`;
    $('#hero-stack').textContent = h.stack !== undefined ? `${fmt(h.stack - (h.heroBet || 0))} bb` : '';
    const v1bet = h.opps ? (o1 && o1.bet) || 0 : h.vilBet;
    $('#villain-stack').textContent = h.stack !== undefined && o1 ? `${fmt(h.stack - (v1bet || 0))} bb` : '';
    $('#hero-bet').textContent = h.heroBet ? `${tr('下注', 'Bet')} ${fmt(h.heroBet)}` : '';
    $('#villain-bet').textContent = v1bet ? `${h.noOpp ? tr('盲注', 'Blind') : tr('下注', 'Bet')} ${fmt(v1bet)}` : '';
    $('#villain-label').textContent = h.noOpp ? tr('未行动', 'To act') : tr('对手', 'Villain');
  }

  function setSituation(text, h) {
    let info = '';
    if (h && h.board && h.board.length >= 3) {
      const cls = Classify.handClass(h.hero, h.board);
      const hn = handName(evalHand([...h.hero, ...h.board]));
      info = `<div class="handinfo">${tr(`你的牌型：${hn}（${Classify.NAMES[cls]}）`, `Your hand: ${hn} (${Classify.NAMES[cls]})`)}</div>`;
    }
    $('#situation').innerHTML = text + info;
  }
  function clearLog() { $('#log').innerHTML = ''; }
  function log(text, cls = '') {
    if (!text) return;
    curHH.push(text);
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    $('#log').appendChild(d);
    $('#log').scrollTop = 1e9;
  }

  function gridHTML(fn) {
    let html = '<div class="grid">';
    for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
      const ri = 12 - i, rj = 12 - j;
      const l = i === j ? RANKS[ri] + RANKS[ri] : i < j ? RANKS[ri] + RANKS[rj] + 's' : RANKS[rj] + RANKS[ri] + 'o';
      const { bg, cls = '' } = fn(l);
      html += `<div class="cell ${cls}" style="background:${bg}">${l}</div>`;
    }
    return html + '</div>';
  }
  function chartGrid(chart, heroLabel) {
    return gridHTML(l => {
      const f = chartFreqs(chart, l);
      const r = f.raise * 100, c = r + f.call * 100;
      return { bg: `linear-gradient(to right, var(--raise) 0 ${r}%, var(--call) ${r}% ${c}%, var(--fold) ${c}% 100%)`, cls: l === heroLabel ? 'me' : '' };
    }) + `<div class="legend"><span><i style="background:var(--raise)"></i>${tr('加注', 'Raise')}</span><span><i style="background:var(--call)"></i>${tr('跟注', 'Call')}</span><span><i style="background:var(--fold)"></i>${tr('弃牌', 'Fold')}</span></div>`;
  }
  function rangeGrid(range, title = tr('对手当前范围', "Villain's current range")) {
    const agg = {};
    for (const c of range) { const l = labelOf(c.a, c.b); agg[l] = (agg[l] || 0) + c.w; }
    return gridHTML(l => {
      const x = (agg[l] || 0) / combosOf(l).length;
      return { bg: x > 0.001 ? `rgba(170,120,230,${0.15 + 0.75 * Math.min(1, x)})` : 'var(--fold)' };
    }) + `<div class="legend">${title} · ${tr('加权组合数', 'weighted combos')} ${Engine.W(range).toFixed(1)} · ${tr('颜色越深组合越多', 'darker = more combos')}</div>`;
  }

  // ---------- input ----------
  function ask(options) {
    const el = $('#actions');
    el.innerHTML = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.className = o.cls || (o.id === 'fold' ? 'fold' : o.id === 'call' || o.id === 'check' ? 'call' : ['cont', 'next', 'switch', 'back'].includes(o.id) ? 'primary' : 'raise');
      b.innerHTML = `${o.label}${o.key ? `<kbd>${o.key === 'Enter' ? '↵' : o.key.toUpperCase()}</kbd>` : ''}`;
      b.onclick = () => choose(o.id);
      el.appendChild(b);
    }
    return new Promise(res => { pending = { res, options }; });
  }
  function choose(id) {
    if (!pending) return;
    const p = pending;
    pending = null;
    $('#actions').innerHTML = '';
    p.res(id);
  }
  const waitContinue = (label = tr('继续', 'Continue')) => ask([{ id: 'cont', label, key: 'Enter' }]);
  // A hand that was replaced by newHand() must never resume: its timers simply don't resolve.
  let gen = 0;
  const tick = ms => { const g = gen; return new Promise(r => setTimeout(() => { if (g === gen) r(); }, ms)); };
  // Heavy maths runs in a Web Worker (see compute.js); results for a replaced hand are dropped.
  const comp = (fn, ...args) => { const g = gen; return Compute.call(fn, ...args).then(r => new Promise(res => { if (g === gen) res(r); })); };
  async function annotateRange(range, h) {
    const res = await comp('annotate', range, h.hero, h.board, h.heroRange);
    range.forEach((c, i) => { [c.eq, c.score, c.made, c.madePct, c.scorePct, c.pot] = res[i]; });
  }

  // ---------- preferences, toasts, overlays ----------
  const prefs = { theme: 'dark', autoNext: false, reveal: true, stealth: false, ...load('gto-trainer-prefs', {}) };
  const SPIN = '<span class="spin"></span>';
  let lastRating = null;
  // Cache-busting stamp (?v=...) added by the build to our own script URL; reused for icons and the worker.
  const ASSET_VER = (() => { try { return new URL(document.currentScript.src).search; } catch { return ''; } })();
  function tabLabel(b) {
    return prefs.stealth ? b.dataset.file : b.querySelector('.muted').textContent;
  }
  function applyPrefs() {
    document.body.classList.toggle('light', prefs.theme === 'light');
    document.body.classList.toggle('stealth', !!prefs.stealth);
    $('#favicon').href = (prefs.stealth ? 'favicon-stealth.svg' : 'favicon.svg') + ASSET_VER;
    document.title = prefs.stealth ? 'core-service – OrderService.java' : tr('GTO 训练器', 'GTO Trainer');
    if (!prefs.stealth) $('#cover').hidden = true;
    const active = document.querySelector('#modes button.active');
    if (active) $('#tab-name').textContent = tabLabel(active);
    $('#pref-theme').value = prefs.theme;
    $('#pref-autonext').checked = prefs.autoNext;
    $('#pref-reveal').checked = prefs.reveal;
    $('#pref-stealth').checked = !!prefs.stealth;
  }
  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1700);
  }
  // Skips the "continue" click after a best-rated decision when the user opted in.
  async function maybeContinue(rating, label = tr('继续', 'Continue')) {
    if (prefs.autoNext && rating === 'best') {
      toast(tr('最佳 · 自动继续', 'Best · auto-continuing'));
      await tick(650);
      return;
    }
    await waitContinue(label);
  }
  const contAfter = () => maybeContinue(lastRating);
  function setFeedback(html) {
    const el = $('#feedback');
    el.innerHTML = html;
    el.classList.remove('fresh');
    void el.offsetWidth;
    el.classList.add('fresh');
    $('.inspector').scrollTop = 0;
  }
  const overlayOpen = () => !$('#help').hidden || !$('#settings-pop').hidden;
  function closeOverlays() {
    $('#help').hidden = true;
    $('#settings-pop').hidden = true;
    $('#settings-btn').classList.remove('on');
  }
  $('#settings-btn').onclick = e => {
    e.stopPropagation();
    const open = $('#settings-pop').hidden;
    closeOverlays();
    $('#settings-pop').hidden = !open;
    $('#settings-btn').classList.toggle('on', open);
  };
  $('#settings-pop').onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { if (!$('#settings-pop').hidden) closeOverlays(); });
  $('#help-btn').onclick = () => { closeOverlays(); $('#help').hidden = false; };
  $('#help-close').onclick = closeOverlays;
  $('#help').onclick = e => { if (e.target.id === 'help') closeOverlays(); };
  $('#pref-theme').onchange = e => { prefs.theme = e.target.value; save('gto-trainer-prefs', prefs); applyPrefs(); };
  $('#pref-autonext').onchange = e => { prefs.autoNext = e.target.checked; save('gto-trainer-prefs', prefs); };
  $('#pref-reveal').onchange = e => { prefs.reveal = e.target.checked; save('gto-trainer-prefs', prefs); };
  $('#pref-stealth').onchange = e => { prefs.stealth = e.target.checked; save('gto-trainer-prefs', prefs); applyPrefs(); };

  // Recent-decision strip in the status bar (shape + colour, so it never relies on colour alone).
  const recent = load('gto-trainer-recent', []);
  const SYM = { best: '●', good: '◐', inacc: '▲', blunder: '✕' };
  const RT = L10({ best: '最佳', good: '良好', inacc: '不精确', blunder: '严重失误' }, { best: 'Best', good: 'Good', inacc: 'Inaccuracy', blunder: 'Blunder' });
  const renderRecent = () => { $('#recent').innerHTML = recent.map(r => `<span class="${r}" title="${RT[r]}">${SYM[r]}</span>`).join(''); };
  renderRecent();
  function pushRecent(rating) {
    recent.push(rating);
    if (recent.length > 16) recent.shift();
    save('gto-trainer-recent', recent);
    renderRecent();
    let streak = 0;
    for (let i = recent.length - 1; i >= 0 && (recent[i] === 'best' || recent[i] === 'good'); i--) streak++;
    if (streak > 0 && streak % 5 === 0) toast(tr(`连续 ${streak} 次正确`, `${streak} correct in a row`));
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (overlayOpen()) return closeOverlays();
      // The fake-code "boss key" only exists in stealth mode.
      if (prefs.stealth) $('#cover').hidden = !$('#cover').hidden;
      return;
    }
    if (!$('#cover').hidden) return;
    if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === '?') { closeOverlays(); $('#help').hidden = false; return; }
    if (overlayOpen()) return;
    if (e.key === 'h' || e.key === 'H') { $('#hints').checked = !$('#hints').checked; if (curH) renderHints(curH); return; }
    if (!$('#cover').hidden) return;
    if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
    if ((e.key === 'n' || e.key === 'N') && !['review', 'stats'].includes(mode)) return newHand();
    if (!pending) return;
    const k = e.key === 'Enter' || e.key === ' ' ? 'Enter' : e.key.toLowerCase();
    const o = pending.options.find(x => (x.key || '').toLowerCase() === k.toLowerCase());
    if (o) { e.preventDefault(); choose(o.id); }
  });

  // ---------- settings ----------
  const DEFAULT_CFG = { game: 'cash', players: 6, stack: 100, stage: 'normal' };
  let cfg = { ...DEFAULT_CFG, ...load('gto-trainer-cfg', {}) };
  const DEFAULT_FILTER = { street: 'any', sit: 'any', cls: 'any', pot: 'any' };
  let filter = { ...DEFAULT_FILTER, ...load('gto-trainer-filter', {}) };
  let C = null;
  const RAND_STACKS = [10, 15, 20, 25, 30, 40, 60];
  function handCfg() {
    if (cfg.game === 'cash') return { game: 'cash', players: cfg.players, stack: 100, stage: 'normal' };
    return { ...cfg, stack: cfg.stack || RAND_STACKS[Math.floor(Math.random() * RAND_STACKS.length)] };
  }
  const STAGE = L10({ normal: '常规', bubble: '泡沫期', ft: '决赛桌' }, { normal: 'normal stage', bubble: 'bubble', ft: 'final table' });
  function modeDesc(c = C) {
    if (c.game === 'cash') return tr(`现金局 · ${c.players}人 · 100bb`, `Cash · ${c.players}-handed · 100bb`);
    const m = tr({ push: '推/弃阶段', jam: '短码（3-bet 即全下）', deep: '深码' }, { push: 'push/fold', jam: 'short stack (3-bet = jam)', deep: 'deep' })[Modes.stackMode(c)];
    const bf = Modes.icmL(c);
    return tr(`MTT · ${c.players}人 · ${c.stack}bb · 有前注 · ${STAGE[c.stage]}${bf > 1 ? `（ICM 泡沫因子 ${bf.toFixed(2)}）` : ''} · ${m}`,
      `MTT · ${c.players}-handed · ${c.stack}bb · ante · ${STAGE[c.stage]}${bf > 1 ? ` (ICM bubble factor ${bf.toFixed(2)})` : ''} · ${m}`);
  }
  const filterActive = () => mode === 'postflop' && Object.values(filter).some(v => v !== 'any');

  // ---------- helpers ----------
  const rnd = n => Math.floor(Math.random() * n);
  const pick = arr => arr[rnd(arr.length)];
  const P = () => Modes.positions(C);
  const blind = pos => Modes.blindOf(C, pos);
  const deadOther = (...ps) => Modes.deadTotal(C) - ps.reduce((s, p) => s + blind(p), 0);
  const openers = () => P().filter(p => p !== 'BB');
  const vScore = c => Modes.valueScore(labelOf(c.a, c.b));
  function pickPair() {
    const ps = P();
    const i = rnd(ps.length - 1);
    return [ps[i], ps[i + 1 + rnd(ps.length - 1 - i)]];
  }

  function dealCards(h, n) {
    const dead = new Set([...h.hero, ...h.board, ...oppList(h).flatMap(o => o.vil || []), ...(h.vil || [])]);
    const deck = [];
    for (let c = 0; c < 52; c++) if (!dead.has(c)) deck.push(c);
    for (let i = 0; i < n; i++) h.board.push(deck.splice(rnd(deck.length), 1)[0]);
  }
  function randomHand(dead) {
    let a, b;
    do { a = rnd(52); } while (dead.has(a));
    do { b = rnd(52); } while (b === a || dead.has(b));
    return [a, b];
  }

  function neighbors(l) {
    const r1 = RANKS.indexOf(l[0]), r2 = RANKS.indexOf(l[1]), out = [];
    if (r1 === r2) { if (r1 < 12) out.push(RANKS[r1 + 1].repeat(2)); if (r1 > 0) out.push(RANKS[r1 - 1].repeat(2)); return out; }
    const suf = l[2];
    if (r2 + 1 < r1) out.push(l[0] + RANKS[r2 + 1] + suf);
    if (r2 > 0) out.push(l[0] + RANKS[r2 - 1] + suf);
    if (r1 < 12) out.push(RANKS[r1 + 1] + l[1] + suf);
    if (r1 - 1 > r2) out.push(RANKS[r1 - 1] + l[1] + suf);
    out.push(l.slice(0, 2) + (suf === 's' ? 'o' : 's'));
    return out;
  }
  // Biases drills toward hands near the edge of the range, where decisions are actually hard.
  function sampleHeroHand(chart, dead = new Set()) {
    for (let t = 0; t < 400; t++) {
      const [a, b] = randomHand(dead);
      const l = labelOf(a, b);
      if (Math.random() < 0.25) return [a, b];
      const f = chartFreqs(chart, l);
      if (f.fold > 0 && f.fold < 1) return [a, b];
      const nb = neighbors(l).map(x => chartFreqs(chart, x).fold);
      if (f.fold === 1 && nb.some(x => x < 1)) return [a, b];
      if (f.fold === 0 && nb.some(x => x > 0)) return [a, b];
    }
    return randomHand(dead);
  }
  const rangeFrom = (chart, action, dead = new Set()) => Engine.buildRange(l => chartFreqs(chart, l)[action], dead);
  const without = (range, cards) => range.filter(c => !cards.includes(c.a) && !cards.includes(c.b));
  const mapOf = range => { const m = {}; for (const c of range) { const l = labelOf(c.a, c.b); m[l] = Math.min(1, (m[l] || 0) + c.w / combosOf(l).length); } return m; };

  // ---------- seat diagram ----------
  const POS_INFO = L10({
    UTG: ['枪口位', '翻牌前第一个行动，身后人最多，所以范围最紧。'],
    'UTG+1': ['枪口+1', '前位，紧跟枪口位，范围依然很紧。'],
    MP: ['中位', '中间位置，范围适中。'],
    LJ: ['低劫位', 'Lojack，劫位前一位，中位偏后。'],
    HJ: ['劫位', 'Hijack，关煞位前一位，可以开始放宽。'],
    CO: ['关煞位', 'Cutoff，庄位前一位，开池范围很宽。'],
    BTN: ['庄位', '按钮位（D），翻牌后永远最后行动，位置最好，开池最宽。'],
    SB: ['小盲', '强制下注 0.5bb；翻牌后最先行动，位置最差。'],
    BB: ['大盲', '强制下注 1bb；翻牌前最后行动，已投入 1bb 所以防守很宽。'],
  }, {
    UTG: ['Under gun', 'Under the gun: first to act preflop with the most players behind, so the tightest range.'],
    'UTG+1': ['UTG+1', 'Early position right after UTG; still a tight range.'],
    MP: ['Middle position', 'Middle seat; a moderate range.'],
    LJ: ['Lojack', 'One seat before the hijack; middle-late position.'],
    HJ: ['Hijack', 'One seat before the cutoff; ranges start to widen.'],
    CO: ['Cutoff', 'One seat before the button; opens very wide.'],
    BTN: ['Button', 'Dealer button (D): always acts last after the flop, best seat, widest opens.'],
    SB: ['Small blind', 'Posts 0.5bb; acts first after the flop, worst position.'],
    BB: ['Big blind', 'Posts 1bb; acts last preflop and already has 1bb in, so defends wide.'],
  });
  const posName = pos => (C && Modes.isHU(C) && pos === 'BTN' ? tr('庄位/小盲', 'Button/SB') : (POS_INFO[pos] || [''])[0]);
  const pn = pos => tr(`${pos}（${posName(pos)}）`, `${pos} (${posName(pos)})`);

  function renderSeats(h) {
    const el = $('#seats');
    if (!el || !C) return;
    const ps = P(), n = ps.length;
    const heroIdx = Math.max(0, ps.indexOf(h.heroPos));
    const postflop = h.board.length > 0;
    const opp = new Set(h.noOpp ? [] : oppList(h).map(o => o.pos));
    let html = '<div class="felt"></div>';
    ps.forEach((pos, i) => {
      const ang = (90 + (i - heroIdx) * 360 / n) * Math.PI / 180;
      const x = 50 + 42 * Math.cos(ang), y = 50 + 36 * Math.sin(ang);
      let cls = 'seat', tag = `#${i + 1}`;
      if (pos === h.heroPos) { cls += ' me'; tag = tr('你', 'You'); }
      else if (opp.has(pos)) { cls += ' opp'; tag = tr('对手', 'Villain'); }
      else if (postflop || i < heroIdx) cls += ' out';
      const info = POS_INFO[pos] ? POS_INFO[pos][1] : '';
      const bl = blind(pos);
      html += `<div class="${cls}" style="left:${x}%;top:${y}%" title="${pos} ${posName(pos)}: ${info}">
        <b>${pos}</b><span>${posName(pos)}</span><i>${tag}</i>${pos === 'BTN' ? '<em class="dbtn">D</em>' : ''}${bl ? `<em class="blind">${bl}</em>` : ''}</div>`;
    });
    const postOrder = ps.slice().sort((a, b) => (Modes.heroIP(C, a, b) ? 1 : -1)).join(' → ');
    el.innerHTML = html;
    $('#seat-legend').innerHTML = tr(`<b>翻前</b>行动顺序：${ps.join(' → ')}　·　<b>翻后</b>：${postOrder}（越靠后行动越有利）　·　鼠标悬停座位查看说明`,
      `<b>Preflop</b> order: ${ps.join(' → ')}　·　<b>Postflop</b>: ${postOrder} (acting later is better)　·　hover a seat for details`);
  }

  // ---------- preflop spots ----------
  function baseSpot(hero, villain, heroBet, vilBet) {
    return { hero, villain, heroBet, vilBet, pot: deadOther(hero, villain), stack: C.stack };
  }
  function rfiSpot(pos) {
    const push = Modes.stackMode(C) === 'push';
    const size = Modes.openSize(C, pos);
    const sp = baseSpot(pos, 'BB', blind(pos), 1);
    return Object.assign(sp, {
      kind: push ? 'push' : 'rfi', ref: { t: 'rfi', a: [pos] }, chart: Modes.rfiChart(C, pos), size,
      desc: tr(`前面玩家全部弃牌，你在 <b>${pn(pos)}</b>（身后还有 ${Modes.behind(C, pos)} 人）。${push ? '全下还是弃牌？' : '开池加注还是弃牌？'}`,
        `Folds to you in <b>${pn(pos)}</b> (${Modes.behind(C, pos)} players behind). ${push ? 'Shove or fold?' : 'Open or fold?'}`),
      logText: tr(`弃牌到你（${pos}）。`, `Folds to Hero (${pos}).`),
      options: [{ id: 'fold', label: tr('弃牌', 'Fold'), key: 'f' }, { id: 'raise', label: push ? tr(`全下 ${C.stack}bb`, `All-in ${C.stack}bb`) : tr(`加注 ${size}bb`, `Raise ${size}bb`), key: 'r' }],
      evFn: push ? async hand => {
        const r = await comp('shoveEV', C, pos, hand);
        const top = r.parts.slice().sort((a, b) => b.p - a.p).slice(0, 3).map(p => tr(`${p.pos} 跟注 ${pct(p.p)}（你胜率 ${pct(p.eq)}）`, `${p.pos} calls ${pct(p.p)} (your equity ${pct(p.eq)})`)).join(tr('；', '; '));
        return {
          fold: { ev: 0, detail: tr('放弃，已投入的盲注不再收回（基准 0）。', 'Fold; any blind already posted is lost (baseline 0).') },
          raise: { ev: r.ev, detail: tr(`所有人弃牌 ${pct(r.pFoldAll)}，直接赢 ${fmt(Modes.deadTotal(C))}bb；${top}。`, `Everyone folds ${pct(r.pFoldAll)} and you win ${fmt(Modes.deadTotal(C))}bb; ${top}.`) },
        };
      } : null,
    });
  }
  function vsOpenSpot(hero, opener) {
    const jam = Modes.stackMode(C) === 'jam';
    const chart = Modes.vsOpenChart(C, hero, opener);
    const size = Modes.openSize(C, opener);
    const options = [{ id: 'fold', label: tr('弃牌', 'Fold'), key: 'f' }];
    if (!chart.noCall) options.push({ id: 'call', label: tr(`跟注 ${size}bb`, `Call ${size}bb`), key: 'c' });
    options.push({ id: 'raise', label: jam ? tr(`全下 ${C.stack}bb`, `All-in ${C.stack}bb`) : tr(`3-bet 到 ${chart.threebet}bb`, `3-bet to ${chart.threebet}bb`), key: 'r' });
    return Object.assign(baseSpot(hero, opener, blind(hero), size), {
      kind: 'vsOpen', ref: { t: 'vsOpen', a: [hero, opener] }, chart, size, options,
      desc: tr(`<b>${pn(opener)}</b> 开池加注到 ${size}bb，你在 <b>${pn(hero)}</b>。`, `<b>${pn(opener)}</b> opens to ${size}bb. You're in <b>${pn(hero)}</b>.`),
      logText: tr(`${opener} 加注到 ${size}bb，轮到你（${hero}）。`, `${opener} raises to ${size}bb; action on Hero (${hero}).`),
    });
  }
  function vs3betSpot(hero, tb) {
    const c = Modes.vs3betChart(C, hero, tb);
    const open = Modes.openSize(C, hero);
    const tbSize = c.threebet || Modes.vsOpenChart(C, tb, hero).threebet;
    const fourbet = c.fourbet || Math.min(C.stack, Math.round(tbSize * 2.3));
    return Object.assign(baseSpot(hero, tb, open, tbSize), {
      kind: 'vs3bet', ref: { t: 'vs3bet', a: [hero, tb] }, chart: c, tbSize, fourbet,
      desc: tr(`你在 <b>${pn(hero)}</b> 开池到 ${open}bb，<b>${pn(tb)}</b> 3-bet 到 ${tbSize}bb。`, `You open <b>${pn(hero)}</b> to ${open}bb and <b>${pn(tb)}</b> 3-bets to ${tbSize}bb.`),
      logText: tr(`你（${hero}）加注到 ${open}bb，${tb} 3-bet 到 ${tbSize}bb。`, `Hero (${hero}) raises to ${open}bb, ${tb} 3-bets to ${tbSize}bb.`),
      options: [{ id: 'fold', label: tr('弃牌', 'Fold'), key: 'f' }, { id: 'call', label: tr(`跟注 ${tbSize}bb`, `Call ${tbSize}bb`), key: 'c' },
        { id: 'raise', label: fourbet >= C.stack ? tr(`全下 ${C.stack}bb`, `All-in ${C.stack}bb`) : tr(`4-bet 到 ${fourbet}bb`, `4-bet to ${fourbet}bb`), key: 'r' }],
    });
  }
  // Facing an all-in: graded purely by EV (equity vs the shove range, pot odds, ICM).
  async function vsShoveSpot(hero, pusher, heroIn, pushMap, key, desc, logText, ref) {
    const S = C.stack, dOther = deadOther(hero, pusher), L = Modes.icmL(C);
    const chart = await comp('callVsShoveChart', C, key, pushMap, heroIn, dOther);
    const Wn = 2 * S + dOther - S + heroIn, c = S - heroIn;
    const need = (c * L) / (Wn + c * L);
    return Object.assign(baseSpot(hero, pusher, heroIn, S), {
      kind: 'vsShove', ref, chart, pushMap, desc, logText,
      options: [{ id: 'fold', label: tr('弃牌', 'Fold'), key: 'f' }, { id: 'call', label: tr(`跟注全下 ${fmt(c)}bb`, `Call all-in ${fmt(c)}bb`), key: 'c' }],
      evFn: async hand => {
        const eq = await comp('eqVsRange', hand, Modes.rangeOf(pushMap, new Set(hand)), 5000);
        return {
          fold: { ev: 0, detail: tr('放弃已投入的筹码（基准 0）。', 'Give up the chips already in (baseline 0).') },
          call: { ev: Modes.allinEV(eq, S, heroIn, dOther, L),
            detail: tr(`你对抗对手全下范围的胜率 ${pct(eq)}；底池赔率${L > 1 ? '加 ICM 风险溢价' : ''}要求 ${pct(need)}。`,
              `Your equity vs the shoving range ${pct(eq)}; pot odds${L > 1 ? ' plus the ICM risk premium' : ''} need ${pct(need)}.`) },
        };
      },
    });
  }
  function vsPushSpot(hero, pusher) {
    return vsShoveSpot(hero, pusher, blind(hero), Modes.rfiChart(C, pusher)._r, 'push-' + pusher,
      tr(`<b>${pn(pusher)}</b> 全下 ${C.stack}bb，你在 <b>${pn(hero)}</b>。跟注还是弃牌？`, `<b>${pn(pusher)}</b> shoves ${C.stack}bb. You're in <b>${pn(hero)}</b>. Call or fold?`),
      tr(`${pusher} 全下 ${C.stack}bb，轮到你（${hero}）。`, `${pusher} shoves ${C.stack}bb; action on Hero (${hero}).`),
      { t: 'vsPush', a: [hero, pusher] });
  }
  function vsJamSpot(hero, jammer) {
    const open = Modes.openSize(C, hero);
    return vsShoveSpot(hero, jammer, open, Modes.vsOpenChart(C, jammer, hero)._r, `jam-${jammer}v${hero}`,
      tr(`你在 <b>${pn(hero)}</b> 开池到 ${open}bb，<b>${pn(jammer)}</b> 全下 ${C.stack}bb。跟注还是弃牌？`, `You open <b>${pn(hero)}</b> to ${open}bb and <b>${pn(jammer)}</b> shoves ${C.stack}bb. Call or fold?`),
      tr(`你（${hero}）加注到 ${open}bb，${jammer} 全下 ${C.stack}bb。`, `Hero (${hero}) raises to ${open}bb, ${jammer} shoves ${C.stack}bb.`),
      { t: 'vsJam', a: [hero, jammer] });
  }
  // Hero 3-bet to T, opener 4-bet to F: fold / call (play a 4-bet pot) / jam. Graded by EV.
  function vs4betSpot(hero, villain, T, F, range4) {
    const S = C.stack, dOther = deadOther(hero, villain), L = Modes.icmL(C);
    const potNow = dOther + T + F;
    const sp = baseSpot(hero, villain, T, F);
    return Object.assign(sp, {
      kind: 'vs4bet', chart: null, range4,
      desc: tr(`你 3-bet 到 ${T}bb，<b>${pn(villain)}</b> 4-bet 到 ${F}bb。`, `You 3-bet to ${T}bb and <b>${pn(villain)}</b> 4-bets to ${F}bb.`),
      logText: tr(`${villain} 4-bet 到 ${F}bb。`, `${villain} 4-bets to ${F}bb.`),
      options: [{ id: 'fold', label: tr('弃牌', 'Fold'), key: 'f' }, { id: 'call', label: tr(`跟注 ${fmt(F - T)}bb`, `Call ${fmt(F - T)}bb`), key: 'c' }, { id: 'raise', label: tr(`全下 ${S}bb`, `All-in ${S}bb`), key: 'r' }],
      evFn: async hand => {
        const r = without(range4, hand);
        const [callers] = Engine.cutW(r, vScore, 0.6 * Engine.W(r));
        const [eq, eqC] = await Promise.all([comp('eqVsRange', hand, r, 3000), comp('eqVsRange', hand, callers, 3000)]);
        const w = eq * 0.88;
        return {
          fold: { ev: 0, detail: tr('放弃已投入的 3-bet（基准 0）。', 'Give up your 3-bet (baseline 0).') },
          call: { ev: w * potNow - (1 - w) * (F - T) * L, detail: tr(`对抗 4-bet 范围胜率 ${pct(eq)}；低 SPR 翻后，按约 88% 实现率估算。`, `Equity vs the 4-bet range ${pct(eq)}; low-SPR postflop, estimated at ~88% realization.`) },
          raise: { ev: 0.4 * potNow + 0.6 * Modes.allinEV(eqC, S, T, dOther, L), detail: tr(`对手约 40% 弃牌（诈唬部分）；被跟注时你的胜率 ${pct(eqC)}。`, `Villain folds ~40% (the bluffs); your equity when called ${pct(eqC)}.`) },
        };
      },
    });
  }
  // Generic EV spot when villain moves all-in over hero's raise (range given as combos).
  function vsAllinSpot(hero, villain, heroIn, rangeC, desc, logText) {
    const S = C.stack, dOther = deadOther(hero, villain), L = Modes.icmL(C);
    const c = S - heroIn, Wn = S + dOther + heroIn;
    return Object.assign(baseSpot(hero, villain, heroIn, S), {
      kind: 'vsAllin', chart: null, desc, logText, rangeC,
      options: [{ id: 'fold', label: tr('弃牌', 'Fold'), key: 'f' }, { id: 'call', label: tr(`跟注全下 ${fmt(c)}bb`, `Call all-in ${fmt(c)}bb`), key: 'c' }],
      evFn: async hand => {
        const eq = await comp('eqVsRange', hand, without(rangeC, hand), 4000);
        return {
          fold: { ev: 0, detail: tr('放弃已投入的筹码（基准 0）。', 'Give up the chips already in (baseline 0).') },
          call: { ev: Modes.allinEV(eq, S, heroIn, dOther, L), detail: tr(`对抗对手全下范围的胜率 ${pct(eq)}；需要 ${pct((c * L) / (Wn + c * L))}。`, `Equity vs the shoving range ${pct(eq)}; you need ${pct((c * L) / (Wn + c * L))}.`) },
        };
      },
    });
  }
  async function spotFromRef(ref) {
    if (!ref) return null;
    const [a, b] = ref.a;
    return { rfi: () => rfiSpot(a), vsOpen: () => vsOpenSpot(a, b), vs3bet: () => vs3betSpot(a, b), vsPush: () => vsPushSpot(a, b), vsJam: () => vsJamSpot(a, b) }[ref.t]();
  }
  async function randomPreflopSpot() {
    const mode = Modes.stackMode(C), u = Math.random();
    if (mode === 'push') {
      if (u < 0.5) return rfiSpot(pick(openers()));
      const [pusher, hero] = pickPair();
      return vsPushSpot(hero, pusher);
    }
    if (u < 0.4) return rfiSpot(pick(openers()));
    const [op, other] = pickPair();
    if (u < 0.75) return vsOpenSpot(other, op);
    return mode === 'jam' ? vsJamSpot(op, other) : vs3betSpot(op, other);
  }

  // Close-spot band: Monte Carlo noise is ~1-2% of the pot, so near-equal options are all "best".
  const tolerance = potRef => Math.max(0.1, 0.025 * potRef);
  function rateLoss(loss, potRef) {
    return loss <= tolerance(potRef) ? 'best' : loss <= 0.07 * potRef ? 'good' : loss <= 0.2 * potRef ? 'inacc' : 'blunder';
  }
  const ratingText = r => RT[r];
  function rangePct(chart, action) {
    let s = 0;
    for (const l of ALL_LABELS) s += chartFreqs(chart, l)[action] * combosOf(l).length;
    return s / 1326;
  }

  // ---------- feedback rendering (shared by live play and replay) ----------
  function evRowsHTML(options, choice, potRef) {
    const best = Math.max(...options.map(o => o.ev));
    const tol = tolerance(potRef);
    const maxAbs = Math.max(...options.map(o => Math.abs(o.ev)), 0.01);
    return [...options].sort((a, b) => b.ev - a.ev).map(o => {
      const near = o.ev >= best - tol;
      return `<tr class="${o.id === choice ? 'chosen' : ''} ${near ? 'bestrow' : ''}">
        <td class="optname">${o.label}${near && o.ev < best - 1e-9 ? ` <span class="near">${tr('≈最佳', '≈best')}</span>` : ''}</td>
        <td><div class="detail">${o.detail || ''}</div><div class="freqbar"><div style="width:${Math.max(0, o.ev) / maxAbs * 100}%;background:${near ? '#5aaeff' : '#5b6a85'}"></div></div></td>
        <td class="ev">${sgn(o.ev)}bb</td></tr>`;
    }).join('');
  }
  function evFeedbackHTML(rec) {
    const best = rec.options.find(o => o.id === rec.best), chosen = rec.options.find(o => o.id === rec.chosen);
    const nNear = rec.options.filter(o => o.ev >= best.ev - tolerance(rec.potRef)).length;
    return `<span class="rating ${rec.rating}">${ratingText(rec.rating)}</span>
      <div>${rec.head}</div>
      <div>${tr(`你选择了 <b>${chosen.label}</b>（${sgn(chosen.ev)}bb）。`, `You chose <b>${chosen.label}</b> (${sgn(chosen.ev)}bb).`)}${rec.chosen === rec.best ? '' : tr(`最佳是 <b>${best.label}</b>（${sgn(best.ev)}bb），EV 损失 <b>${rec.loss.toFixed(2)}bb</b>。`, ` Best was <b>${best.label}</b> (${sgn(best.ev)}bb), EV loss <b>${rec.loss.toFixed(2)}bb</b>.`)}</div>
      ${nNear > 1 ? `<div class="muted" style="font-size:12px">${tr(`标「≈最佳」的选项与最佳相差不到 ${tolerance(rec.potRef).toFixed(2)}bb（模拟误差范围内），都算正确。`, `Options marked "≈best" are within ${tolerance(rec.potRef).toFixed(2)}bb of the best (inside simulation noise) and count as correct.`)}</div>` : ''}
      <table class="evtable">${evRowsHTML(rec.options, rec.chosen, rec.potRef)}</table>
      ${rec.eqFull !== undefined ? `<div class="muted">${tr(`你对抗对手完整范围的胜率：${pct(rec.eqFull)} · EV 为从此刻起相对于弃牌的期望筹码收益。`, `Your equity vs villain's full range: ${pct(rec.eqFull)} · EV = expected chips won from here, relative to folding.`)}</div>` : ''}
      ${rec.tip ? `<div class="tip">${rec.tip}</div>` : ''}`;
  }
  function freqFeedbackHTML(rec, chartHtml) {
    const maxF = Math.max(...rec.options.map(o => o.freq));
    const rows = rec.options.map(o => {
      const color = o.id === 'raise' ? 'var(--raise)' : o.id === 'call' ? 'var(--call)' : 'var(--fold)';
      return `<tr class="${o.id === rec.chosen ? 'chosen' : ''} ${o.freq >= maxF - 1e-9 ? 'bestrow' : ''}"><td class="optname">${o.label}</td>
        <td style="width:55%"><div class="freqbar"><div style="width:${o.freq * 100}%;background:${color}"></div></div></td><td class="ev">${pct(o.freq)}</td></tr>`;
    }).join('');
    return `<span class="rating ${rec.rating}">${ratingText(rec.rating)}</span><div>${rec.head}</div>
      <table class="evtable">${rows}</table><div class="tip">${rec.tip}</div>${chartHtml || ''}`;
  }

  function baseRec(h, st, sit) {
    return {
      t: Date.now(), cfg: { ...C }, desc: modeDesc(), st, sit, potType: st === 'pre' ? 'pre' : h.potType || 'srp',
      cls: st === 'pre' ? null : Classify.handClass(h.hero, h.board), heroPos: h.heroPos,
      villainPos: oppList(h).map(o => o.pos).join('+') || h.villainPos, hero: h.hero.slice(), board: h.board.slice(),
      pot: h.pot, stack: h.stack, heroBet: h.heroBet || 0, vilBet: h.vilBet || 0, noOpp: !!h.noOpp,
      oppPos: oppList(h).map(o => o.pos),
    };
  }

  async function gradePreflop(spot, h, choice) {
    const hand = h.hero;
    const label = labelOf(hand[0], hand[1]);
    const chosen = spot.options.find(o => o.id === choice);
    const rec = Object.assign(baseRec(h, 'pre', 'pre'), {
      kind: 'pre', ref: spot.ref, prompt: spot.desc, chosen: choice, label,
      head: `${STR.pre} · ${spot.hero}${spot.villain ? ' vs ' + spot.villain : ''} · <b>${label}</b><div class="muted" style="font-size:12px">${modeDesc()}</div>`,
    });
    if (spot.evFn) {
      const evs = await spot.evFn(hand);
      rec.options = spot.options.map(o => ({ id: o.id, label: o.label, key: o.key, ev: evs[o.id].ev, detail: evs[o.id].detail }));
      rec.best = rec.options.reduce((a, b) => (b.ev > a.ev ? b : a)).id;
      rec.potRef = spot.pot + spot.heroBet + spot.vilBet;
      rec.loss = evs[rec.best].ev - evs[choice].ev;
      rec.rating = rateLoss(rec.loss, rec.potRef);
      rec.tip = spot.kind === 'push'
        ? tr(`<b>推/弃：</b>筹码 ≤12bb 时开池加注会让你被"套池"，直接全下更好。全下 EV = 全员弃牌赢得的死钱 + 被跟注时的摊牌 EV。身后人越少、筹码越短，全下范围越宽。`,
          `<b>Push/fold:</b> at ≤12bb a normal open commits you anyway, so shoving is better. Shove EV = dead money when everyone folds + showdown EV when called. Fewer players behind and shorter stacks mean a wider shoving range.`)
        : spot.kind === 'vs4bet' ? tr('<b>面对 4-bet：</b>100bb 时 4-bet 范围很强，跟注后 SPR 很低；只有很强的牌或带阻断牌的手牌值得继续。',
          '<b>Facing a 4-bet:</b> at 100bb the 4-bet range is strong and calling leaves a low SPR; continue only with very strong hands or good blockers.')
          : tr(`<b>面对全下：</b>只看两件事——你对抗对手<i>全下范围</i>的胜率，和底池赔率要求的胜率。${Modes.icmL(C) > 1 ? `ICM 下输掉的筹码比赢到的更值钱（泡沫因子 ${Modes.icmL(C).toFixed(2)}），所以要求的胜率更高，跟注范围明显收紧。` : ''}`,
            `<b>Facing an all-in:</b> only two things matter — your equity vs the <i>shoving range</i>, and the equity the pot odds require.${Modes.icmL(C) > 1 ? ` Under ICM chips lost are worth more than chips won (bubble factor ${Modes.icmL(C).toFixed(2)}), so you need more equity and the calling range tightens a lot.` : ''}`);
      recordDecision(rec);
      handDecisions.push({ street: STR.pre, label: chosen.label, rating: rec.rating, loss: rec.loss });
      const grid = spot.chart ? `<div class="muted" style="margin-top:8px;font-size:12px">${spot.kind === 'push' ? tr('参考范围（近似 Nash 全下范围）', 'Reference range (approx. Nash shoving range)') : tr('参考范围（按 EV 计算的跟注范围）', 'Reference range (EV-based calling range)')}</div>${chartGrid(spot.chart, label)}`
        : spot.range4 || spot.rangeC ? `<details><summary class="muted">${tr('对手范围', "Villain's range")}</summary>${rangeGrid(spot.range4 || spot.rangeC)}</details>` : '';
      setFeedback(evFeedbackHTML(rec) + grid);
      return rec.rating;
    }
    const f = chartFreqs(spot.chart, label);
    rec.options = spot.options.map(o => ({ id: o.id, label: o.label, key: o.key, freq: f[o.id] }));
    const maxF = Math.max(...rec.options.map(o => o.freq));
    const cf = f[choice];
    rec.best = rec.options.find(o => o.freq >= maxF - 1e-9).id;
    rec.rating = cf >= maxF - 1e-9 ? 'best' : cf >= 0.25 ? 'good' : cf >= 0.05 ? 'inacc' : 'blunder';
    rec.loss = null;
    const ids = spot.options.map(o => o.id);
    const mixed = ids.filter(id => f[id] > 0.05).length > 1;
    let tip = mixed
      ? tr(`<b>${label}</b> 在这里是混合策略手牌：solver 会在多个动作之间分配频率，任何有一定频率的动作都可以。可根据对手倾向选择，或随机化。`,
        `<b>${label}</b> is a mixed-strategy hand here: solvers split it between actions, so any action with real frequency is fine. Choose by reads or randomize.`)
      : tr(`<b>${label}</b> 在这个位置是纯${ACT[rec.best]}。`, `<b>${label}</b> is a pure ${ACT[rec.best]} here.`);
    if (spot.kind === 'rfi') tip += tr(` ${spot.hero} 大约开池 ${pct(rangePct(spot.chart, 'raise'))} 的手牌。`, ` ${spot.hero} opens about ${pct(rangePct(spot.chart, 'raise'))} of hands.`);
    else if (spot.kind === 'vsOpen') tip += tr(` 这里你约${Modes.stackMode(C) === 'jam' ? '全下' : ' 3-bet'} ${pct(rangePct(spot.chart, 'raise'))}、跟注 ${pct(rangePct(spot.chart, 'call'))} 的手牌。`,
      ` Here you ${Modes.stackMode(C) === 'jam' ? 'shove' : '3-bet'} ~${pct(rangePct(spot.chart, 'raise'))} and call ~${pct(rangePct(spot.chart, 'call'))} of hands.`);
    else tip += tr(` 这里你约 4-bet ${pct(rangePct(spot.chart, 'raise'))}、跟注 ${pct(rangePct(spot.chart, 'call'))} 的手牌。`, ` Here you 4-bet ~${pct(rangePct(spot.chart, 'raise'))} and call ~${pct(rangePct(spot.chart, 'call'))} of hands.`);
    if (C.game === 'mtt') tip += tr(' MTT 有前注，底池里死钱更多，所以开池和防守都比现金局更宽；ICM 阶段则整体收紧。', ' MTTs have antes, so there is more dead money and both opens and defends are wider than cash; ICM stages tighten everything.');
    if (!Modes.useHandCharts(C)) tip += ` <span class="muted">${tr('（此格式的范围由模型按位置、人数、筹码深度生成，属近似。）', '(Ranges for this format are generated by a model from position, player count and stack depth — an approximation.)')}</span>`;
    rec.tip = tip;
    recordDecision(rec);
    handDecisions.push({ street: STR.pre, label: chosen.label, rating: rec.rating, loss: null });
    setFeedback(freqFeedbackHTML(rec, chartGrid(spot.chart, label)));
    return rec.rating;
  }

  // ---------- postflop decisions ----------
  function mkctx(h, st) {
    // Partial-stack pots carry less ICM risk than an all-in; scale the bubble factor down a little.
    const bf = Modes.icmL(C);
    return { P: h.pot, S: h.stack, street: st, ip: h.heroIP, L: 1 + (bf - 1) * 0.8 };
  }

  function renderHints(h) {
    if (!$('#hints').checked) { $('#hint-panel').innerHTML = ''; return; }
    if (h.opps) {
      const live = h.opps.filter(o => o.live);
      $('#hint-panel').innerHTML = `<h3>${tr('提示', 'Hint')}</h3>${tr(`你对抗 ${live.length} 名对手的整体胜率`, `Your equity vs ${live.length} opponents`)}: <b>${pct(Multi.eqMulti(h.hero, h.board, live.map(o => o.range), 800))}</b>${live.map(o => rangeGrid(o.range, tr(`${o.pos} 的范围`, `${o.pos}'s range`))).join('')}`;
      return;
    }
    $('#hint-panel').innerHTML = `<h3>${tr('提示', 'Hint')}</h3>${tr('你对抗对手范围的胜率', "Your equity vs villain's range")}: <b>${pct(Engine.eqOf(h.range))}</b>${rangeGrid(h.range)}`;
  }

  function filterMatch(st, sit, cls, potType) {
    return (filter.street === 'any' || filter.street === st) && (filter.sit === 'any' || filter.sit === sit)
      && (filter.cls === 'any' || filter.cls === cls) && (filter.pot === 'any' || filter.pot === potType || (filter.pot === '3bet' && potType === '4bet'));
  }

  async function decide(h, st, options, prompt, facing, sit) {
    const cls = Classify.handClass(h.hero, h.board);
    if (filterActive() && !h.hit) {
      if (!filterMatch(st, sit, cls, h.potType)) {
        const si = STREETS.indexOf(st), ti = STREETS.indexOf(filter.street);
        if (filter.street !== 'any' && si > ti) throw RESTART;
        if (filter.street !== 'any' && si === ti && filter.cls !== 'any' && cls !== filter.cls) throw RESTART;
        const best = options.reduce((a, b) => (b.ev > a.ev ? b : a));
        // On the target street, steer auto-play toward the requested situation: checking lets the
        // villain bet into you, betting lets the villain raise you.
        const onTarget = filter.street === 'any' || filter.street === st;
        let auto = best;
        if (onTarget && filter.sit === 'facing') auto = options.find(o => o.id === 'check') || best;
        if (onTarget && filter.sit === 'raise') auto = options.filter(o => o.B).sort((a, b) => b.ev - a.ev)[0] || best;
        // Before a later target street, play passively (check/call) so the hand survives to get there.
        if (!onTarget && filter.street !== 'any' && si < ti) auto = options.find(o => o.id === 'check') || options.find(o => o.id === 'call') || best;
        log(auto === best ? tr(`你（自动最佳）：${best.label}。`, `Hero (auto-best): ${best.label}.`)
          : tr(`你（自动）：${auto.label}。`, `Hero (auto): ${auto.label}.`), 'muted');
        return auto;
      }
      h.hit = true;
    }
    // Pot currently on the table, including every bet made this street.
    const vb = h.opps ? h.opps.filter(o => o.live).reduce((s, o) => s + (o.bet || 0), 0) : h.vilBet || 0;
    const potRef = h.pot + (h.heroBet || 0) + vb;
    // Pot odds are public information, so showing the price to call is a fair learning aid.
    const odds = facing > 0 ? `<div><span class="odds">${tr(`跟注 ${fmt(facing)} 赢 ${fmt(potRef)} · 需要 ${pct(facing / (potRef + facing))} 胜率`, `Call ${fmt(facing)} to win ${fmt(potRef)} · need ${pct(facing / (potRef + facing))} equity`)}</span></div>` : '';
    setSituation(prompt + odds, h);
    curH = h;
    renderHints(h);
    const choice = await ask(options.map(o => ({ id: o.id, label: o.label, key: o.key })));
    curH = null;
    $('#hint-panel').innerHTML = '';
    const best = options.reduce((a, b) => (b.ev > a.ev ? b : a));
    const chosen = options.find(o => o.id === choice);
    const loss = best.ev - chosen.ev;
    let tip;
    if (sit === 'facing' || sit === 'raise') {
      tip = tr(`<b>底池赔率：</b>你需要支付 ${fmt(facing)}，桌上底池为 ${fmt(potRef)}，所以需要约 ${pct(facing / (potRef + facing))} 的胜率——是对抗对手<i>这个动作的范围</i>，而不是他的全部范围。`,
        `<b>Pot odds:</b> you pay ${fmt(facing)} into a ${fmt(potRef)} pot, so you need about ${pct(facing / (potRef + facing))} equity — against the range that <i>takes this action</i>, not villain's whole range.`);
      if (sit === 'raise') tip += tr(' 被加注时对手范围通常很强（价值为主，夹杂听牌诈唬），边缘牌多数应该放弃。', ' A raising range is usually strong (mostly value plus some draws), so most marginal hands should let go.');
    } else {
      const b = options.find(o => o.B);
      tip = b ? tr(`<b>MDF（最小防守频率）：</b>面对 ${fmt(h.pot)} 底池中 ${fmt(b.B)} 的下注，平衡的对手大约防守 ${pct(h.pot / (h.pot + b.B))}${h.opps ? '（多人底池每人防守更少）' : ''}。尺度越大，对手跟注范围越强、弃牌越多；对手也会用强牌和听牌加注你。`,
        `<b>MDF (minimum defense frequency):</b> vs a ${fmt(b.B)} bet into ${fmt(h.pot)}, a balanced villain defends about ${pct(h.pot / (h.pot + b.B))}${h.opps ? ' (each player defends less in a multiway pot)' : ''}. Bigger sizes get folds more often but are called by stronger hands; villain also raises you with strong hands and draws.`) : '';
    }
    if (Modes.icmL(C) > 1) tip += tr(` <b>ICM：</b>${STAGE[C.stage]}泡沫因子 ${Modes.icmL(C).toFixed(2)}，输掉筹码的代价更高，边缘跟注和诈唬的 EV 都会下降。`,
      ` <b>ICM:</b> ${STAGE[C.stage]} bubble factor ${Modes.icmL(C).toFixed(2)} — losing chips costs more, so marginal calls and bluffs lose EV.`);
    const eqFull = h.opps ? undefined : Engine.eqOf(h.range);
    const rec = Object.assign(baseRec(h, st, sit), {
      kind: 'post', prompt, chosen: choice, best: best.id, loss, potRef, rating: rateLoss(loss, potRef), tip, eqFull,
      options: options.map(o => ({ id: o.id, label: o.label, key: o.key, ev: o.ev, detail: o.detail })),
      head: `${STR[st]} · ${cstr(h.hero)}${tr('，公共牌', ' · board')} ${cstr(h.board)} · ${SIT[sit]} · ${POTS[h.potType] || ''}`,
    });
    recordDecision(rec);
    handDecisions.push({ street: STR[st], label: chosen.label, rating: rec.rating, loss });
    const rangeHtml = h.opps ? '' : `<details><summary class="muted">${tr('此决策时对手的范围', "Villain's range at this decision")}</summary>${rangeGrid(h.range)}</details>`;
    setFeedback(evFeedbackHTML(rec) + rangeHtml);
    await maybeContinue(rec.rating, filterActive() ? tr('下一题 ▸', 'Next spot ▸') : tr('继续', 'Continue'));
    if (filterActive() && h.hit) throw SPOT_DONE;
    return chosen;
  }

  function streetPrompt(h, extra) {
    return `${extra}<div class="handinfo">${tr(`底池 ${fmt(h.pot)}bb · 有效筹码 ${fmt(h.stack)}bb · ${POTS[h.potType] || ''} · 你${h.heroIP ? '有位置（后行动）' : '无位置（先行动）'}`,
      `Pot ${fmt(h.pot)}bb · effective stack ${fmt(h.stack)}bb · ${POTS[h.potType] || ''} · you are ${h.heroIP ? 'in position (act last)' : 'out of position (act first)'}`)}</div>`;
  }

  // ---------- heads-up postflop ----------
  async function heroFirst(h, st, villainToAct) {
    const options = Engine.optsFirst(mkctx(h, st), h.range, villainToAct, h.board);
    const o = await decide(h, st, options, streetPrompt(h, villainToAct ? tr(`${STR[st]}圈你先行动。`, `You act first on the ${STR[st].toLowerCase()}.`) : tr(`<b>${pn(h.villainPos)}</b> 过牌给你。`, `<b>${pn(h.villainPos)}</b> checks to you.`)), 0, 'first');
    if (o.id === 'check') {
      log(tr('你过牌。', 'Hero checks.'));
      h.heroAct = 'check';
      if (!villainToAct) return 'next';
      const plan = o.plan;
      const act = plan.pBet > 0 ? Engine.member(h.vil, [['bet', plan.BR], ['check', plan.CR]]) : 'check';
      if (act === 'check') { h.range = plan.CR; log(tr(`${h.villainPos} 过牌。`, `${h.villainPos} checks.`)); return 'next'; }
      h.range = plan.BR;
      h.vilBet = plan.B;
      log(tr(`${h.villainPos} 下注 ${fmt(plan.B)}。`, `${h.villainPos} bets ${fmt(plan.B)}.`));
      renderTable(h);
      return facingBet(h, st, plan.B);
    }
    const B = o.B, resp = o.resp;
    log(tr(`你下注 ${fmt(B)}。`, `Hero bets ${fmt(B)}.`));
    h.heroAct = 'bet';
    h.heroBet = B;
    renderTable(h);
    const act = Engine.member(h.vil, [['raise', resp.raise], ['call', resp.call], ['fold', resp.fold]]);
    if (act === 'fold') { h.heroBet = 0; h.pot += B; h.invested += B; log(tr(`${h.villainPos} 弃牌。`, `${h.villainPos} folds.`)); return 'won'; }
    if (act === 'call') {
      h.heroBet = 0; h.pot += 2 * B; h.stack -= B; h.invested += B; h.range = resp.call;
      log(tr(`${h.villainPos} 跟注。`, `${h.villainPos} calls.`));
      return h.stack <= 1e-9 ? 'allin' : 'next';
    }
    h.range = resp.raise;
    h.vilBet = resp.X;
    log(tr(`${h.villainPos} 加注到 ${fmt(resp.X)}。`, `${h.villainPos} raises to ${fmt(resp.X)}.`));
    renderTable(h);
    return facingRaise(h, st, B, resp.X);
  }

  async function facingRaise(h, st, B, X) {
    const options = Engine.optsFacingRaise(mkctx(h, st), h.range, B, X);
    const o = await decide(h, st, options, streetPrompt(h, tr(`你下注 ${fmt(B)}，<b>${pn(h.villainPos)}</b> 加注到 ${fmt(X)}。`, `You bet ${fmt(B)} and <b>${pn(h.villainPos)}</b> raises to ${fmt(X)}.`)), X - B, 'raise');
    const S = h.stack;
    h.heroBet = h.vilBet = 0;
    if (o.id === 'fold') { log(tr('你弃牌。', 'Hero folds.')); h.invested += B; h.pot += B + X; return 'fold'; }
    if (o.id === 'call') {
      log(tr(`你跟注 ${fmt(X - B)}。`, `Hero calls ${fmt(X - B)}.`));
      h.heroAct = 'call';
      h.invested += X; h.pot += 2 * X; h.stack -= X;
      return h.stack <= 1e-9 ? 'allin' : 'next';
    }
    log(tr(`你全下 ${fmt(S)}。`, `Hero shoves ${fmt(S)}.`));
    h.heroAct = 'raise';
    const act = Engine.member(h.vil, [['call', o.resp.call], ['fold', o.resp.fold]]);
    if (act === 'fold') { h.invested += S; h.pot += X + S; log(tr(`${h.villainPos} 弃牌。`, `${h.villainPos} folds.`)); return 'won'; }
    log(tr(`${h.villainPos} 跟注全下。`, `${h.villainPos} calls all-in.`));
    h.range = o.resp.call;
    h.invested += S; h.pot += 2 * S; h.stack = 0;
    return 'allin';
  }

  async function facingBet(h, st, B) {
    const options = Engine.optsFacingBet(mkctx(h, st), h.range, B);
    const o = await decide(h, st, options, streetPrompt(h, tr(`<b>${pn(h.villainPos)}</b> 在 ${fmt(h.pot)} 的底池中下注 ${fmt(B)}（${Math.round(B / h.pot * 100)}% 底池）。`, `<b>${pn(h.villainPos)}</b> bets ${fmt(B)} into ${fmt(h.pot)} (${Math.round(B / h.pot * 100)}% pot).`)), B, 'facing');
    h.vilBet = 0;
    if (o.id === 'fold') { log(tr('你弃牌。', 'Hero folds.')); h.pot += B; return 'fold'; }
    if (o.id === 'call') {
      log(tr(`你跟注 ${fmt(B)}。`, `Hero calls ${fmt(B)}.`));
      h.heroAct = 'call';
      h.pot += 2 * B; h.stack -= B; h.invested += B;
      return h.stack <= 1e-9 ? 'allin' : 'next';
    }
    const X = o.X, resp = o.resp, S = h.stack;
    log(X >= S - 1e-9 ? tr(`你全下 ${fmt(X)}。`, `Hero shoves ${fmt(X)}.`) : tr(`你加注到 ${fmt(X)}。`, `Hero raises to ${fmt(X)}.`));
    h.heroAct = 'raise';
    const act = Engine.member(h.vil, [['jam', resp.jam], ['call', resp.call], ['fold', resp.fold]]);
    if (act === 'fold') { h.pot += B + X; h.invested += X; log(tr(`${h.villainPos} 弃牌。`, `${h.villainPos} folds.`)); return 'won'; }
    if (act === 'call') {
      log(tr(`${h.villainPos} 跟注。`, `${h.villainPos} calls.`));
      h.range = resp.call;
      h.pot += 2 * X; h.stack -= X; h.invested += X;
      return h.stack <= 1e-9 ? 'allin' : 'next';
    }
    h.range = resp.jam;
    h.heroBet = X; h.vilBet = S;
    log(tr(`${h.villainPos} 再全下 ${fmt(S)}。`, `${h.villainPos} re-shoves ${fmt(S)}.`));
    renderTable(h);
    const o2 = await decide(h, st, Engine.optsFacingJam(mkctx(h, st), h.range, X),
      streetPrompt(h, tr(`你加注到 ${fmt(X)}，<b>${pn(h.villainPos)}</b> 全下 ${fmt(S)}。`, `You raise to ${fmt(X)} and <b>${pn(h.villainPos)}</b> shoves ${fmt(S)}.`)), S - X, 'raise');
    h.heroBet = h.vilBet = 0;
    if (o2.id === 'fold') { log(tr('你弃牌。', 'Hero folds.')); h.invested += X; h.pot += X + S; return 'fold'; }
    log(tr('你跟注全下。', 'Hero calls all-in.'));
    h.invested += S; h.pot += 2 * S; h.stack = 0;
    return 'allin';
  }

  async function villainLeadThenHero(h, st) {
    const plan = Engine.villainBetPlan(st, 'oop', h.pot, h.stack, h.board, h.range);
    if (plan) {
      if (Engine.member(h.vil, [['bet', plan.BR], ['check', plan.CR]]) === 'bet') {
        h.range = plan.BR; h.vilBet = plan.B;
        log(tr(`${h.villainPos} 下注 ${fmt(plan.B)}。`, `${h.villainPos} bets ${fmt(plan.B)}.`));
        renderTable(h);
        return facingBet(h, st, plan.B);
      }
      h.range = plan.CR;
    }
    log(tr(`${h.villainPos} 过牌。`, `${h.villainPos} checks.`));
    return heroFirst(h, st, false);
  }

  async function playStreetHU(h, st) {
    await annotateRange(h.range, h);
    h.heroAct = null;
    const res = h.heroIP ? await villainLeadThenHero(h, st) : await heroFirst(h, st, true);
    if (h.heroAct) h.heroRange = Engine.narrowHero(h.heroRange, h.heroAct);
    return res;
  }

  // ---------- 3-way postflop ----------
  const postIdx = pos => { const ps = P(); return Modes.isHU(C) ? (pos === 'BB' ? 0 : 1) : pos === 'SB' ? 0 : pos === 'BB' ? 1 : 2 + ps.indexOf(pos); };
  function toHeadsUp(h) {
    const o = h.opps.find(x => x.live);
    Object.assign(h, { villainPos: o.pos, vil: o.vil, range: o.range, heroIP: Modes.heroIP(C, h.heroPos, o.pos), opps: null, vilBet: 0 });
  }

  async function playStreetMulti(h, st) {
    const L = mkctx(h, st).L, S = h.stack, P0 = h.pot;
    const live = () => h.opps.filter(o => o.live);
    for (const o of live()) await annotateRange(o.range, h);
    const order = [{ hero: true, pos: h.heroPos }, ...live()].sort((a, b) => postIdx(a.pos) - postIdx(b.pos));
    const lastPos = order[order.length - 1].pos;
    const ctx = { P: P0, S, street: st, ip: h.heroPos === lastPos, L };
    let bettor = null, B = 0;
    h.heroAct = null;
    // First orbit: check or open the betting.
    for (const p of order) {
      if (p.hero) {
        const opts = await comp('multiFirst', I18N.lang, ctx, live(), h.board, h.hero);
        const o = await decide(h, st, opts, streetPrompt(h, tr(`${STR[st]}圈轮到你（${live().length + 1} 人底池）。`, `Your turn on the ${STR[st].toLowerCase()} (${live().length + 1}-way pot).`)), 0, 'first');
        if (o.id === 'check') { log(tr('你过牌。', 'Hero checks.')); h.heroAct = 'check'; continue; }
        B = o.B;
        h.heroAct = 'bet';
        log(tr(`你下注 ${fmt(B)}。`, `Hero bets ${fmt(B)}.`));
        h.heroBet = B; renderTable(h);
        const lv = live();
        const respOrder = lv.slice().sort((a, b) => ((postIdx(a.pos) - postIdx(h.heroPos) + 20) % 20) - ((postIdx(b.pos) - postIdx(h.heroPos) + 20) % 20));
        let raiser = null, callersB = 0;
        for (const v of respOrder) {
          const r = o.resps[lv.indexOf(v)];
          // After a raise, later players simply fold.
          const act = raiser ? 'fold' : Engine.member(v.vil, [['raise', r.raise], ['call', r.call], ['fold', r.fold]]);
          if (act === 'raise') { raiser = { v, X: r.X, range: r.raise }; log(tr(`${v.pos} 加注到 ${fmt(r.X)}。`, `${v.pos} raises to ${fmt(r.X)}.`)); }
          else if (act === 'call') { v.range = r.call; v.bet = B; callersB += B; log(tr(`${v.pos} 跟注。`, `${v.pos} calls.`)); }
          else { v.live = false; log(tr(`${v.pos} 弃牌。`, `${v.pos} folds.`)); }
        }
        h.invested += B;
        if (raiser) {
          // Anyone who called before the raise is treated as folding to it; their chips stay in the pot.
          for (const v of live()) if (v !== raiser.v) { v.live = false; if (v.bet) log(tr(`${v.pos} 弃牌。`, `${v.pos} folds.`)); }
          h.invested -= B;
          h.pot = P0 + callersB;
          raiser.v.range = raiser.range;
          h.opps.forEach(v => { v.bet = 0; });
          toHeadsUp(h);
          h.heroBet = B; h.vilBet = raiser.X;
          renderTable(h);
          return facingRaise(h, st, B, raiser.X);
        }
        h.heroBet = 0; h.opps.forEach(v => { v.bet = 0; });
        const callers = live();
        if (!callers.length) { h.pot = P0 + B; return 'won'; }
        h.pot = P0 + B + callersB; h.stack -= B;
        if (callers.length === 1) toHeadsUp(h);
        return h.stack <= 1e-9 ? 'allin' : 'next';
      }
      const isLast = p.pos === lastPos;
      const plan = Engine.villainBetPlan(st, isLast ? 'ip' : 'oop', P0, S, h.board, p.range, 0.65);
      if (plan && Engine.member(p.vil, [['bet', plan.BR], ['check', plan.CR]]) === 'bet') {
        p.range = plan.BR; bettor = p; B = plan.B; p.bet = B;
        log(tr(`${p.pos} 下注 ${fmt(B)}。`, `${p.pos} bets ${fmt(B)}.`));
        renderTable(h);
        break;
      }
      if (plan) p.range = plan.CR;
      log(tr(`${p.pos} 过牌。`, `${p.pos} checks.`));
    }
    if (!bettor) return 'next';
    // Respond to a villain's bet in seat order after the bettor.
    const bi = order.findIndex(p => p === bettor);
    const after = [...order.slice(bi + 1), ...order.slice(0, bi)];
    let potAdd = B;
    for (const p of after) {
      if (p.hero) {
        const other = live().find(v => v !== bettor);
        const otherState = !other ? null : { pos: other.pos, range: other.range, state: other.bet ? 'called' : after.indexOf(other) > after.indexOf(p) ? 'pending' : 'checked' };
        if (otherState && otherState.state === 'checked') otherState.state = 'pending';
        const opts = await comp('multiFacing', I18N.lang, ctx, { pos: bettor.pos }, bettor.range, B, otherState, h.board, h.hero);
        const o = await decide(h, st, opts, streetPrompt(h, tr(`<b>${pn(bettor.pos)}</b> 下注 ${fmt(B)}${other && other.bet ? `，${other.pos} 已跟注` : ''}。`, `<b>${pn(bettor.pos)}</b> bets ${fmt(B)}${other && other.bet ? `, ${other.pos} calls` : ''}.`)), B, 'facing');
        if (o.id === 'fold') { log(tr('你弃牌。', 'Hero folds.')); h.pot = P0 + potAdd; return 'fold'; }
        if (o.id === 'call') { log(tr(`你跟注 ${fmt(B)}。`, `Hero calls ${fmt(B)}.`)); h.heroAct = 'call'; h.invested += B; potAdd += B; h.heroBet = B; continue; }
        // Hero raises: third player folds, play continues heads-up against the bettor.
        h.heroAct = 'raise';
        if (other) { other.live = false; log(tr(`${other.pos} 弃牌。`, `${other.pos} folds.`)); }
        h.pot = P0 + (other && other.bet ? other.bet : 0);
        h.opps.forEach(v => { v.bet = 0; });
        toHeadsUp(h);
        log(tr(`你加注到 ${fmt(o.X)}。`, `Hero raises to ${fmt(o.X)}.`));
        const resp = o.resp, X = o.X, S2 = h.stack;
        const act = Engine.member(h.vil, [['jam', resp.jam], ['call', resp.call], ['fold', resp.fold]]);
        if (act === 'fold') { h.pot += B + X; h.invested += X; log(tr(`${h.villainPos} 弃牌。`, `${h.villainPos} folds.`)); return 'won'; }
        if (act === 'call') { h.range = resp.call; h.pot += 2 * X; h.stack -= X; h.invested += X; log(tr(`${h.villainPos} 跟注。`, `${h.villainPos} calls.`)); return h.stack <= 1e-9 ? 'allin' : 'next'; }
        h.range = resp.jam; h.heroBet = X; h.vilBet = S2;
        log(tr(`${h.villainPos} 再全下 ${fmt(S2)}。`, `${h.villainPos} re-shoves ${fmt(S2)}.`));
        renderTable(h);
        const o2 = await decide(h, st, Engine.optsFacingJam(mkctx(h, st), h.range, X), streetPrompt(h, tr(`<b>${pn(h.villainPos)}</b> 全下 ${fmt(S2)}。`, `<b>${pn(h.villainPos)}</b> shoves ${fmt(S2)}.`)), S2 - X, 'raise');
        h.heroBet = h.vilBet = 0;
        if (o2.id === 'fold') { log(tr('你弃牌。', 'Hero folds.')); h.invested += X; h.pot += X + S2; return 'fold'; }
        log(tr('你跟注全下。', 'Hero calls all-in.'));
        h.invested += S2; h.pot += 2 * S2; h.stack = 0;
        return 'allin';
      }
      const r = Engine.respondToBet(p.range, st, P0 + potAdd, B, S, 1);
      if (Engine.member(p.vil, [['call', r.call.concat(r.raise)], ['fold', r.fold]]) === 'call') {
        p.range = r.call.concat(r.raise); p.bet = B; potAdd += B; log(tr(`${p.pos} 跟注。`, `${p.pos} calls.`));
      } else { p.live = false; log(tr(`${p.pos} 弃牌。`, `${p.pos} folds.`)); }
    }
    h.heroBet = 0; h.opps.forEach(v => { v.bet = 0; });
    h.pot = P0 + potAdd; h.stack -= B;
    if (live().length === 1) toHeadsUp(h);
    return h.stack <= 1e-9 ? 'allin' : 'next';
  }

  // ---------- hand flow ----------
  async function endHand(h, outcome, note = '') {
    if (filterActive() && !h.hit) throw RESTART;
    let net, text;
    if (outcome === 'fold') { net = -h.invested; text = tr('你弃牌了。', 'You folded.'); }
    else if (outcome === 'won') { net = h.pot - h.invested; text = tr(`对手弃牌——你赢得 ${fmt(h.pot)}bb。`, `Villain folds — you win ${fmt(h.pot)}bb.`); }
    else if (outcome === 'showdown') {
      const hs = evalHand([...h.hero, ...h.board]);
      const opps = oppList(h);
      const vs = opps.map(o => evalHand([...o.vil, ...h.board]));
      const top = Math.max(hs, ...vs);
      const winners = (hs === top ? 1 : 0) + vs.filter(v => v === top).length;
      const share = hs === top ? 1 / winners : 0;
      net = share * h.pot - h.invested;
      text = tr(`摊牌：你是${handName(hs)}；${opps.map((o, i) => `${o.pos} 亮出 ${cstr(o.vil)}（${handName(vs[i])}）`).join('；')}。${share === 1 ? '你赢得' : share > 0 ? '平分底池' : '对手赢得'} ${fmt(h.pot)}bb。`,
        `Showdown: you have ${handName(hs)}; ${opps.map((o, i) => `${o.pos} shows ${cstr(o.vil)} (${handName(vs[i])})`).join('; ')}. ${share === 1 ? 'You win' : share > 0 ? 'Split pot of' : 'Villain wins'} ${fmt(h.pot)}bb.`);
      log(text);
    } else { net = -(h.invested || 0); text = note; }
    stats.hands++;
    stats.net += net;
    saveStats();
    histories.unshift({ t: Date.now(), desc: modeDesc(), hero: cstr(h.hero), lines: curHH.slice(), net });
    if (histories.length > 200) histories.length = 200;
    save('gto-trainer-hh', histories);
    h.heroBet = h.vilBet = 0;
    // Optionally show the opponents' hands even without a showdown, for learning.
    const unseen = outcome !== 'showdown' && prefs.reveal ? oppList(h).filter(o => o.vil) : [];
    renderTable(h, outcome === 'showdown' || unseen.length > 0);
    const revealTxt = unseen.length ? `<div class="handinfo">${tr('对手的牌', "Villain's cards")}: ${unseen.map(o => `${o.pos} ${cstr(o.vil)}`).join(', ')}</div>` : '';
    setSituation(`${text}${note && outcome !== 'other' ? ' ' + note : ''}${revealTxt}`);
    const lossTotal = handDecisions.reduce((s, d) => s + (d.loss || 0), 0);
    const list = handDecisions.map(d => `<li><span class="rating ${d.rating}">${ratingText(d.rating)}</span>${d.street}: ${d.label}${d.loss !== null ? ` <span class="muted">(−${d.loss.toFixed(2)}bb)</span>` : ''}</li>`).join('');
    const prev = $('#feedback').innerHTML;
    setFeedback(`<h3>${tr('本手总结', 'Hand summary')}</h3><div>${tr('结果', 'Result')}: <span class="${net >= 0 ? 'net-pos' : 'net-neg'}">${sgn(net)}bb</span>
      · ${tr('EV 损失', 'EV lost')}: <b>${lossTotal.toFixed(2)}bb</b></div>
      <div class="muted" style="font-size:12px">${tr('结果有运气成分；EV 损失才是你能控制的。', 'Results include luck; EV lost is what you control.')}</div>
      <ul class="summary-list">${list || `<li class="muted">${tr('这一手没有需要评分的决策。', 'No graded decisions this hand.')}</li>`}</ul><details><summary class="muted">${tr('最后一个决策详情', 'Last decision detail')}</summary>${prev}</details>`);
    await ask([{ id: 'next', label: tr('下一手 ▸', 'Next hand ▸'), key: 'Enter' }]);
    newHand();
  }

  async function allinShowdown(h, pot, invested) {
    h.pot = pot ?? 2 * C.stack + deadOther(h.heroPos, h.villainPos);
    h.invested = invested ?? C.stack;
    h.stack = 0; h.heroBet = h.vilBet = 0;
    if (filterActive() && !h.hit) throw RESTART;
    log(tr(`全下对决：你 ${cstr(h.hero)} vs ${oppList(h).map(o => `${o.pos} ${cstr(o.vil)}`).join('、')}`,
      `All-in: Hero ${cstr(h.hero)} vs ${oppList(h).map(o => `${o.pos} ${cstr(o.vil)}`).join(', ')}`));
    while (h.board.length < 5) {
      dealCards(h, h.board.length === 0 ? 3 : 1);
      renderTable(h, true, h.board.length === 3 ? 3 : 1);
      await tick(350);
    }
    log(`${tr('公共牌', 'Board')} ${cstr(h.board)}`, 'street');
    return endHand(h, 'showdown');
  }

  async function preflopDecision(h, spot, skipLog) {
    Object.assign(h, { pot: spot.pot, heroBet: spot.heroBet, vilBet: spot.vilBet, stack: spot.stack });
    renderTable(h);
    if (!skipLog) log(spot.logText);
    setSituation(`${spot.desc}<div class="handinfo">${modeDesc()}</div>`);
    const choice = await ask(spot.options);
    setSituation(SPIN + tr('计算中…', 'Thinking…'));
    await tick(20);
    await gradePreflop(spot, h, choice);
    setSituation(`${spot.desc}<div class="handinfo">${modeDesc()}</div>`);
    log(tr(`你：${spot.options.find(o => o.id === choice).label}。`, `Hero: ${spot.options.find(o => o.id === choice).label}.`));
    return choice;
  }

  function pickResponder(hero, forceCall) {
    const ps = P(), behindList = ps.slice(ps.indexOf(hero) + 1);
    const cands = behindList.filter(v => {
      const ch = Modes.vsOpenChart(C, v, hero);
      return rangePct(ch, 'call') > 0 || (!forceCall && rangePct(ch, 'raise') > 0);
    });
    if (!cands.length) return null;
    if (cands.includes('BB') && Math.random() < 0.45) return 'BB';
    return pick(cands);
  }

  // Sets up and plays the postflop streets for whatever pot the preflop produced.
  async function playPostflop(h) {
    h.heroRange = h.heroRange || [];
    h.stack = Math.max(0, h.stack);
    for (const st of STREETS) {
      dealCards(h, st === 'flop' ? 3 : 1);
      if (h.opps) h.opps.forEach(o => { o.range = without(o.range, h.board); });
      else h.range = without(h.range, h.board);
      log(`${STR[st]}  ${cstr(h.board)}   ${tr(`（底池 ${fmt(h.pot)}）`, `(pot ${fmt(h.pot)})`)}`, 'street');
      renderTable(h, false, st === 'flop' ? 3 : 1);
      if (h.allin) continue;
      setSituation(SPIN + (filterActive() && !h.hit ? tr(`正在寻找符合筛选条件的局面…（第 ${restarts + 1} 手）`, `Looking for a spot that matches the filter… (hand ${restarts + 1})`) : tr('计算中…', 'Thinking…')), h);
      await tick(filterActive() && !h.hit ? 0 : 30);
      h.heroRange = await comp('annotateHero', h.heroRange, h.board);
      let res;
      if (h.opps) {
        res = await playStreetMulti(h, st);
        if (h.heroAct && h.heroRange.length) h.heroRange = Engine.narrowHero(h.heroRange, h.heroAct);
      } else res = await playStreetHU(h, st);
      renderTable(h);
      if (res === 'fold' || res === 'won') return endHand(h, res);
      if (res === 'allin') h.allin = true;
    }
    return endHand(h, 'showdown');
  }

  // Chooses the pot type for this hand (respecting the spot filter in postflop drills).
  function choosePotType(skipPreflop) {
    const want = skipPreflop && filter.pot !== 'any' ? filter.pot : null;
    if (want) return want === 'multi' && C.players < 3 ? 'srp' : want;
    if (!skipPreflop) return 'srp';
    const u = Math.random();
    if (C.players >= 3 && u < 0.18) return 'multi';
    if (Modes.stackMode(C) === 'deep' && u < 0.36) return '3bet';
    return 'srp';
  }

  // Postflop drill: build the preflop result directly from the ranges.
  function setupDirect(potType) {
    const ps = P();
    if (potType === 'multi') {
      if (Math.random() < 0.5 || !ps.includes('BB')) {
        const cand = openers().filter(p => Modes.behind(C, p) >= 2);
        const hero = pick(cand.length ? cand : openers());
        const behind = ps.slice(ps.indexOf(hero) + 1);
        const c2 = behind.includes('BB') ? 'BB' : behind[behind.length - 1];
        const c1 = pick(behind.filter(p => p !== c2)) || behind[0];
        const open = Modes.openSize(C, hero);
        const heroHand = Engine.sampleCombo(rangeFrom(Modes.rfiChart(C, hero), 'raise'));
        const mk = pos => { const r = rangeFrom(Modes.vsOpenChart(C, pos, hero), 'call', new Set(heroHand)); return { pos, range: r, live: true }; };
        const opps = [mk(c1), mk(c2)];
        log(tr(`你（${hero}）加注 ${open}bb，${c1} 跟注，${c2} 跟注。`, `Hero (${hero}) raises ${open}bb, ${c1} calls, ${c2} calls.`));
        return { heroPos: hero, hero: heroHand, opps, potType, pot: 3 * open + deadOther(hero, c1, c2), stack: C.stack - open, invested: open,
          heroRange: rangeFrom(Modes.rfiChart(C, hero), 'raise') };
      }
      // Someone opens, a player between them and the BB calls, hero defends the BB.
      const ops = ps.filter(p => p !== 'BB' && ps.indexOf('BB') - ps.indexOf(p) >= 2);
      if (!ops.length) throw RESTART;
      const op = pick(ops);
      const caller = pick(ps.slice(ps.indexOf(op) + 1, ps.indexOf('BB')));
      const open = Modes.openSize(C, op);
      const heroHand = Engine.sampleCombo(rangeFrom(Modes.vsOpenChart(C, 'BB', op), 'call'));
      const opps = [{ pos: op, range: rangeFrom(Modes.rfiChart(C, op), 'raise', new Set(heroHand)), live: true },
        { pos: caller, range: rangeFrom(Modes.vsOpenChart(C, caller, op), 'call', new Set(heroHand)), live: true }];
      log(tr(`${op} 加注 ${open}bb，${caller} 跟注，你（BB）跟注。`, `${op} raises ${open}bb, ${caller} calls, Hero (BB) calls.`));
      return { heroPos: 'BB', hero: heroHand, opps, potType, pot: 3 * open + deadOther(op, caller, 'BB'), stack: C.stack - open, invested: open,
        heroRange: rangeFrom(Modes.vsOpenChart(C, 'BB', op), 'call') };
    }
    if ((potType === '3bet' || potType === '4bet') && Modes.stackMode(C) === 'deep') {
      const [op, tb] = pickPair();
      const heroIsTb = Math.random() < 0.5;
      const T = Modes.vsOpenChart(C, tb, op).threebet;
      const heroPos = heroIsTb ? tb : op, vPos = heroIsTb ? op : tb;
      const heroChart = heroIsTb ? Modes.vsOpenChart(C, tb, op) : Modes.vs3betChart(C, op, tb);
      const heroAct = heroIsTb ? 'raise' : 'call';
      const vRange = heroIsTb ? rangeFrom(Modes.vs3betChart(C, op, tb), 'call') : rangeFrom(Modes.vsOpenChart(C, tb, op), 'raise');
      const heroR = rangeFrom(heroChart, heroAct);
      if (!heroR.length || !vRange.length) throw RESTART;
      const heroHand = Engine.sampleCombo(heroR);
      log(heroIsTb ? tr(`${op} 加注 ${Modes.openSize(C, op)}bb，你（${tb}）3-bet 到 ${T}bb，${op} 跟注。`, `${op} raises ${Modes.openSize(C, op)}bb, Hero (${tb}) 3-bets to ${T}bb, ${op} calls.`)
        : tr(`你（${op}）加注 ${Modes.openSize(C, op)}bb，${tb} 3-bet 到 ${T}bb，你跟注。`, `Hero (${op}) raises ${Modes.openSize(C, op)}bb, ${tb} 3-bets to ${T}bb, Hero calls.`));
      return { heroPos, villainPos: vPos, hero: heroHand, range: without(vRange, heroHand), potType: '3bet', pot: 2 * T + deadOther(op, tb), stack: C.stack - T, invested: T,
        heroRange: rangeFrom(heroChart, heroAct) };
    }
    // Single-raised pot.
    for (let t = 0; t < 50; t++) {
      if (Math.random() < 0.5) {
        const hero = pick(openers());
        const vil = pickResponder(hero, true);
        if (!vil) continue;
        const open = Modes.openSize(C, hero);
        const heroHand = Engine.sampleCombo(rangeFrom(Modes.rfiChart(C, hero), 'raise'));
        log(tr(`你（${hero}）加注 ${open}bb，${vil} 跟注。`, `Hero (${hero}) raises ${open}bb, ${vil} calls.`));
        return { heroPos: hero, villainPos: vil, hero: heroHand, range: rangeFrom(Modes.vsOpenChart(C, vil, hero), 'call', new Set(heroHand)), potType: 'srp',
          pot: 2 * open + deadOther(hero, vil), stack: C.stack - open, invested: open, heroRange: rangeFrom(Modes.rfiChart(C, hero), 'raise') };
      }
      const [op, hero] = pickPair();
      const ch = Modes.vsOpenChart(C, hero, op);
      if (ch.noCall) continue;
      const open = Modes.openSize(C, op);
      const heroHand = Engine.sampleCombo(rangeFrom(ch, 'call'));
      log(tr(`${op} 加注 ${open}bb，你（${hero}）跟注。`, `${op} raises ${open}bb, Hero (${hero}) calls.`));
      return { heroPos: hero, villainPos: op, hero: heroHand, range: rangeFrom(Modes.rfiChart(C, op), 'raise', new Set(heroHand)), potType: 'srp',
        pot: 2 * open + deadOther(hero, op), stack: C.stack - open, invested: open, heroRange: rangeFrom(ch, 'call') };
    }
    throw RESTART;
  }

  function finishSetup(h) {
    if (h.opps) {
      // Ranges only exclude hero's cards (hero can't see the other villain's hand).
      const dealt = new Set(h.hero);
      for (const o of h.opps) {
        o.range = without(o.range, h.hero);
        if (!o.range.length) throw RESTART;
        if (!o.vil) {
          const live = o.range.filter(c => !dealt.has(c.a) && !dealt.has(c.b));
          if (!live.length) throw RESTART;
          o.vil = Engine.sampleCombo(live);
        }
        o.vil.forEach(c => dealt.add(c));
      }
      h.heroIP = h.opps.every(o => Modes.heroIP(C, h.heroPos, o.pos));
    } else {
      if (!h.range || !h.range.length) throw RESTART;
      h.range = without(h.range, h.hero);
      if (!h.vil) h.vil = Engine.sampleCombo(h.range);
      h.heroIP = Modes.heroIP(C, h.heroPos, h.villainPos);
    }
    h.heroRange = without(h.heroRange || [], [...h.hero]);
    h.board = h.board || [];
    h.heroBet = h.vilBet = 0;
    h.hit = false;
    return h;
  }

  async function postflopDrill() {
    clearLog();
    log(STR.pre, 'street');
    if (Modes.stackMode(C) === 'push') {
      $('#feedback').innerHTML = `<p class="muted">${tr('当前筹码 ≤12bb，是纯推/弃阶段，没有翻后可练。请切换到「完整牌局」或「翻前练习」，或把筹码调到 13bb 以上。', 'At ≤12bb it is pure push/fold, so there is no postflop to practise. Switch to Full Hand or Preflop, or set the stack to 13bb or more.')}</p>`;
      setSituation(`${tr('推/弃阶段没有翻后。', 'No postflop in push/fold.')}<div class="handinfo">${modeDesc()}</div>`);
      await ask([{ id: 'switch', label: tr('切换到完整牌局', 'Switch to Full Hand'), key: 'Enter' }]);
      document.querySelector('#modes button[data-mode=full]').click();
      return;
    }
    const h = finishSetup({ board: [], ...setupDirect(choosePotType(true)) });
    return playPostflop(h);
  }

  async function fullHand() {
    clearLog();
    const mode = Modes.stackMode(C);
    log(STR.pre, 'street');
    if (mode === 'push') return pushHand();

    let line;
    for (let t = 0; t < 50 && !line; t++) {
      if (Math.random() < 0.5) {
        const hero = pick(openers());
        const vil = pickResponder(hero, false);
        if (vil) line = { type: 'rfi', hero, villain: vil, opener: hero };
      } else {
        const [op, hero] = pickPair();
        line = { type: 'vsOpen', hero, villain: op, opener: op };
      }
    }
    const h = { heroPos: line.hero, villainPos: line.villain, board: [], vil: null, stack: C.stack, potType: 'srp' };
    const open = Modes.openSize(C, line.opener);
    const fold = inv => { h.invested = inv; h.pot = 0; return endHand(h, 'fold'); };

    if (line.type === 'rfi') {
      const spot = rfiSpot(line.hero);
      h.hero = sampleHeroHand(spot.chart);
      Object.assign(h, { villainPos: 'BB', noOpp: true });
      const choice = await preflopDecision(h, spot);
      await contAfter();
      if (choice === 'fold') return fold(blind(line.hero));
      Object.assign(h, { villainPos: line.villain, noOpp: false });
      const ps = P(), after = ps.slice(ps.indexOf(line.hero) + 1), vi = after.indexOf(line.villain);
      if (vi > 0) log(tr(`${after.slice(0, vi).join('、')} 弃牌。`, `${after.slice(0, vi).join(', ')} fold.`));
      const vChart = Modes.vsOpenChart(C, line.villain, line.hero);
      h.vil = Engine.sampleCombo(Engine.buildRange(l => { const f = chartFreqs(vChart, l); return f.call + f.raise; }, new Set(h.hero)));
      const f = chartFreqs(vChart, labelOf(h.vil[0], h.vil[1]));
      const restFold = () => { if (vi < after.length - 1) log(tr(`${after.slice(vi + 1).join('、')} 弃牌。`, `${after.slice(vi + 1).join(', ')} fold.`)); };
      if (Math.random() * (f.call + f.raise) < f.raise) {
        if (mode === 'jam') {
          const s2 = await vsJamSpot(line.hero, line.villain);
          log(tr(`${line.villain} 全下 ${C.stack}bb。`, `${line.villain} shoves ${C.stack}bb.`));
          restFold();
          const c2 = await preflopDecision(h, s2, true);
          await contAfter();
          if (c2 === 'fold') return fold(open);
          return allinShowdown(h);
        }
        const s2 = vs3betSpot(line.hero, line.villain);
        log(tr(`${line.villain} 3-bet 到 ${s2.tbSize}bb。`, `${line.villain} 3-bets to ${s2.tbSize}bb.`));
        restFold();
        const c2 = await preflopDecision(h, s2, true);
        await contAfter();
        if (c2 === 'fold') return fold(open);
        const T = s2.tbSize, tbRange = rangeFrom(vChart, 'raise', new Set(h.hero));
        if (c2 === 'call') {
          Object.assign(h, { potType: '3bet', range: tbRange, pot: 2 * T + deadOther(line.hero, line.villain), stack: C.stack - T, invested: T,
            heroRange: rangeFrom(s2.chart, 'call') });
          return playPostflop(finishSetup(h));
        }
        // Hero 4-bets: the 3-bettor jams the top, calls some, folds the rest.
        const F = s2.fourbet;
        const [jam, r1] = Engine.cutW(tbRange, vScore, 0.3 * Engine.W(tbRange));
        const [call, foldR] = Engine.cutW(r1, vScore, 0.2 * Engine.W(tbRange));
        const act = Engine.member(h.vil, [['jam', jam], ['call', call], ['fold', foldR]]);
        if (act === 'fold' || F >= C.stack) {
          if (act === 'fold') { log(tr(`${line.villain} 弃牌。`, `${line.villain} folds.`)); h.pot = deadOther(line.hero, line.villain) + T + F; h.invested = F; return endHand(h, 'won'); }
          log(tr(`${line.villain} 跟注全下。`, `${line.villain} calls all-in.`));
          return allinShowdown(h);
        }
        if (act === 'call') {
          log(tr(`${line.villain} 跟注。`, `${line.villain} calls.`));
          Object.assign(h, { potType: '4bet', range: call, pot: 2 * F + deadOther(line.hero, line.villain), stack: C.stack - F, invested: F, heroRange: rangeFrom(s2.chart, 'raise') });
          return playPostflop(finishSetup(h));
        }
        log(tr(`${line.villain} 全下 ${C.stack}bb。`, `${line.villain} shoves ${C.stack}bb.`));
        const s3 = vsAllinSpot(line.hero, line.villain, F, jam, tr(`你 4-bet 到 ${F}bb，<b>${pn(line.villain)}</b> 全下 ${C.stack}bb。`, `You 4-bet to ${F}bb and <b>${pn(line.villain)}</b> shoves ${C.stack}bb.`), '');
        const c3 = await preflopDecision(h, s3, true);
        await contAfter();
        if (c3 === 'fold') return fold(F);
        return allinShowdown(h);
      }
      log(tr(`${line.villain} 跟注。`, `${line.villain} calls.`));
      // A second player (usually the BB) may overcall, creating a 3-way pot.
      const rest = after.slice(vi + 1);
      let second = null;
      if (rest.length && C.players >= 3) {
        const cand = rest.includes('BB') ? 'BB' : rest[rest.length - 1];
        const hand2 = randomHand(new Set([...h.hero, ...h.vil]));
        const f2 = chartFreqs(Modes.vsOpenChart(C, cand, line.hero), labelOf(hand2[0], hand2[1]));
        if (Math.random() < f2.call * 0.6) second = { pos: cand, vil: hand2 };
      }
      if (second) {
        for (const p of rest) if (p !== second.pos) log(tr(`${p} 弃牌。`, `${p} folds.`));
        log(tr(`${second.pos} 跟注。`, `${second.pos} calls.`));
        const mk = (pos, vil) => ({ pos, vil, range: rangeFrom(Modes.vsOpenChart(C, pos, line.hero), 'call', new Set(h.hero)), live: true });
        Object.assign(h, { potType: 'multi', opps: [mk(line.villain, h.vil), mk(second.pos, second.vil)], vil: null,
          pot: 3 * open + deadOther(line.hero, line.villain, second.pos), stack: C.stack - open, invested: open, heroRange: rangeFrom(spot.chart, 'raise') });
        return playPostflop(finishSetup(h));
      }
      restFold();
      Object.assign(h, { range: rangeFrom(vChart, 'call', new Set(h.hero)), pot: 2 * open + deadOther(line.hero, line.villain), stack: C.stack - open, invested: open,
        heroRange: rangeFrom(spot.chart, 'raise') });
      return playPostflop(finishSetup(h));
    }

    // Hero faces an open.
    const spot = vsOpenSpot(line.hero, line.villain);
    h.hero = sampleHeroHand(spot.chart);
    const oChart = Modes.rfiChart(C, line.villain);
    h.vil = Engine.sampleCombo(rangeFrom(oChart, 'raise', new Set(h.hero)));
    const choice = await preflopDecision(h, spot);
    await contAfter();
    if (choice === 'fold') return fold(blind(line.hero));
    if (choice === 'raise') {
      if (mode === 'jam') {
        const callCh = await comp('callVsShoveChart', C, `jam-${line.hero}v${line.villain}`, spot.chart._r, open, deadOther(line.hero, line.villain));
        if (Math.random() < chartFreqs(callCh, labelOf(h.vil[0], h.vil[1])).call) { log(tr(`${line.villain} 跟注全下。`, `${line.villain} calls all-in.`)); return allinShowdown(h); }
        h.pot = deadOther(line.hero, line.villain) + open + C.stack; h.invested = C.stack;
        log(tr(`${line.villain} 弃牌。`, `${line.villain} folds.`));
        return endHand(h, 'won');
      }
      // Opener responds to the 3-bet with its vs-3-bet chart.
      const T = spot.chart.threebet;
      const r3 = Modes.vs3betChart(C, line.villain, line.hero);
      const f = chartFreqs(r3, labelOf(h.vil[0], h.vil[1]));
      const u = Math.random();
      if (u < f.fold) { log(tr(`${line.villain} 弃牌。`, `${line.villain} folds.`)); h.pot = deadOther(line.hero, line.villain) + open + T; h.invested = T; return endHand(h, 'won'); }
      if (u < f.fold + f.call) {
        log(tr(`${line.villain} 跟注。`, `${line.villain} calls.`));
        Object.assign(h, { potType: '3bet', range: rangeFrom(r3, 'call', new Set(h.hero)), pot: 2 * T + deadOther(line.hero, line.villain), stack: C.stack - T, invested: T,
          heroRange: rangeFrom(spot.chart, 'raise') });
        return playPostflop(finishSetup(h));
      }
      const F = r3.fourbet || Math.min(C.stack, Math.round(T * 2.3));
      const range4 = rangeFrom(r3, 'raise', new Set(h.hero));
      const s4 = vs4betSpot(line.hero, line.villain, T, F, range4);
      const c4 = await preflopDecision(h, s4);
      await contAfter();
      if (c4 === 'fold') return fold(T);
      if (c4 === 'call') {
        Object.assign(h, { potType: '4bet', range: range4, pot: 2 * F + deadOther(line.hero, line.villain), stack: C.stack - F, invested: F, heroRange: rangeFrom(spot.chart, 'raise') });
        return playPostflop(finishSetup(h));
      }
      const [callers, folders] = Engine.cutW(range4, vScore, 0.6 * Engine.W(range4));
      if (Engine.member(h.vil, [['call', callers], ['fold', folders]]) === 'fold') {
        log(tr(`${line.villain} 弃牌。`, `${line.villain} folds.`)); h.pot = deadOther(line.hero, line.villain) + F + C.stack; h.invested = C.stack; return endHand(h, 'won');
      }
      log(tr(`${line.villain} 跟注全下。`, `${line.villain} calls all-in.`));
      return allinShowdown(h);
    }
    // Hero called: the BB may overcall when hero isn't the BB.
    const ps = P();
    if (line.hero !== 'BB' && ps.includes('BB') && line.villain !== 'BB' && C.players >= 3) {
      const hand2 = randomHand(new Set([...h.hero, ...h.vil]));
      const f2 = chartFreqs(Modes.vsOpenChart(C, 'BB', line.villain), labelOf(hand2[0], hand2[1]));
      if (Math.random() < f2.call * 0.6) {
        log(tr('BB 跟注。', 'BB calls.'));
        const opps = [{ pos: line.villain, vil: h.vil, range: rangeFrom(oChart, 'raise', new Set(h.hero)), live: true },
          { pos: 'BB', vil: hand2, range: rangeFrom(Modes.vsOpenChart(C, 'BB', line.villain), 'call', new Set(h.hero)), live: true }];
        Object.assign(h, { potType: 'multi', opps, vil: null, pot: 3 * open + deadOther(line.hero, line.villain, 'BB'), stack: C.stack - open, invested: open,
          heroRange: rangeFrom(spot.chart, 'call') });
        return playPostflop(finishSetup(h));
      }
    }
    Object.assign(h, { range: rangeFrom(oChart, 'raise', new Set(h.hero)), pot: 2 * open + deadOther(line.hero, line.villain), stack: C.stack - open, invested: open,
      heroRange: rangeFrom(spot.chart, 'call') });
    return playPostflop(finishSetup(h));
  }

  async function pushHand() {
    if (Math.random() < 0.5) {
      const hero = pick(openers());
      const spot = rfiSpot(hero);
      const h = { heroPos: hero, villainPos: 'BB', noOpp: true, heroIP: false, board: [], vil: null, hero: sampleHeroHand(spot.chart) };
      const choice = await preflopDecision(h, spot);
      await contAfter();
      if (choice === 'fold') { h.invested = blind(hero); h.pot = 0; return endHand(h, 'fold'); }
      const ps = P();
      const dead = new Set(h.hero);
      for (const v of ps.slice(ps.indexOf(hero) + 1)) {
        const hand = randomHand(dead);
        hand.forEach(c => dead.add(c));
        const ch = await comp('callVsShoveChart', C, 'push-' + hero, spot.chart._r, blind(v), deadOther(hero, v));
        if (Math.random() < chartFreqs(ch, labelOf(hand[0], hand[1])).call) {
          h.villainPos = v; h.vil = hand; h.noOpp = false;
          log(tr(`${v} 跟注全下。`, `${v} calls all-in.`));
          return allinShowdown(h);
        }
        log(tr(`${v} 弃牌。`, `${v} folds.`));
      }
      h.pot = Modes.deadTotal(C) - blind(hero) + C.stack; h.invested = C.stack;
      return endHand(h, 'won');
    }
    const [pusher, hero] = pickPair();
    const spot = await vsPushSpot(hero, pusher);
    const h = { heroPos: hero, villainPos: pusher, heroIP: false, board: [], hero: sampleHeroHand(spot.chart) };
    h.vil = Engine.sampleCombo(Modes.rangeOf(spot.pushMap, new Set(h.hero)));
    const choice = await preflopDecision(h, spot);
    await contAfter();
    if (choice === 'fold') { h.invested = blind(hero); h.pot = 0; return endHand(h, 'fold'); }
    return allinShowdown(h);
  }

  async function preflopDrill() {
    clearLog();
    setSituation(SPIN + tr('计算中…', 'Thinking…'));
    const spot = await randomPreflopSpot();
    const h = { heroPos: spot.hero, villainPos: spot.villain, noOpp: spot.kind === 'rfi' || spot.kind === 'push', hero: sampleHeroHand(spot.chart), board: [] };
    await preflopDecision(h, spot);
    stats.hands++;
    saveStats();
    await ask([{ id: 'next', label: tr('下一手 ▸', 'Next hand ▸'), key: 'Enter' }]);
    newHand();
  }

  // ---------- review & stats views ----------
  const ratingRank = { blunder: 0, inacc: 1, good: 2, best: 3 };
  function showView(which) {
    $('#play-area').hidden = which !== 'play';
    $('#review-area').hidden = which !== 'review';
    $('#stats-area').hidden = which !== 'stats';
    if (which === 'review') $('#feedback').innerHTML = `<p class="muted">${tr('点「重做」重新练习一道题，或「按顺序重做失误」连续练习。重做结果会计入统计，但不会重复写进错题本。', 'Click "Redo" to retry one spot, or "Redo mistakes in order" to go through them. Redos count toward stats but are not added to the log again.')}</p>`;
    if (which === 'stats') $('#feedback').innerHTML = `<p class="muted">${tr('统计按街、局面、牌力、底池类型、位置分类。准确率 = 评为「最佳」或「良好」的比例。', 'Stats are split by street, situation, hand strength, pot type and position. Accuracy = share of decisions rated Best or Good.')}</p>`;
  }

  function renderReview() {
    showView('review');
    const onlyMistakes = $('#review-filter') ? $('#review-filter').value : 'mistakes';
    const list = reviews.map((r, i) => ({ r, i })).filter(({ r }) => onlyMistakes === 'all' || ratingRank[r.rating] <= 1);
    const rows = list.slice(0, 150).map(({ r, i }) => `
      <tr data-i="${i}">
        <td><span class="rating ${r.rating}">${ratingText(r.rating)}</span>${r.redo ? ` <span class="near">${tr('重做', 'redo')}: ${ratingText(r.redo)}</span>` : ''}</td>
        <td>${STR[r.st]}${r.sit !== 'pre' ? ' · ' + SIT[r.sit] : ''}</td>
        <td>${r.heroPos} vs ${r.villainPos}</td>
        <td>${miniCards(r.hero)}${r.board.length ? '<span class="muted"> | </span>' + miniCards(r.board) : ''}</td>
        <td>${r.options.find(o => o.id === r.chosen).label} → <b>${r.options.find(o => o.id === r.best).label}</b></td>
        <td class="mono">${r.loss !== null ? '−' + r.loss.toFixed(2) + 'bb' : '-'}</td>
        <td><button class="redo" data-i="${i}">${tr('重做', 'Redo')}</button></td>
      </tr>`).join('');
    $('#review-area').innerHTML = `
      <div class="view-head"><h3>${tr(`错题本（最近 ${reviews.length} 个决策）`, `Review (last ${reviews.length} decisions)`)}</h3>
        <select id="review-filter"><option value="mistakes">${tr('只看失误（不精确 + 严重失误）', 'Mistakes only (inaccuracies + blunders)')}</option><option value="all">${tr('全部决策', 'All decisions')}</option></select>
        <button id="redo-next">${tr('按顺序重做失误', 'Redo mistakes in order')}</button>
        <button id="clear-review">${tr('清空错题本', 'Clear review log')}</button></div>
      ${list.length ? `<table class="list"><thead><tr><th>${tr('评分', 'Rating')}</th><th>${tr('街', 'Street')}</th><th>${tr('位置', 'Position')}</th><th>${tr('手牌 | 公共牌', 'Hand | board')}</th><th>${tr('你的选择 → 最佳', 'Your choice → best')}</th><th>${tr('EV 损失', 'EV loss')}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="empty"><b>${reviews.length ? tr('没有失误，干得好', 'No mistakes — nice work') : tr('还没有记录', 'Nothing here yet')}</b>${reviews.length ? tr('把上面的筛选改成「全部决策」可以查看所有记录。', 'Switch the filter above to "All decisions" to see everything.') : tr('去「完整牌局」或「翻后练习」打几手，评分后的决策都会出现在这里。', 'Play a few hands in Full Hand or Postflop; graded decisions show up here.')}</div>`}`;
    $('#review-filter').value = onlyMistakes;
    $('#review-filter').onchange = renderReview;
    $('#clear-review').onclick = () => { if (confirm(tr('确定清空错题本吗？', 'Clear the review log?'))) { reviews = []; save('gto-trainer-review', reviews); renderReview(); } };
    $('#redo-next').onclick = () => { const q = list.map(x => x.i); if (q.length) replay(q, 0); };
    document.querySelectorAll('#review-area .redo').forEach(b => b.onclick = () => replay([Number(b.dataset.i)], 0));
  }

  async function replay(queue, k) {
    const rec = reviews[queue[k]];
    if (!rec) return renderReview();
    showView('play');
    clearLog();
    C = rec.cfg;
    const h = { heroPos: rec.heroPos, villainPos: rec.oppPos.length ? rec.oppPos[0] : rec.villainPos, hero: rec.hero, board: rec.board, pot: rec.pot, stack: rec.stack,
      heroBet: rec.heroBet, vilBet: rec.vilBet, noOpp: rec.noOpp };
    if (rec.oppPos.length > 1) h.opps = rec.oppPos.map(pos => ({ pos, live: true }));
    renderTable(h);
    log(tr(`错题重做（${k + 1}/${queue.length}）`, `Redo (${k + 1}/${queue.length})`), 'street');
    setSituation(`${rec.prompt}<div class="handinfo">${tr('错题重做', 'Redo')} · ${rec.desc}</div>`, rec.board.length ? h : undefined);
    $('#feedback').innerHTML = `<p class="muted">${tr('重新思考这个局面，然后做出选择。', 'Think the spot through again, then choose.')}</p>`;
    const choice = await ask(rec.options.map(o => ({ id: o.id, label: o.label, key: o.key })));
    const again = { ...rec, chosen: choice, replay: true, t: Date.now() };
    if (rec.options[0].ev !== undefined) {
      const best = rec.options.find(o => o.id === rec.best);
      again.loss = best.ev - rec.options.find(o => o.id === choice).ev;
      again.rating = rateLoss(again.loss, rec.potRef);
      setFeedback(evFeedbackHTML(again));
    } else {
      const maxF = Math.max(...rec.options.map(o => o.freq)), cf = rec.options.find(o => o.id === choice).freq;
      again.rating = cf >= maxF - 1e-9 ? 'best' : cf >= 0.25 ? 'good' : cf >= 0.05 ? 'inacc' : 'blunder';
      again.loss = null;
      const spot = await spotFromRef(rec.ref);
      setFeedback(freqFeedbackHTML(again, spot && spot.chart ? chartGrid(spot.chart, rec.label) : ''));
    }
    recordDecision(again);
    rec.redo = again.rating;
    save('gto-trainer-review', reviews);
    const btns = [{ id: 'back', label: tr('返回错题本', 'Back to review'), key: 'b' }];
    if (k + 1 < queue.length) btns.unshift({ id: 'next', label: tr('下一道 ▸', 'Next ▸'), key: 'Enter' });
    const c = await ask(btns);
    if (c === 'next') return replay(queue, k + 1);
    renderReview();
  }

  function renderStatsView() {
    showView('stats');
    const DIMS = [
      ['street', tr('按街', 'By street'), v => STR[v] || v], ['sit', tr('按局面', 'By situation'), v => SIT[v] || v], ['cls', tr('按牌力（翻后）', 'By hand strength (postflop)'), v => Classify.NAMES[v] || v],
      ['pot', tr('按底池类型', 'By pot type'), v => POTS[v] || v], ['pos', tr('按你的位置', 'By your position'), v => `${v} ${(POS_INFO[v] || [''])[0]}`], ['game', tr('按游戏类型', 'By game'), v => (v === 'cash' ? tr('现金局', 'Cash') : 'MTT')],
    ];
    const allRows = [];
    const tables = DIMS.map(([dim, title, name]) => {
      const b = stats.by[dim] || {};
      const rows = Object.entries(b).filter(([k]) => k !== '-').sort((x, y) => y[1].n - x[1].n).map(([k, e]) => {
        const acc = e.n ? e.ok / e.n : 0, avg = e.nEv ? e.loss / e.nEv : null;
        if (e.n >= 5) allRows.push({ label: `${title.replace(/^按|^By /, '')}: ${name(k)}`, acc, avg, n: e.n });
        return `<tr><td>${name(k)}</td><td class="mono">${e.n}</td><td><div class="accbar"><div style="width:${acc * 100}%"></div></div><span class="mono">${pct(acc)}</span></td>
          <td class="mono">${avg === null ? '-' : avg.toFixed(2) + 'bb'}</td></tr>`;
      }).join('');
      return `<div class="stat-card"><h4>${title}</h4>${rows ? `<table class="list"><thead><tr><th></th><th>${tr('决策', 'Decisions')}</th><th>${tr('准确率', 'Accuracy')}</th><th>${tr('平均 EV 损失', 'Avg EV loss')}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">${tr('暂无数据', 'No data yet')}</p>`}</div>`;
    }).join('');
    const weak = allRows.sort((a, b) => a.acc - b.acc).slice(0, 3);
    const acc = stats.decisions ? (stats.best + stats.good) / stats.decisions : 0;
    const kpis = [
      [stats.hands, tr('手数', 'Hands')], [stats.decisions, tr('评分决策', 'Graded decisions')], [pct(acc), tr('准确率（最佳+良好）', 'Accuracy (best + good)')],
      [`${(stats.postN ? stats.evLoss / stats.postN : 0).toFixed(2)}bb`, tr('平均 EV 损失', 'Avg EV loss')], [stats.best, tr('最佳', 'Best')], [`${sgn(stats.net)}bb`, tr('净盈亏（含运气）', 'Net result (incl. luck)')],
    ].map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
    $('#stats-area').innerHTML = `
      <div class="view-head"><h3>${tr('统计', 'Stats')}</h3>
        <button id="export-hh">${tr('导出手牌记录 (.txt)', 'Export hand history (.txt)')}</button><button id="export-csv">${tr('导出决策 (.csv)', 'Export decisions (.csv)')}</button></div>
      <div class="kpis">${kpis}</div>
      ${stats.decisions ? '' : `<div class="empty"><b>${tr('还没有数据', 'No data yet')}</b>${tr('打几手之后，这里会按街、局面、牌力等维度显示你的准确率和最弱项。', 'After a few hands this shows your accuracy and weakest areas by street, situation, hand strength and more.')}</div>`}
      ${weak.length ? `<div class="tip">${tr(`<b>最需要练的：</b>${weak.map(w => `${w.label}（准确率 ${pct(w.acc)}，${w.n} 次）`).join('；')}。可以用左侧「练习筛选」专门练这些局面。`,
        `<b>Work on these first:</b> ${weak.map(w => `${w.label} (accuracy ${pct(w.acc)}, ${w.n} decisions)`).join('; ')}. Use the Spot filter on the left to drill them.`)}</div>` : ''}
      ${stats.decisions ? `<div class="stat-grid">${tables}</div>` : ''}`;
    $('#export-hh').onclick = exportHH;
    $('#export-csv').onclick = exportCSV;
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportHH() {
    const txt = histories.slice().reverse().map((x, i) => `#${i + 1}  ${new Date(x.t).toLocaleString()}  ${x.desc}\n${tr('手牌', 'Hand')}: ${x.hero}  ${tr('结果', 'Result')}: ${sgn(x.net)}bb\n${x.lines.map(l => '  ' + l).join('\n')}\n`).join('\n');
    download(`hand-history-${Date.now()}.txt`, txt || tr('暂无记录', 'No hands recorded yet'), 'text/plain;charset=utf-8');
  }
  function exportCSV() {
    const head = 'time,format,street,situation,pot_type,hand_class,position,vs,hand,board,chosen,best,rating,ev_loss_bb\n';
    const esc = s => `"${String(s).replace(/"/g, '""')}"`;
    const rows = reviews.map(r => [new Date(r.t).toISOString(), r.desc, r.st, r.sit, r.potType, r.cls || '', r.heroPos, r.villainPos, cstr(r.hero), cstr(r.board),
      r.options.find(o => o.id === r.chosen).label, r.options.find(o => o.id === r.best).label, r.rating, r.loss === null ? '' : r.loss.toFixed(3)].map(esc).join(',')).join('\n');
    download(`decisions-${Date.now()}.csv`, '﻿' + head + rows, 'text/csv;charset=utf-8');
  }

  // ---------- main loop ----------
  let restarts = 0;
  function newHand() {
    gen++;
    pending = null;
    curH = null;
    handDecisions = [];
    curHH = [];
    if (mode === 'review') return renderReview();
    if (mode === 'stats') return renderStatsView();
    showView('play');
    C = handCfg();
    $('#actions').innerHTML = '';
    $('#hint-panel').innerHTML = '';
    $('#cfg-status').textContent = modeDesc();
    const run = mode === 'preflop' ? preflopDrill : mode === 'postflop' ? postflopDrill : fullHand;
    run().then(() => { restarts = 0; }, async e => {
      if (e === RESTART) {
        if (++restarts > 150) {
          restarts = 0;
          setSituation(tr('连续 150 手都没有遇到符合筛选条件的局面，请放宽筛选条件（比如把「街」或「牌力」设为任意）。', 'No matching spot in 150 hands — loosen the filter (e.g. set Street or Hand strength to Any).'));
          await ask([{ id: 'next', label: tr('再试一次', 'Try again'), key: 'Enter' }]);
        }
        return newHand();
      }
      if (e === SPOT_DONE) { restarts = 0; return newHand(); }
      throw e;
    });
  }

  function syncSettingsUI() {
    $('#cfg-game').value = cfg.game;
    $('#cfg-players').value = cfg.players;
    $('#cfg-stack').value = cfg.stack;
    $('#cfg-stage').value = cfg.stage;
    const mtt = cfg.game === 'mtt';
    $('#cfg-stack').hidden = !mtt;
    $('#cfg-stage').hidden = !mtt;
    for (const k of Object.keys(DEFAULT_FILTER)) $('#flt-' + k).value = filter[k];
    $('#filter-box').classList.toggle('on', Object.values(filter).some(v => v !== 'any'));
  }
  ['game', 'players', 'stack', 'stage'].forEach(k => $('#cfg-' + k).onchange = e => {
    const v = e.target.value;
    cfg[k] = k === 'game' || k === 'stage' ? v : Number(v);
    if (k === 'game' && v === 'mtt' && cfg.stack === 100) cfg.stack = 30;
    save('gto-trainer-cfg', cfg);
    syncSettingsUI();
    e.target.blur();
    if (!['review', 'stats'].includes(mode)) newHand();
  });
  Object.keys(DEFAULT_FILTER).forEach(k => $('#flt-' + k).onchange = e => {
    filter[k] = e.target.value;
    save('gto-trainer-filter', filter);
    syncSettingsUI();
    e.target.blur();
    if (mode !== 'postflop') document.querySelector('#modes button[data-mode=postflop]').click();
    else newHand();
  });
  $('#flt-reset').onclick = () => { filter = { ...DEFAULT_FILTER }; save('gto-trainer-filter', filter); syncSettingsUI(); if (mode === 'postflop') newHand(); };
  syncSettingsUI();

  function selectMode(b) {
    document.querySelectorAll('#modes button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    mode = b.dataset.mode;
    $('#tab-name').textContent = tabLabel(b);
    prefs.mode = mode;
    save('gto-trainer-prefs', prefs);
  }
  document.querySelectorAll('#modes button').forEach(b => b.onclick = () => { selectMode(b); newHand(); });
  $('#new-hand').onclick = newHand;
  $('#export-btn').onclick = () => { closeOverlays(); exportHH(); };
  $('#reset-stats').onclick = () => {
    closeOverlays();
    if (confirm(tr('确定重置所有统计数据吗？（错题本保留）', 'Reset all stats? (The review log is kept.)'))) { stats = blank(); saveStats(); recent.length = 0; save('gto-trainer-recent', recent); renderRecent(); toast(tr('统计已重置', 'Stats reset')); }
  };
  $('#hints').onchange = () => { if (curH) renderHints(curH); };

  // Language: static text swaps via data-en; dynamic text re-renders on the next draw.
  function applyLang() {
    I18N.applyStatic();
    $('#lang').value = I18N.lang;
    applyPrefs();
    renderStats();
    renderRecent();
  }
  $('#lang').onchange = e => {
    I18N.lang = e.target.value;
    prefs.lang = I18N.lang;
    save('gto-trainer-prefs', prefs);
    e.target.blur();
    applyLang();
    newHand();
  };

  // Last-resort recovery: any uncaught error or rejected promise ends the hand cleanly instead of
  // leaving dead buttons, and offers a fresh hand.
  let crashShown = false;
  function recover(err) {
    console.error(err);
    if (crashShown) return;
    crashShown = true;
    gen++;
    pending = null;
    const msg = String((err && (err.message || err)) || '').replace(/[<>&]/g, '').slice(0, 160);
    if (['review', 'stats'].includes(mode)) { toast(tr('出了点问题，请重试。', 'Something went wrong — please try again.')); crashShown = false; return; }
    showView('play');
    $('#situation').innerHTML = `<b>${tr('出了点问题，这一手无法继续。', 'Something went wrong and this hand can’t continue.')}</b>`
      + `<div class="handinfo">${tr('你的统计和错题本不受影响。', 'Your stats and review log are safe.')}${msg ? ` · ${msg}` : ''}</div>`;
    ask([{ id: 'next', label: tr('开始新的一手', 'Start a new hand'), key: 'Enter' }]).then(() => { crashShown = false; newHand(); });
  }
  window.addEventListener('error', e => recover(e.error || e.message));
  window.addEventListener('unhandledrejection', e => recover(e.reason));

  applyPrefs();
  applyLang();
  const startBtn = prefs.mode && document.querySelector(`#modes button[data-mode=${prefs.mode}]`);
  if (startBtn) selectMode(startBtn);
  newHand();
  if (!prefs.seenHelp) { prefs.seenHelp = true; save('gto-trainer-prefs', prefs); $('#help').hidden = false; }
})();
