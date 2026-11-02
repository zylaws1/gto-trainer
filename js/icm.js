// Malmuth-Harville ICM. Converts chip stacks + payouts into prize equity, and derives the
// "bubble factor" (how many chips you must win to make up for each chip you lose) for an
// all-in between hero and an equal-stacked opponent.
const ICM = (() => {
  function equities(stacks, payouts) {
    // Busted players (stack 0) take the last places, so only live players are ranked.
    const idx = stacks.map((s, i) => (s > 0 ? i : -1)).filter(i => i >= 0);
    const s = idx.map(i => stacks[i]), n = s.length, memo = new Map();
    function rec(mask) {
      if (memo.has(mask)) return memo.get(mask);
      const e = new Array(n).fill(0);
      let total = 0, live = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) { total += s[i]; live++; }
      const place = n - live;
      if (live > 0 && place < payouts.length && total > 0) {
        for (let j = 0; j < n; j++) {
          if (!(mask & (1 << j))) continue;
          const p = s[j] / total;
          e[j] += p * payouts[place];
          const sub = rec(mask & ~(1 << j));
          for (let i = 0; i < n; i++) if (i !== j) e[i] += p * sub[i];
        }
      }
      memo.set(mask, e);
      return e;
    }
    const sub = n ? rec((1 << n) - 1) : [];
    const out = new Array(stacks.length).fill(0);
    idx.forEach((i, k) => { out[i] = sub[k]; });
    return out;
  }

  // Stage presets: who is left, what they get paid, and a typical spread of other stacks.
  const SPREAD = [1.8, 0.45, 1.3, 0.8, 2.2, 0.6, 1.1, 0.35, 1.5];
  function preset(cfg) {
    const n = Math.max(3, Math.min(9, cfg.players));
    let pay;
    if (cfg.stage === 'bubble') {
      // Bubble: one more player than paid places, top-heavy ladder (bubble factor ~1.5-1.8).
      pay = Array.from({ length: n - 1 }, (_, k) => Math.pow(0.6, k));
    } else {
      // Final table, typical top-heavy payouts (bubble factor ~1.8-2.3).
      pay = [36, 22, 14, 9, 6.5, 5, 3.5, 2.5, 1.5].slice(0, n);
    }
    const sum = pay.reduce((a, b) => a + b, 0);
    pay = pay.map(x => x / sum);
    const others = SPREAD.slice(0, n - 2).map(m => m * cfg.stack);
    return { stacks: [cfg.stack, cfg.stack, ...others], pay };
  }

  const cache = {};
  function bubbleFactor(cfg) {
    if (cfg.game !== 'mtt' || cfg.stage === 'normal') return 1;
    const k = [cfg.players, cfg.stack, cfg.stage].join('|');
    if (cache[k]) return cache[k];
    const { stacks, pay } = preset(cfg);
    const e0 = equities(stacks.slice(), pay)[0];
    const win = stacks.slice(); win[0] += win[1]; win[1] = 0;
    const lose = stacks.slice(); lose[1] += lose[0]; lose[0] = 0;
    const eW = equities(win, pay)[0], eL = equities(lose, pay)[0];
    const bf = eW - e0 > 1e-9 ? (e0 - eL) / (eW - e0) : 1;
    return (cache[k] = Math.max(1, Math.min(4, bf)));
  }

  return { equities, bubbleFactor, preset };
})();
