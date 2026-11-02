// Cards are ints 0..51: rank = c >> 2 (0 = '2' .. 12 = 'A'), suit = c & 3.
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
const HAND_NAMES = {
  zh: ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'],
  en: ['High card', 'Pair', 'Two pair', 'Trips', 'Straight', 'Flush', 'Full house', 'Quads', 'Straight flush'],
};

const _rc = new Int8Array(13), _sc = new Int8Array(4), _sm = new Int32Array(4);

function straightHigh(m) {
  for (let h = 12; h >= 4; h--) if (((m >> (h - 4)) & 31) === 31) return h;
  if ((m & 0x100F) === 0x100F) return 3;
  return -1;
}

function kick(mask, n, sh) {
  let v = 0;
  for (let r = 12; r >= 0 && n > 0; r--) {
    if (mask & (1 << r)) { v |= r << sh; sh -= 4; n--; }
  }
  return v;
}

// Returns a comparable integer: higher is better. Category in bits 20+.
function evalHand(cards) {
  _rc.fill(0); _sc.fill(0); _sm.fill(0);
  let rm = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i], r = c >> 2, s = c & 3;
    _rc[r]++; _sc[s]++; _sm[s] |= 1 << r; rm |= 1 << r;
  }
  let fs = -1;
  for (let s = 0; s < 4; s++) if (_sc[s] >= 5) fs = s;
  if (fs >= 0) {
    const sf = straightHigh(_sm[fs]);
    if (sf >= 0) return (8 << 20) | (sf << 16);
  }
  let quad = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const n = _rc[r];
    if (n === 4) quad = r;
    else if (n === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
    else if (n === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }
  if (quad >= 0) return (7 << 20) | (quad << 16) | kick(rm & ~(1 << quad), 1, 12);
  if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return (6 << 20) | (t1 << 16) | (Math.max(t2, p1) << 12);
  if (fs >= 0) return (5 << 20) | kick(_sm[fs], 5, 16);
  const st = straightHigh(rm);
  if (st >= 0) return (4 << 20) | (st << 16);
  if (t1 >= 0) return (3 << 20) | (t1 << 16) | kick(rm & ~(1 << t1), 2, 12);
  if (p2 >= 0) return (2 << 20) | (p1 << 16) | (p2 << 12) | kick(rm & ~(1 << p1) & ~(1 << p2), 1, 8);
  if (p1 >= 0) return (1 << 20) | (p1 << 16) | kick(rm & ~(1 << p1), 3, 12);
  return kick(rm, 5, 16);
}

function handName(score) { return HAND_NAMES[typeof I18N !== 'undefined' && I18N.lang === 'en' ? 'en' : 'zh'][score >> 20]; }

function cardStr(c) { return RANKS[c >> 2] + SUITS[c & 3]; }

function labelOf(a, b) {
  let r1 = a >> 2, r2 = b >> 2;
  if (r1 < r2) [r1, r2] = [r2, r1];
  if (r1 === r2) return RANKS[r1] + RANKS[r1];
  return RANKS[r1] + RANKS[r2] + ((a & 3) === (b & 3) ? 's' : 'o');
}

const _comboCache = {};
function combosOf(label) {
  if (_comboCache[label]) return _comboCache[label];
  const r1 = RANKS.indexOf(label[0]), r2 = RANKS.indexOf(label[1]);
  const out = [];
  for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
    if (r1 === r2) { if (s2 <= s1) continue; }
    else if (label[2] === 's' ? s1 !== s2 : s1 === s2) continue;
    out.push([r1 * 4 + s1, r2 * 4 + s2]);
  }
  return (_comboCache[label] = out);
}

const ALL_LABELS = (() => {
  const out = [];
  for (let i = 12; i >= 0; i--) for (let j = 12; j >= 0; j--) {
    if (i === j) out.push(RANKS[i] + RANKS[i]);
    else if (i > j) out.push(RANKS[i] + RANKS[j] + 's', RANKS[i] + RANKS[j] + 'o');
  }
  return out;
})();

// Range notation: "TT+, A2s+, KTo+, A5s-A2s, 77-55, AQ+, KQs:0.5"
function parseRange(str) {
  const m = {};
  if (!str) return m;
  for (let tok of str.split(',')) {
    tok = tok.trim();
    if (!tok) continue;
    let f = 1;
    const ci = tok.indexOf(':');
    if (ci >= 0) { f = parseFloat(tok.slice(ci + 1)); tok = tok.slice(0, ci); }
    for (const l of expandToken(tok)) m[l] = Math.max(m[l] || 0, f);
  }
  return m;
}

function expandToken(tok) {
  const ri = ch => RANKS.indexOf(ch);
  const out = [];
  const addNP = (x, y, suf) => {
    if (suf === 's' || suf === '') out.push(x + y + 's');
    if (suf === 'o' || suf === '') out.push(x + y + 'o');
  };
  if (tok.includes('-')) {
    const [a, b] = tok.split('-');
    if (a[0] === a[1]) {
      let hi = ri(a[0]), lo = ri(b[0]);
      if (hi < lo) [hi, lo] = [lo, hi];
      for (let r = lo; r <= hi; r++) out.push(RANKS[r] + RANKS[r]);
    } else {
      let hi = ri(a[1]), lo = ri(b[1]);
      if (hi < lo) [hi, lo] = [lo, hi];
      for (let r = lo; r <= hi; r++) addNP(a[0], RANKS[r], a.slice(2));
    }
    return out;
  }
  const plus = tok.endsWith('+');
  if (plus) tok = tok.slice(0, -1);
  if (tok[0] === tok[1]) {
    const lo = ri(tok[0]);
    for (let r = lo; r <= (plus ? 12 : lo); r++) out.push(RANKS[r] + RANKS[r]);
    return out;
  }
  const lo = ri(tok[1]);
  const hi = plus ? ri(tok[0]) - 1 : lo;
  for (let r = lo; r <= hi; r++) addNP(tok[0], RANKS[r], tok.slice(2));
  return out;
}
