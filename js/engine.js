// Heads-up postflop model. Hero's EV for each option is computed against an explicit villain range.
// Villain strategy (balanced heuristic):
//  - hand strength = equity vs hero's (narrowing) range; draws identified by equity rank above made-hand rank
//  - bets value + bluffs (draws on flop/turn, weakest hands on river) at pot-odds ratios, sizing by texture
//  - vs a bet: raises value + draw bluffs, calls up to MDF, folds the rest
//  - vs a raise: re-jams the top, calls the next part, folds the rest
// ICM: chips lost are weighted by L (L = 1 is pure chip EV).
const Engine = (() => {
  const W = r => r.reduce((s, c) => s + c.w, 0);
  const eqOf = r => { const w = W(r); return w > 0 ? r.reduce((s, c) => s + c.w * c.eq, 0) / w : 0; };
  const key = (a, b) => (a < b ? a * 52 + b : b * 52 + a);
  const fmt = x => (Math.round(x * 10) / 10).toString();
  const pct = x => Math.round(x * 100) + '%';
  const sgn2 = x => (x >= 0 ? '+' : '') + x.toFixed(2);

  function deckExcluding(dead) {
    const d = [];
    for (let c = 0; c < 52; c++) if (!dead.has(c)) d.push(c);
    return d;
  }

  function sampleRunouts(board, dead, n) {
    const need = 5 - board.length, deck = deckExcluding(dead);
    if (need === 0) return [[]];
    if (need === 1) return deck.map(c => [c]);
    const out = [];
    for (let i = 0; i < n; i++) {
      const i1 = Math.floor(Math.random() * deck.length);
      let i2 = Math.floor(Math.random() * (deck.length - 1));
      if (i2 >= i1) i2++;
      out.push([deck[i1], deck[i2]]);
    }
    return out;
  }

  // Generic weighted cut: takes `amount` of weight from `range` in descending keyFn order.
  function cutW(range, keyFn, amount) {
    const s = [...range].sort((x, y) => keyFn(y) - keyFn(x));
    const sel = [], rest = [];
    let left = Math.max(0, amount);
    for (const c of s) {
      const t = Math.min(c.w, left);
      left -= t;
      if (t > 1e-9) sel.push({ ...c, w: t });
      if (c.w - t > 1e-9) rest.push({ ...c, w: c.w - t });
    }
    return [sel, rest];
  }

  function percentileBy(range, keyFn, prop) {
    const s = [...range].sort((x, y) => keyFn(x) - keyFn(y));
    const tot = W(s) || 1;
    let cum = 0;
    for (const c of s) { c[prop] = (cum + c.w / 2) / tot; cum += c.w; }
  }

  function strengthVsRandom(c, board, runs) {
    if (board.length === 5) return evalHand([c.a, c.b, ...board]) / (9 << 20);
    const trials = 60;
    let win = 0, n = 0;
    for (let t = 0; t < trials * 3 && n < trials; t++) {
      const r = runs[(t * 7 + c.a * 3 + c.b) % runs.length];
      if (r.includes(c.a) || r.includes(c.b)) continue;
      const full = [...board, ...r];
      let o1, o2;
      do { o1 = Math.floor(Math.random() * 52); } while (o1 === c.a || o1 === c.b || full.includes(o1));
      do { o2 = Math.floor(Math.random() * 52); } while (o2 === o1 || o2 === c.a || o2 === c.b || full.includes(o2));
      const vs = evalHand([c.a, c.b, ...full]), os = evalHand([o1, o2, ...full]);
      win += vs > os ? 1 : vs === os ? 0.5 : 0;
      n++;
    }
    return n ? win / n : 0.5;
  }

  // Villain combo strength vs hero's range (exact on the river, Monte Carlo before).
  function scoreVsRange(range, board, hr, runs) {
    const hv = hr.filter(h => !board.includes(h.a) && !board.includes(h.b));
    if (!hv.length) { for (const c of range) c.score = strengthVsRandom(c, board, runs); return; }
    if (board.length === 5) {
      const hs = hv.map(h => evalHand([h.a, h.b, ...board]));
      for (const c of range) {
        const v = evalHand([c.a, c.b, ...board]);
        let num = 0, den = 0;
        for (let i = 0; i < hv.length; i++) {
          const h = hv[i];
          if (h.a === c.a || h.a === c.b || h.b === c.a || h.b === c.b) continue;
          den += h.w;
          num += h.w * (v > hs[i] ? 1 : v === hs[i] ? 0.5 : 0);
        }
        c.score = den ? num / den : 0.5;
      }
      return;
    }
    const cum = [];
    let acc = 0;
    for (const h of hv) cum.push((acc += h.w));
    const pickH = () => {
      const u = Math.random() * acc;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; }
      return hv[lo];
    };
    const T = 90;
    for (const c of range) {
      let win = 0, n = 0;
      for (let t = 0; t < T * 3 && n < T; t++) {
        const h = pickH();
        if (h.a === c.a || h.a === c.b || h.b === c.a || h.b === c.b) continue;
        const r = runs[(t * 13 + c.a * 5 + c.b) % runs.length];
        if (r.includes(c.a) || r.includes(c.b) || r.includes(h.a) || r.includes(h.b)) continue;
        const v = evalHand([c.a, c.b, ...board, ...r]), o = evalHand([h.a, h.b, ...board, ...r]);
        win += v > o ? 1 : v === o ? 0.5 : 0;
        n++;
      }
      c.score = n ? win / n : 0.5;
    }
  }

  // Annotates villain combos:
  //  eq    hero equity vs this combo
  //  score villain strength vs hero's range
  //  pot   draw potential (strength rank above made-hand rank); 0 on the river
  function annotate(range, hero, board, heroRange) {
    const dead = new Set([...hero, ...board]);
    const runs = sampleRunouts(board, dead, 500);
    const heroScores = runs.map(r => evalHand([...hero, ...board, ...r]));
    const cards = new Array(7);
    for (let i = 0; i < board.length; i++) cards[2 + i] = board[i];
    for (const c of range) {
      let win = 0, n = 0;
      cards[0] = c.a; cards[1] = c.b;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (r.includes(c.a) || r.includes(c.b)) continue;
        for (let k = 0; k < r.length; k++) cards[2 + board.length + k] = r[k];
        const vs = evalHand(cards), hs = heroScores[i];
        win += hs > vs ? 1 : hs === vs ? 0.5 : 0;
        n++;
      }
      c.eq = n ? win / n : 0.5;
    }
    const vRuns = sampleRunouts(board, new Set(board), 300);
    scoreVsRange(range, board, heroRange || [], vRuns);
    finishAnnotate(range, board);
  }

  function finishAnnotate(range, board) {
    for (const c of range) c.made = evalHand([c.a, c.b, ...board]);
    percentileBy(range, c => c.made, 'madePct');
    percentileBy(range, c => c.score, 'scorePct');
    for (const c of range) c.pot = board.length === 5 ? 0 : c.scorePct - c.madePct;
  }

  // Hero's range is tracked so villain can play against it; it narrows with hero's actions.
  function annotateHero(heroRange, board) {
    const live = heroRange.filter(h => !board.includes(h.a) && !board.includes(h.b));
    const runs = sampleRunouts(board, new Set(board), 300);
    for (const h of live) h.score = strengthVsRandom(h, board, runs);
    finishAnnotate(live, board);
    return live;
  }
  function narrowHero(hr, action) {
    const tot = W(hr);
    if (!tot) return hr;
    if (action === 'bet' || action === 'raise') {
      const [val, rest] = cutW(hr, c => c.score, 0.5 * tot);
      const [dr] = cutW(rest, c => c.pot, 0.15 * tot);
      return [...val, ...dr];
    }
    if (action === 'call') {
      const [keep] = cutW(hr, c => c.score + Math.max(0, c.pot), 0.65 * tot);
      return keep;
    }
    if (action === 'check') return cutW(hr, c => -c.score, 0.9 * tot)[0];
    return hr;
  }

  function texture(board) {
    const flop = board.slice(0, 3);
    const suits = [0, 0, 0, 0];
    for (const c of board) suits[c & 3]++;
    const maxSuit = Math.max(...suits);
    const ranks = [...new Set(flop.map(c => c >> 2))].sort((a, b) => a - b);
    const span = ranks.length === 3 ? ranks[2] - ranks[0] : 99;
    const paired = ranks.length < 3;
    const connected = !paired && span <= 4;
    const wet = (maxSuit >= 2 ? 1 : 0) + (maxSuit >= 3 ? 1 : 0) + (connected ? 1 : 0);
    return { wet, paired, maxSuit, connected };
  }

  function real(ctx) {
    if (ctx.street === 'river') return 1;
    if (ctx.street === 'turn') return ctx.ip ? 0.97 : 0.9;
    return ctx.ip ? 0.95 : 0.85;
  }

  const HERO_SIZES = { flop: [0.25, 0.33, 0.5, 0.75, 1.25], turn: [0.33, 0.66, 1.0, 1.5], river: [0.33, 0.66, 1.0, 1.5] };

  // Showdown-weighted EV relative to folding now: a win collects potNow + villain's extra chips,
  // a loss costs hero's extra chips × L.
  const sd = (w, potNow, add, vAdd, L) => w * (potNow + vAdd) - (1 - w) * add * L;

  // Villain's bet range (value + bluffs) at a given size.
  function betSplit(range, street, v, b) {
    const tot = W(range);
    const [val, r1] = cutW(range, c => c.score, v * tot);
    let blf, rest;
    if (street === 'river') [blf, rest] = cutW(r1, c => -c.score, b * tot);
    else {
      const draws = r1.filter(c => c.pot > 0.05);
      const take = Math.min(b * tot, W(draws));
      [blf, rest] = cutW(r1, c => (c.pot > 0.05 ? 1 + c.pot : -c.score), take);
      if (take < b * tot) {
        const [air, rest2] = cutW(rest, c => -c.score, b * tot - take);
        blf = [...blf, ...air];
        rest = rest2;
      }
    }
    return { BR: [...val, ...blf], CR: rest, value: val, bluff: blf };
  }

  function villainBetPlan(street, pos, P, S, board, range, scale = 1) {
    const tx = texture(board);
    let f, v, b = null;
    if (pos === 'ip') {
      if (street === 'flop') [f, v, b] = tx.wet >= 1 && !tx.paired ? [0.66, 0.30, 0.18] : [0.33, 0.42, 0.26];
      else if (street === 'turn') [f, v, b] = Math.random() < 0.3 ? [1.0, 0.2, 0.12] : [0.66, 0.28, 0.14];
      else [f, v] = Math.random() < 0.25 ? [1.25, 0.14] : [0.75, 0.22];
    } else {
      if (street === 'flop') return null;
      if (street === 'turn') [f, v, b] = [0.66, 0.14, 0.07];
      else [f, v] = [0.75, 0.14];
    }
    const B = Math.min(f * P, S);
    if (b === null) { const a = B / (P + 2 * B); b = (v * a) / (1 - a); }
    const sp = betSplit(range, street, v * scale, b * scale * scale);
    return { B, frac: f, BR: sp.BR, CR: sp.CR, pBet: W(sp.BR) / (W(range) || 1) };
  }

  // Villain facing hero's bet B: raise (value + bluffs) / call (up to MDF) / fold.
  function respondToBet(range, street, P, B, S, nOpp = 1) {
    const tot = W(range) || 1;
    // Multiway: defence is shared, each player defends 1 - (1 - MDF)^(1/n).
    const mdf = Math.min(0.95, 1 - Math.pow(B / (P + B), 1 / nOpp));
    const canRaise = B < S - 1e-9;
    const rv = canRaise ? { flop: 0.09, turn: 0.07, river: 0.06 }[street] * (nOpp > 1 ? 0.7 : 1) : 0;
    const [val, r1] = cutW(range, c => c.score, rv * tot);
    const rb = canRaise ? rv * (street === 'river' ? 0.35 : 0.6) : 0;
    const [blf, r2] = street === 'river' ? cutW(r1, c => -c.score, rb * tot) : cutW(r1, c => c.pot, rb * tot);
    // Bigger bets represent a stronger range: villain needs pot-odds equity vs that range
    // (approximated by discounting its score), defending between 60% and 100% of MDF.
    const f = B / P, need = B / (P + 2 * B), delta = 0.05 + 0.1 * Math.min(f, 1.5);
    const eligible = W(range.filter(c => c.score - delta >= need));
    const defend = Math.max(0.6 * mdf * tot, Math.min(mdf * tot, eligible));
    const [call, fold] = cutW(r2, c => c.score, Math.max(0, defend - W(val) - W(blf)));
    const raise = [...val, ...blf];
    return { raise, call, fold, X: Math.min(3 * B, S), pR: W(raise) / tot, pC: W(call) / tot, pF: W(fold) / tot };
  }

  // Villain (who bet) facing hero's raise to X: re-jam the top, call the next part, fold.
  function respondToRaise(BR, X, S) {
    const tot = W(BR) || 1;
    const canJam = X < S - 1e-9;
    const [jam, r1] = cutW(BR, c => c.score, canJam ? 0.18 * tot : 0);
    const [call, fold] = cutW(r1, c => c.score, (canJam ? 0.37 : 0.5) * tot);
    return { jam, call, fold, pJ: W(jam) / tot, pC: W(call) / tot, pF: W(fold) / tot };
  }

  function raiseSizes(B, S, potNow) {
    const out = [Math.min(3 * B, S)];
    if (S > out[0] + 1e-9 && S <= 4 * potNow) out.push(S);
    return out;
  }

  function optsFacingBet(ctx, BR, B) {
    const { P, S } = ctx;
    const L = ctx.L || 1;
    const eq = eqOf(BR);
    const allin = B >= S - 1e-9;
    const R = allin ? 1 : real(ctx);
    const need = (B * L) / (P + B + B * L);
    const opts = [
      { id: 'fold', label: tr('弃牌', 'Fold'), key: 'f', ev: 0, detail: tr('放弃底池。按定义 EV 为 0（基准）。', 'Give up the pot. EV is 0 by definition (baseline).') },
      { id: 'call', label: tr(`跟注 ${fmt(B)}`, `Call ${fmt(B)}`), key: 'c', ev: sd(eq * R, P + B, B, 0, L),
        detail: tr(`对抗对手下注范围的胜率 ${pct(eq)}${R < 1 ? `（实现率约 ${pct(R)}）` : ''}；底池赔率要求 ${pct(need)}。`,
          `Equity vs the betting range ${pct(eq)}${R < 1 ? ` (realizing ~${pct(R)})` : ''}; pot odds need ${pct(need)}.`) },
    ];
    if (!allin) {
      raiseSizes(B, S, P + B).forEach(X => {
        const isAll = X >= S - 1e-9;
        const resp = respondToRaise(BR, X, S);
        const R2 = isAll ? 1 : real(ctx);
        const eqC = eqOf(resp.call), eqJ = eqOf(resp.jam);
        const vsJam = Math.max(-X * L, sd(eqJ, P, S, S, L));
        const ev = resp.pF * (P + B) + resp.pC * sd(eqC * R2, P, X, X, L) + resp.pJ * vsJam;
        opts.push({ id: isAll ? 'allin' : 'raise', key: isAll ? 'a' : 'r', X, resp, ev,
          label: isAll ? tr(`全下 ${fmt(X)}`, `All-in ${fmt(X)}`) : tr(`加注到 ${fmt(X)}`, `Raise to ${fmt(X)}`),
          detail: tr(`对手弃牌 ${pct(resp.pF)}、跟注 ${pct(resp.pC)}（你胜率 ${pct(eqC)}）${resp.pJ > 0 ? `、再全下 ${pct(resp.pJ)}（你胜率 ${pct(eqJ)}）` : ''}。`,
            `Villain folds ${pct(resp.pF)}, calls ${pct(resp.pC)} (your equity ${pct(eqC)})${resp.pJ > 0 ? `, re-shoves ${pct(resp.pJ)} (your equity ${pct(eqJ)})` : ''}.`) });
      });
    }
    return opts;
  }

  // Hero bet B, villain raised to X.
  function optsFacingRaise(ctx, RR, B, X) {
    const { P, S } = ctx;
    const L = ctx.L || 1;
    const eq = eqOf(RR);
    const allin = X >= S - 1e-9;
    const R = allin ? 1 : real(ctx);
    const potNow = P + B + X, add = X - B;
    const opts = [
      { id: 'fold', label: tr('弃牌', 'Fold'), key: 'f', ev: 0, detail: tr(`放弃底池（你已投入的 ${fmt(B)} 不再收回）。`, `Give up the pot (the ${fmt(B)} you put in is gone).`) },
      { id: 'call', label: tr(`跟注 ${fmt(add)}`, `Call ${fmt(add)}`), key: 'c', ev: sd(eq * R, potNow, add, 0, L),
        detail: tr(`对抗对手加注范围的胜率 ${pct(eq)}；底池赔率要求 ${pct((add * L) / (potNow + add * L))}。`,
          `Equity vs the raising range ${pct(eq)}; pot odds need ${pct((add * L) / (potNow + add * L))}.`) },
    ];
    if (!allin) {
      const [call, fold] = cutW(RR, c => c.score, 0.55 * W(RR));
      const pF = W(fold) / (W(RR) || 1), eqC = eqOf(call);
      opts.push({ id: 'allin', label: tr(`全下 ${fmt(S)}`, `All-in ${fmt(S)}`), key: 'a', resp: { call, fold },
        ev: pF * potNow + (1 - pF) * sd(eqC, potNow, S - B, S - X, L),
        detail: tr(`对手弃牌 ${pct(pF)}；被跟注时你的胜率 ${pct(eqC)}。`, `Villain folds ${pct(pF)}; your equity when called ${pct(eqC)}.`) });
    }
    return opts;
  }

  // Hero raised to X, villain re-jammed for S.
  function optsFacingJam(ctx, JR, X) {
    const { P, S } = ctx;
    const L = ctx.L || 1;
    const eq = eqOf(JR);
    const potNow = P + X + S, add = S - X;
    return [
      { id: 'fold', label: tr('弃牌', 'Fold'), key: 'f', ev: 0, detail: tr(`放弃底池（你已投入的 ${fmt(X)} 不再收回）。`, `Give up the pot (the ${fmt(X)} you put in is gone).`) },
      { id: 'call', label: tr(`跟注全下 ${fmt(add)}`, `Call all-in ${fmt(add)}`), key: 'c', ev: sd(eq, potNow, add, 0, L),
        detail: tr(`对抗对手全下范围的胜率 ${pct(eq)}；底池赔率要求 ${pct((add * L) / (potNow + add * L))}。`,
          `Equity vs the shoving range ${pct(eq)}; pot odds need ${pct((add * L) / (potNow + add * L))}.`) },
    ];
  }

  function optsFirst(ctx, range, villainToAct, board) {
    const { P, S, street } = ctx;
    const L = ctx.L || 1;
    const R = real(ctx);
    const opts = [];
    if (villainToAct) {
      const plan = villainBetPlan(street, 'ip', P, S, board, range);
      let best = 0;
      if (plan.pBet > 0) for (const o of optsFacingBet(ctx, plan.BR, plan.B)) best = Math.max(best, o.ev);
      const eqCR = eqOf(plan.CR);
      opts.push({ id: 'check', label: tr('过牌', 'Check'), key: 'c', ev: (1 - plan.pBet) * eqCR * R * P + plan.pBet * best, plan,
        detail: tr(`对手有 ${pct(plan.pBet)} 的概率下注 ${fmt(plan.B)}（之后你采取最佳应对，价值 ${sgn2(best)}）；双方过牌时你的胜率为 ${pct(eqCR)}。`,
          `Villain bets ${fmt(plan.B)} ${pct(plan.pBet)} of the time (your best response is worth ${sgn2(best)}); when it checks through your equity is ${pct(eqCR)}.`) });
    } else {
      const eq = eqOf(range);
      opts.push({ id: 'check', label: tr('过牌', 'Check'), key: 'c', ev: eq * R * P,
        detail: tr(`${street === 'river' ? '摊牌' : '免费看牌'}，对抗对手过牌范围的胜率 ${pct(eq)}。`, `${street === 'river' ? 'Showdown' : 'Free card'} with ${pct(eq)} equity vs the checking range.`) });
    }
    const sizes = HERO_SIZES[street].map(f => [f, Math.min(f * P, S)]);
    if (S <= 4 * P) sizes.push([S / P, S]);
    const seen = new Set();
    sizes.forEach(([frac, B]) => {
      const k = B.toFixed(1);
      if (B <= 0 || seen.has(k)) return;
      seen.add(k);
      const allin = B >= S - 1e-9;
      const resp = respondToBet(range, street, P, B, S);
      const R2 = allin ? 1 : R;
      const eqC = eqOf(resp.call), eqR = eqOf(resp.raise);
      const X = resp.X, R3 = X >= S - 1e-9 ? 1 : R;
      const vsRaise = Math.max(-B * L, sd(eqR * R3, P, X, X, L));
      const ev = resp.pF * P + resp.pC * sd(eqC * R2, P, B, B, L) + resp.pR * vsRaise;
      opts.push({ id: allin ? 'allin' : 'bet' + seen.size, key: allin ? 'a' : String(seen.size), B, resp, ev,
        label: allin ? tr(`全下 ${fmt(B)}`, `All-in ${fmt(B)}`) : tr(`下注 ${fmt(B)}（${Math.round(frac * 100)}%）`, `Bet ${fmt(B)} (${Math.round(frac * 100)}%)`),
        detail: tr(`对手弃牌 ${pct(resp.pF)}、跟注 ${pct(resp.pC)}（你胜率 ${pct(eqC)}）${resp.pR > 0.001 ? `、加注 ${pct(resp.pR)}（你胜率 ${pct(eqR)}）` : ''}。`,
          `Villain folds ${pct(resp.pF)}, calls ${pct(resp.pC)} (your equity ${pct(eqC)})${resp.pR > 0.001 ? `, raises ${pct(resp.pR)} (your equity ${pct(eqR)})` : ''}.`) });
    });
    return opts;
  }

  function buildRange(freqFn, dead) {
    const out = [];
    for (const label of ALL_LABELS) {
      const w = freqFn(label);
      if (w <= 0) continue;
      for (const [a, b] of combosOf(label)) {
        if (dead.has(a) || dead.has(b)) continue;
        out.push({ a, b, w, eq: 0.5, score: 0.5, pot: 0 });
      }
    }
    return out;
  }

  // Picks which sub-range villain's actual hand falls into, proportional to its weight there.
  function member(vil, subs) {
    const k = key(vil[0], vil[1]);
    const ws = subs.map(([, r]) => r.filter(c => key(c.a, c.b) === k).reduce((s, c) => s + c.w, 0));
    const tot = ws.reduce((s, x) => s + x, 0);
    if (tot <= 0) return subs[subs.length - 1][0];
    let u = Math.random() * tot;
    for (let i = 0; i < subs.length; i++) { u -= ws[i]; if (u <= 0) return subs[i][0]; }
    return subs[subs.length - 1][0];
  }

  function sampleCombo(range) {
    let u = Math.random() * W(range);
    for (const c of range) { u -= c.w; if (u <= 0) return [c.a, c.b]; }
    const c = range[range.length - 1];
    return [c.a, c.b];
  }

  return {
    W, eqOf, cutW, annotate, annotateHero, narrowHero, texture, real, villainBetPlan, betSplit, respondToBet, respondToRaise,
    optsFacingBet, optsFacingRaise, optsFacingJam, optsFirst, buildRange, sampleCombo, member, sampleRunouts, fmt, pct,
  };
})();
