// Game-format model: positions, blinds/antes, sizings, ICM, and range generation for any
// cash/MTT, 2-9 player, stack-depth combination. 6-max 100bb cash uses the hand-tuned CHARTS.
const Modes = (() => {
  const POS_SETS = {
    2: ['BTN', 'BB'],
    3: ['BTN', 'SB', 'BB'],
    4: ['CO', 'BTN', 'SB', 'BB'],
    5: ['HJ', 'CO', 'BTN', 'SB', 'BB'],
    6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    7: ['UTG', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    8: ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  };
  // Open widths by number of players left to act behind the opener (cash, 100bb, no ante).
  const OPEN_CASH = { 1: 0.42, 2: 0.48, 3: 0.30, 4: 0.22, 5: 0.175, 6: 0.145, 7: 0.125, 8: 0.11 };
  // Approximate Nash shove widths at 10bb with a BB ante.
  const PUSH10 = { 1: 0.60, 2: 0.42, 3: 0.30, 4: 0.23, 5: 0.19, 6: 0.16, 7: 0.14, 8: 0.125 };

  const positions = cfg => POS_SETS[cfg.players];
  const isHU = cfg => cfg.players === 2;
  const blindOf = (cfg, pos) => (isHU(cfg) ? { BTN: 0.5, BB: 1 } : { SB: 0.5, BB: 1 })[pos] || 0;
  const ante = cfg => (cfg.game === 'mtt' ? 1 : 0);
  const deadTotal = cfg => 1.5 + ante(cfg);
  const behind = (cfg, pos) => { const p = positions(cfg); return p.length - 1 - p.indexOf(pos); };
  const isBlind = (cfg, pos) => blindOf(cfg, pos) > 0;
  function postIdx(cfg, pos) {
    if (isHU(cfg)) return pos === 'BB' ? 0 : 1;
    if (pos === 'SB') return 0;
    if (pos === 'BB') return 1;
    return 2 + positions(cfg).indexOf(pos);
  }
  const heroIP = (cfg, hero, vil) => postIdx(cfg, hero) > postIdx(cfg, vil);
  function stackMode(cfg) {
    if (cfg.game === 'cash') return 'deep';
    if (cfg.stack <= 12) return 'push';
    if (cfg.stack <= 25) return 'jam';
    return 'deep';
  }
  function openSize(cfg, pos) {
    if (cfg.game === 'cash') return pos === 'SB' && !isHU(cfg) ? 3 : 2.5;
    return cfg.stack <= 25 ? 2 : 2.2;
  }
  // Bubble factor from a Malmuth-Harville ICM model of the stage's payouts (1 = chip EV).
  const icmL = cfg => ICM.bubbleFactor(cfg);
  // Preflop ranges tighten as the bubble factor grows.
  const icmTight = cfg => Math.max(0.65, Math.min(1, 1 - 0.22 * (icmL(cfg) - 1)));
  const useHandCharts = cfg => cfg.game === 'cash' && cfg.players === 6;

  // Hand-strength scores: all-in equity for short stacks, playability (suited/connected/pairs) deep.
  const PLAY = {};
  for (const l of ALL_LABELS) {
    const r1 = RANKS.indexOf(l[0]), r2 = RANKS.indexOf(l[1]);
    let s = EQ_RANDOM[l];
    if (r1 === r2) s += 0.03;
    else {
      const suited = l[2] === 's', gap = r1 - r2 - 1;
      if (suited) s += 0.04 + (gap === 0 ? 0.04 : gap === 1 ? 0.025 : gap === 2 ? 0.012 : 0);
      else s += (gap === 0 ? 0.012 : 0) - (r2 < 8 ? 0.025 : 0);
    }
    PLAY[l] = s;
  }
  const allinScore = l => EQ_RANDOM[l];
  // Value 3-bet/4-bet ordering: big pairs plus big broadways (AK/AQ block and dominate).
  const valueScore = l => EQ_RANDOM[l] + (l[0] !== l[1] && RANKS.indexOf(l[1]) >= 9 ? 0.06 : 0) + (l.startsWith('AK') ? 0.075 : 0);
  function scoreFn(cfg) {
    const w = cfg.game === 'cash' ? 0 : Math.max(0, Math.min(1, (60 - cfg.stack) / 45));
    return l => w * EQ_RANDOM[l] + (1 - w) * PLAY[l];
  }

  // Takes the top `target` fraction of all 1326 combos by score, with a blended mixing band at the edge.
  function topRange(score, target, within) {
    const list = ALL_LABELS.filter(l => !within || within[l] > 0).sort((a, b) => score(b) - score(a));
    const out = {};
    if (target <= 0) return out;
    const band = Math.max(0.004, target * 0.12);
    let cum = 0;
    for (const l of list) {
      const w = (within ? within[l] : 1) * combosOf(l).length / 1326;
      const mid = cum + w / 2;
      cum += w;
      const f = Math.round(Math.max(0, Math.min(1, (target + band - mid) / (2 * band))) * 20) / 20;
      if (f > 0) out[l] = f;
    }
    return out;
  }
  // Bluff 3-bets/4-bets come from suited hands that would otherwise call: wheel aces first, then the best suited playables.
  function addBluffs(raise, call, candidates, score, amount) {
    const wheel = l => l[0] === 'A' && RANKS.indexOf(l[1]) <= 3;
    const suitedCalls = candidates.filter(l => l[2] === 's' && !(raise[l] > 0) && call[l] > 0).sort((a, b) => score(b) - score(a));
    const keepAsCalls = new Set(suitedCalls.slice(0, Math.floor(suitedCalls.length * 0.3)).filter(l => !wheel(l)));
    const list = suitedCalls.filter(l => !keepAsCalls.has(l)).sort((a, b) => wheel(b) - wheel(a) || score(b) - score(a));
    let got = 0;
    for (const l of list) {
      if (got >= amount) break;
      const f = wheel(l) ? 1 : 0.5;
      raise[l] = f;
      got += (4 * f) / 1326;
    }
  }

  const cache = {};
  const ck = (cfg, ...k) => [cfg.game, cfg.players, cfg.stack, cfg.stage, ...k].join('|');

  function openPct(cfg, pos) {
    const k = behind(cfg, pos);
    let base = isHU(cfg) ? 0.8 : OPEN_CASH[k];
    if (stackMode(cfg) === 'push') base = (isHU(cfg) ? 0.7 : PUSH10[k]) * Math.pow(10 / cfg.stack, 0.7);
    else if (cfg.game === 'mtt') base *= isHU(cfg) ? 1.06 : k >= 3 ? 1.15 : 1.12;
    return Math.min(1, base * icmTight(cfg));
  }

  function rfiChart(cfg, pos) {
    if (useHandCharts(cfg) && CHARTS.rfi[pos]) return CHARTS.rfi[pos];
    const key = ck(cfg, 'rfi', pos);
    if (cache[key]) return cache[key];
    const sc = stackMode(cfg) === 'push' ? allinScore : scoreFn(cfg);
    return (cache[key] = { _r: topRange(sc, openPct(cfg, pos)), _c: {} });
  }

  function threebetSize(cfg, hero, opener) {
    if (stackMode(cfg) === 'jam') return cfg.stack;
    const o = openSize(cfg, opener);
    const mult = cfg.game === 'cash' ? (isBlind(cfg, hero) ? 4.4 : 3) : (isBlind(cfg, hero) ? 3.6 : 2.8);
    return Math.min(cfg.stack, Math.round(o * mult * 2) / 2);
  }

  function vsOpenChart(cfg, hero, opener) {
    const hk = `${hero}v${opener}`;
    if (useHandCharts(cfg) && CHARTS.vsOpen[hk]) return CHARTS.vsOpen[hk];
    const key = ck(cfg, 'vso', hk);
    if (cache[key]) return cache[key];
    const o = openPct(cfg, opener), mode = stackMode(cfg), t = icmTight(cfg), mtt = cfg.game === 'mtt';
    let cont, tb;
    if (hero === 'BB') {
      cont = Math.min(mtt ? 0.85 : 0.75, mtt ? 1.2 * o + 0.05 : 1.05 * o + 0.015);
      tb = mtt ? 0.15 * o : 0.17 * o + 0.005;
    } else if (hero === 'SB' && !isHU(cfg)) {
      cont = (mtt ? 0.35 : 0.3) * o;
      tb = mtt ? 0.6 * cont : cont;
    } else {
      // Fit to 6-max solver data: BTN continues ~60% vs a 17% open, ~49% vs a 32% open; earlier seats tighter.
      cont = o * Math.max(0.3, 0.75 - 0.8 * o) * (hero === 'BTN' ? 1 : 0.8);
      tb = 0.4 * cont;
    }
    cont *= t; tb *= t;
    const sc = scoreFn(cfg);
    let raise, call;
    if (mode === 'jam') {
      tb = Math.max(tb, 0.55 * cont);
      raise = topRange(allinScore, tb);
      call = tb >= cont - 1e-9 ? {} : topRange(sc, cont);
    } else {
      raise = topRange(valueScore, 0.6 * tb);
      call = tb >= cont - 1e-9 ? {} : topRange(sc, cont);
      addBluffs(raise, call, ALL_LABELS, sc, 0.4 * tb);
    }
    return (cache[key] = { _r: raise, _c: call, noCall: Object.keys(call).length === 0, threebet: threebetSize(cfg, hero, opener) });
  }

  function vs3betChart(cfg, hero, tbPos) {
    const hk = `${hero}v${tbPos}`;
    if (useHandCharts(cfg) && CHARTS.vs3bet[hk]) return CHARTS.vs3bet[hk];
    const key = ck(cfg, 'v3', hk);
    if (cache[key]) return cache[key];
    const openMap = rfiChart(cfg, hero)._r || parseRange(rfiChart(cfg, hero).raise);
    const O = Object.entries(openMap).reduce((s, [l, f]) => s + f * combosOf(l).length, 0) / 1326;
    const t = icmTight(cfg), sc = scoreFn(cfg);
    const cont = O * (heroIP(cfg, hero, tbPos) ? 0.45 : 0.38) * t;
    const fb = O * 0.11 * t;
    const raise = topRange(valueScore, 0.7 * fb, openMap);
    const call = topRange(l => 0.5 * sc(l) + 0.5 * valueScore(l), cont, openMap);
    addBluffs(raise, call, Object.keys(openMap), sc, 0.3 * fb);
    const open = openSize(cfg, hero), threebet = threebetSize(cfg, tbPos, hero);
    return (cache[key] = { _r: raise, _c: call, open, threebet, fourbet: Math.min(cfg.stack, Math.round(threebet * 2.3)) });
  }

  // ---------- all-in equity maths ----------
  function eqVsRange(hand, range, trials) {
    const valid = range.filter(c => c.a !== hand[0] && c.a !== hand[1] && c.b !== hand[0] && c.b !== hand[1]);
    const tot = valid.reduce((s, c) => s + c.w, 0);
    if (!tot) return 0.5;
    const cum = [];
    let acc = 0;
    for (const c of valid) cum.push((acc += c.w));
    let win = 0;
    const cards = new Array(7), vc = new Array(7);
    for (let t = 0; t < trials; t++) {
      const u = Math.random() * tot;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; }
      const v = valid[lo];
      const used = [hand[0], hand[1], v.a, v.b];
      for (let i = 0; i < 5; i++) {
        let c;
        do { c = Math.floor(Math.random() * 52); } while (used.includes(c));
        used.push(c);
        cards[2 + i] = vc[2 + i] = c;
      }
      cards[0] = hand[0]; cards[1] = hand[1]; vc[0] = v.a; vc[1] = v.b;
      const h = evalHand(cards), o = evalHand(vc);
      win += h > o ? 1 : h === o ? 0.5 : 0;
    }
    return win / trials;
  }

  // EV (bb, relative to folding) of being all-in for `S` total having already put in `heroIn`.
  function allinEV(eq, S, heroIn, deadOther, L) {
    const pot = 2 * S + deadOther;
    return eq * (pot - S + heroIn) - (1 - eq) * (S - heroIn) * L;
  }

  const rangeOf = (map, dead = new Set()) => Engine.buildRange(l => map[l] || 0, dead);

  // Label-level equities vs a shove range (coarse MC), reused for every caller's chart.
  function labelEqs(cfg, key, pushMap) {
    const k = ck(cfg, 'leq', key);
    if (cache[k]) return cache[k];
    const range = rangeOf(pushMap);
    const out = {};
    for (const l of ALL_LABELS) {
      const cs = combosOf(l);
      out[l] = eqVsRange(cs[0], range, 250) * 0.5 + eqVsRange(cs[cs.length - 1], range, 250) * 0.5;
    }
    return (cache[k] = out);
  }

  // Calling range vs an all-in, derived from EV given pot odds and ICM.
  function callVsShoveChart(cfg, key, pushMap, callerIn, deadOther) {
    const k = ck(cfg, 'cvs', key, callerIn, deadOther);
    if (cache[k]) return cache[k];
    const eqs = labelEqs(cfg, key, pushMap), L = icmL(cfg), call = {};
    for (const l of ALL_LABELS) {
      const ev = allinEV(eqs[l], cfg.stack, callerIn, deadOther, L);
      const f = ev > 0.15 ? 1 : ev < -0.15 ? 0 : 0.5;
      if (f > 0) call[l] = f;
    }
    return (cache[k] = { _r: {}, _c: call });
  }

  // EV of shoving `hand` from `pos`: each player behind calls with their EV-derived range.
  function shoveEV(cfg, pos, hand) {
    const S = cfg.stack, L = icmL(cfg), pushMap = rfiChart(cfg, pos)._r;
    const ps = positions(cfg), behindList = ps.slice(ps.indexOf(pos) + 1);
    let pNoneYet = 1, ev = 0;
    const parts = [];
    for (const v of behindList) {
      const deadOther = deadTotal(cfg) - blindOf(cfg, pos) - blindOf(cfg, v);
      const ch = callVsShoveChart(cfg, 'push-' + pos, pushMap, blindOf(cfg, v), deadOther);
      const r = rangeOf(ch._c, new Set(hand));
      const p = r.reduce((s, c) => s + c.w, 0) / 1225;
      if (p <= 0) continue;
      const eq = eqVsRange(hand, r, 1500);
      const evCalled = allinEV(eq, S, blindOf(cfg, pos), deadOther, L);
      ev += pNoneYet * p * evCalled;
      parts.push({ pos: v, p: pNoneYet * p, eq, ev: evCalled });
      pNoneYet *= 1 - p;
    }
    ev += pNoneYet * deadTotal(cfg);
    return { ev, pFoldAll: pNoneYet, parts };
  }

  return {
    positions, isHU, blindOf, ante, deadTotal, behind, heroIP, stackMode, openSize, icmL, useHandCharts,
    rfiChart, vsOpenChart, vs3betChart, callVsShoveChart, shoveEV, eqVsRange, allinEV, rangeOf, openPct, valueScore, icmTight,
  };
})();
