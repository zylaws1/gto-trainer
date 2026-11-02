// Heavy, pure computations. Loaded both in the Web Worker and in the page (used directly when a
// worker isn't available, e.g. when index.html is opened from disk). Arguments and results must be
// plain data so they survive structured cloning.
const ComputeFns = {
  // Per-combo annotations come back as arrays in the same order as `range`.
  annotate(range, hero, board, heroRange) {
    Engine.annotate(range, hero, board, heroRange);
    return range.map(c => [c.eq, c.score, c.made, c.madePct, c.scorePct, c.pot]);
  },
  annotateHero(heroRange, board) {
    return Engine.annotateHero(heroRange, board);
  },
  multiFirst(lang, ctx, opps, board, hero) {
    I18N.lang = lang;
    return Multi.optsFirst(ctx, opps, board, hero);
  },
  multiFacing(lang, ctx, bettor, BR, B, other, board, hero) {
    I18N.lang = lang;
    return Multi.optsFacingBet(ctx, bettor, BR, B, other, board, hero);
  },
  shoveEV(cfg, pos, hand) {
    return Modes.shoveEV(cfg, pos, hand);
  },
  eqVsRange(hand, range, trials) {
    return Modes.eqVsRange(hand, range, trials);
  },
  callVsShoveChart(cfg, key, pushMap, heroIn, deadOther) {
    const ch = Modes.callVsShoveChart(cfg, key, pushMap, heroIn, deadOther);
    return { _r: ch._r, _c: ch._c };
  },
};
