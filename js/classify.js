// Hero hand classification on a board, used by the spot filter and per-category stats.
const Classify = (() => {
  const NAMES_ZH = { air: '空气', draw: '听牌', bottom: '底对', middle: '中对', top: '顶对', over: '超对', strong: '两对以上' };
  const NAMES_EN = { air: 'Air', draw: 'Draw', bottom: 'Bottom pair', middle: 'Middle pair', top: 'Top pair', over: 'Overpair', strong: 'Two pair+' };
  const ORDER = ['air', 'draw', 'bottom', 'middle', 'top', 'over', 'strong'];

  // Counts cards that complete a straight or flush using at least one hole card.
  function outs(hero, board) {
    const all = [...hero, ...board];
    const cur = evalHand(all) >> 20;
    if (cur >= 4) return 0;
    let n = 0;
    for (let c = 0; c < 52; c++) {
      if (all.includes(c)) continue;
      const cat = evalHand([...all, c]) >> 20;
      if (cat === 4 || cat === 5) {
        const boardOnly = board.length >= 4 ? evalHand([...board, c]) >> 20 : 0;
        if (boardOnly < 4) n++;
      }
    }
    return n;
  }

  function pairClass(rank, boardRanks) {
    if (rank > boardRanks[0]) return 'over';
    if (rank === boardRanks[0]) return 'top';
    if (rank <= boardRanks[boardRanks.length - 1]) return 'bottom';
    return 'middle';
  }

  function handClass(hero, board) {
    if (board.length < 3) return null;
    const cat = evalHand([...hero, ...board]) >> 20;
    const bcat = evalHand(board) >> 20;
    const hr = hero.map(c => c >> 2).sort((a, b) => b - a);
    const br = [...new Set(board.map(c => c >> 2))].sort((a, b) => b - a);
    const boardPaired = br.length < board.length;
    const pocket = hr[0] === hr[1];
    // Real two pair or better that uses hole cards.
    if (cat >= 3 && cat > bcat) return 'strong';
    if (cat === 2 && !boardPaired) return pocket ? pairClass(hr[0], br) : 'strong';
    // One pair made with hole cards (on a paired board, "two pair" with one hole card counts as a pair).
    if (pocket && !br.includes(hr[0])) return pairClass(hr[0], br);
    const matched = hr.filter(r => br.includes(r));
    if (matched.length && (cat === 1 || cat === 2)) return pairClass(Math.max(...matched), br);
    if (board.length < 5 && outs(hero, board) >= 8) return 'draw';
    return 'air';
  }

  return { handClass, outs, ORDER, get NAMES() { return typeof I18N !== 'undefined' && I18N.lang === 'en' ? NAMES_EN : NAMES_ZH; } };
})();
