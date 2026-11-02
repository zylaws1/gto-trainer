// 3-way pot maths. Hero equity vs several ranges is Monte Carlo; villains respond independently
// with a multiway-adjusted defence (each defends 1 - (1 - MDF)^(1/n)). Once anyone raises, the pot
// is treated as heads-up between hero and the raiser.
const Multi = (() => {
  const W = Engine.W;
  const { fmt, pct } = Engine;
  const sd = (w, potNow, add, vAdd, L) => w * (potNow + vAdd) - (1 - w) * add * L;

  function prep(range) {
    const cum = [];
    let acc = 0;
    for (const c of range) cum.push((acc += c.w));
    return { range, cum, tot: acc };
  }
  function pick(p) {
    const u = Math.random() * p.tot;
    let lo = 0, hi = p.cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (p.cum[m] < u) lo = m + 1; else hi = m; }
    return p.range[lo];
  }

  function eqMulti(hero, board, ranges, trials = 1200) {
    const ps = ranges.filter(r => W(r) > 0).map(prep);
    if (!ps.length) return 1;
    let win = 0, n = 0;
    for (let t = 0; t < trials * 2 && n < trials; t++) {
      const used = new Set([...hero, ...board]);
      const opp = [];
      let bad = false;
      for (const p of ps) {
        let c, k = 0;
        do { c = pick(p); k++; } while ((used.has(c.a) || used.has(c.b)) && k < 12);
        if (used.has(c.a) || used.has(c.b)) { bad = true; break; }
        used.add(c.a); used.add(c.b);
        opp.push(c);
      }
      if (bad) continue;
      const run = [];
      while (board.length + run.length < 5) {
        const c = Math.floor(Math.random() * 52);
        if (!used.has(c)) { used.add(c); run.push(c); }
      }
      const full = [...board, ...run];
      const hs = evalHand([...hero, ...full]);
      let best = true, ties = 0;
      for (const o of opp) {
        const v = evalHand([o.a, o.b, ...full]);
        if (v > hs) { best = false; break; }
        if (v === hs) ties++;
      }
      if (best) win += 1 / (ties + 1);
      n++;
    }
    return n ? win / n : 0;
  }

  // Hero first to act (or checked to) in a 3-way pot.
  function optsFirst(ctx, opps, board, hero) {
    const { P, S, street } = ctx, L = ctx.L || 1, R = Engine.real(ctx);
    const live = opps.filter(o => o.live);
    const eqAll = eqMulti(hero, board, live.map(o => o.range));
    const opts = [{ id: 'check', label: tr('过牌', 'Check'), key: 'c', ev: eqAll * R * P,
      detail: tr(`对抗 ${live.length} 名对手的整体胜率 ${pct(eqAll)}（多人底池按看牌/摊牌近似）。`, `Equity vs ${live.length} opponents ${pct(eqAll)} (multiway check approximated as reaching showdown).`) }];
    const sizes = { flop: [0.33, 0.5, 0.75], turn: [0.5, 0.75, 1.0], river: [0.5, 0.75, 1.0] }[street];
    const seen = new Set();
    sizes.forEach(frac => {
      const B = Math.min(frac * P, S);
      if (seen.has(B.toFixed(1))) return;
      seen.add(B.toFixed(1));
      const resps = live.map(o => Engine.respondToBet(o.range, street, P, B, S, live.length));
      const X = Math.min(3 * B, S);
      const R2 = B >= S - 1e-9 ? 1 : R, R3 = X >= S - 1e-9 ? 1 : R;
      let ev = 0;
      const memo = {};
      const eqOfSet = (key, ranges) => (memo[key] ??= eqMulti(hero, board, ranges, 800));
      const acts = ['F', 'C', 'R'];
      for (const a0 of acts) for (const a1 of (live.length > 1 ? acts : ['F'])) {
        const a = live.length > 1 ? [a0, a1] : [a0];
        const p = a.reduce((s, x, i) => s * (x === 'F' ? resps[i].pF : x === 'C' ? resps[i].pC : resps[i].pR), 1);
        if (p < 1e-6) continue;
        const callers = a.map((x, i) => (x === 'C' ? i : -1)).filter(i => i >= 0);
        const raisers = a.map((x, i) => (x === 'R' ? i : -1)).filter(i => i >= 0);
        let v;
        if (!callers.length && !raisers.length) v = P;
        else if (!raisers.length) {
          const w = eqOfSet('C' + callers.join(), callers.map(i => resps[i].call)) * R2;
          v = sd(w, P + B * (callers.length - 1), B, B, L);
        } else {
          const r = raisers[0];
          const dead = B * (a.length - 1 - (a.filter(x => x === 'F').length));
          const w = eqOfSet('R' + r, [resps[r].raise]) * R3;
          v = Math.max(-B * L, sd(w, P + dead, X, X, L));
        }
        ev += p * v;
      }
      const pAllFold = resps.reduce((s, r) => s * r.pF, 1);
      opts.push({ id: 'bet' + seen.size, key: String(seen.size), B, resps, ev,
        label: B >= S - 1e-9 ? tr(`全下 ${fmt(B)}`, `All-in ${fmt(B)}`) : tr(`下注 ${fmt(B)}（${Math.round(frac * 100)}%）`, `Bet ${fmt(B)} (${Math.round(frac * 100)}%)`),
        detail: tr(`所有人弃牌 ${pct(pAllFold)}；${live.map((o, i) => `${o.pos} 跟注 ${pct(resps[i].pC)}/加注 ${pct(resps[i].pR)}`).join('，')}。`,
          `Everyone folds ${pct(pAllFold)}; ${live.map((o, i) => `${o.pos} calls ${pct(resps[i].pC)} / raises ${pct(resps[i].pR)}`).join(', ')}.`) });
    });
    return opts;
  }

  // Hero facing a bet in a 3-way pot. `other` is the third player: folded, called, or yet to act.
  function optsFacingBet(ctx, bettor, BR, B, other, board, hero) {
    const { P, S, street } = ctx, L = ctx.L || 1;
    const allin = B >= S - 1e-9, R = allin ? 1 : Engine.real(ctx);
    const calledB = other && other.state === 'called' ? B : 0;
    let callEV, eqHU = eqMulti(hero, board, [BR]), detail;
    if (other && other.state === 'called') {
      const w = eqMulti(hero, board, [BR, other.range]) * R;
      callEV = sd(w, P + B + calledB, B, 0, L);
      detail = tr(`${other.pos} 已跟注；你对抗两人的胜率 ${pct(w / R)}。`, `${other.pos} already called; your equity vs both ${pct(w / R)}.`);
    } else if (other && other.state === 'pending') {
      const r = Engine.respondToBet(other.range, street, P + B, B, S, 1);
      const wHU = eqHU * R, w3 = eqMulti(hero, board, [BR, r.call]) * R;
      callEV = (1 - r.pC) * sd(wHU, P + B, B, 0, L) + r.pC * sd(w3, P + B, B, B, L);
      detail = tr(`${other.pos} 之后跟注的概率约 ${pct(r.pC)}；单挑胜率 ${pct(eqHU)}。`, `${other.pos} still to act, calls ~${pct(r.pC)}; heads-up equity ${pct(eqHU)}.`);
    } else {
      callEV = sd(eqHU * R, P + B, B, 0, L);
      detail = tr(`对抗下注范围的胜率 ${pct(eqHU)}。`, `Equity vs the betting range ${pct(eqHU)}.`);
    }
    const opts = [
      { id: 'fold', label: tr('弃牌', 'Fold'), key: 'f', ev: 0, detail: tr('放弃底池（基准 0）。', 'Give up the pot (baseline 0).') },
      { id: 'call', label: tr(`跟注 ${fmt(B)}`, `Call ${fmt(B)}`), key: 'c', ev: callEV, detail },
    ];
    if (!allin) {
      const X = Math.min(3 * B, S);
      const resp = Engine.respondToRaise(BR, X, S);
      const R2 = X >= S - 1e-9 ? 1 : Engine.real(ctx);
      const eqC = eqMulti(hero, board, [resp.call]), eqJ = resp.pJ > 0 ? eqMulti(hero, board, [resp.jam]) : 0;
      const ev = resp.pF * (P + B + calledB) + resp.pC * sd(eqC * R2, P + calledB, X, X, L)
        + resp.pJ * Math.max(-X * L, sd(eqJ, P + calledB, S, S, L));
      opts.push({ id: 'raise', label: X >= S - 1e-9 ? tr(`全下 ${fmt(X)}`, `All-in ${fmt(X)}`) : tr(`加注到 ${fmt(X)}`, `Raise to ${fmt(X)}`), key: 'r', X, resp, ev,
        detail: tr(`下注者弃牌 ${pct(resp.pF)}、跟注 ${pct(resp.pC)}（你胜率 ${pct(eqC)}）；第三人视为弃牌。`, `Bettor folds ${pct(resp.pF)}, calls ${pct(resp.pC)} (your equity ${pct(eqC)}); the third player is assumed to fold.`) });
    }
    return opts;
  }

  return { eqMulti, optsFirst, optsFacingBet };
})();
