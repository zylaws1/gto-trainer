// Approximate 6-max, 100bb, 2.5x-open (SB 3x) solver-style charts.
// "raise" = open / 3-bet / 4-bet frequency; "call" takes the remainder up to its listed frequency.
const CHARTS = {
  rfi: {
    UTG: { raise: '55+,A2s+,K9s+,Q9s+,J9s+,T9s,98s:0.5,87s:0.5,76s:0.5,ATo+,KJo+,QJo:0.5' },
    HJ: { raise: '44+,33:0.5,A2s+,K7s+,Q9s+,J9s+,T8s+,98s,87s,76s,65s:0.5,A9o+,KTo+,QJo,QTo:0.5,JTo:0.5' },
    CO: { raise: '22+,A2s+,K4s+,Q7s+,J7s+,T7s+,97s+,86s+,75s+,65s,54s,A7o+,A5o,K9o+,QTo+,JTo,T9o:0.5' },
    BTN: { raise: '22+,A2s+,K2s+,Q2s+,J4s+,T6s+,96s+,85s+,74s+,63s+,53s+,43s,A2o+,K7o+,Q8o+,J8o+,T8o+,98o,87o:0.5,76o:0.5' },
    SB: { raise: '22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o,98o:0.5' },
  },
  vsOpen: {
    BBvUTG: { hero: 'BB', villain: 'UTG', threebet: 11,
      raise: 'QQ+,AK,A5s:0.5,A4s:0.5,KQs:0.25',
      call: '22+,A2s+,K8s+,Q9s+,J9s+,T8s+,97s+,86s+,75s+,64s+,54s,AJo+,KQo:0.5,KJo:0.3' },
    BBvHJ: { hero: 'BB', villain: 'HJ', threebet: 11,
      raise: 'QQ+,AK,AQs:0.5,A5s-A4s,KQs:0.5,TT:0.25,JJ:0.5,76s:0.3',
      call: '22+,A2s+,K6s+,Q8s+,J8s+,T8s+,97s+,86s+,75s+,64s+,53s+,ATo+,KJo+,QJo:0.5' },
    BBvCO: { hero: 'BB', villain: 'CO', threebet: 11,
      raise: 'JJ+,TT:0.5,AQ+,AJs:0.5,A5s-A3s,KQs:0.5,K9s:0.3,76s:0.3,65s:0.3,ATo:0.25',
      call: '22+,A2s+,K3s+,Q6s+,J7s+,T7s+,96s+,85s+,74s+,64s+,53s+,43s:0.5,A8o+,KTo+,QTo+,JTo,T9o:0.5' },
    BBvBTN: { hero: 'BB', villain: 'BTN', threebet: 11,
      raise: 'TT+,99:0.5,AJs+,ATs:0.5,A5s-A2s,KJs+,K9s:0.5,Q9s:0.3,J9s:0.3,T8s:0.3,65s:0.5,54s:0.5,AJo+,KQo:0.5,A5o:0.3',
      call: '22+,A2s+,K2s+,Q2s+,J4s+,T6s+,95s+,85s+,74s+,63s+,52s+,42s+,32s:0.5,A2o+,K7o+,Q8o+,J8o+,T8o+,97o+,87o,76o:0.5,65o:0.3' },
    BBvSB: { hero: 'BB', villain: 'SB', threebet: 9,
      raise: '99+,ATs+,A5s-A2s:0.5,KTs+,QJs,K9s:0.3,J9s:0.3,AJo+,KQo:0.5',
      call: '22+,A2s+,K2s+,Q2s+,J5s+,T6s+,96s+,85s+,74s+,63s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,97o+,87o,76o' },
    BTNvUTG: { hero: 'BTN', villain: 'UTG', threebet: 7.5,
      raise: 'QQ+,AKs,AKo:0.7,A5s:0.5,AQs:0.3',
      call: '22+,ATs+,KTs+,QJs,JTs,T9s,98s:0.5,AQo:0.6,AKo' },
    BTNvHJ: { hero: 'BTN', villain: 'HJ', threebet: 7.5,
      raise: 'JJ+,TT:0.5,AQs+,AKo,A5s:0.5,KQs:0.5,AJs:0.3',
      call: '22+,ATs+,KTs+,QTs+,J9s+,T9s,98s,87s:0.5,AQo,KQo:0.5' },
    BTNvCO: { hero: 'BTN', villain: 'CO', threebet: 7.5,
      raise: 'TT+,AJs+,KQs,A5s-A4s,AQo+,KJs:0.5,ATs:0.5,76s:0.3,65s:0.3,AJo:0.3',
      call: '22+,A8s+,K9s+,QTs+,J9s+,T9s,98s,87s,76s,AJo,KQo' },
    SBvCO: { hero: 'SB', villain: 'CO', threebet: 11, noCall: true,
      raise: '88+,77:0.5,ATs+,A5s-A4s,KTs+,QJs,JTs:0.5,AJo+,KQo' },
    SBvBTN: { hero: 'SB', villain: 'BTN', threebet: 11, noCall: true,
      raise: '77+,66:0.5,A8s+,A7s:0.5,A5s-A3s,KTs+,K9s:0.5,QTs+,JTs,T9s:0.5,ATo+,KJo+,QJo:0.3' },
  },
  vs3bet: {
    UTGvBTN: { hero: 'UTG', villain: 'BTN', open: 2.5, threebet: 7.5, fourbet: 20,
      raise: 'KK+,AKs,QQ:0.3,AKo:0.5,A5s:0.3',
      call: 'QQ,JJ,TT,99:0.5,AQs,AJs,KQs,AKo,ATs:0.5,KJs:0.5,QJs:0.3,JTs:0.3' },
    COvBTN: { hero: 'CO', villain: 'BTN', open: 2.5, threebet: 7.5, fourbet: 20,
      raise: 'QQ+,AK,A5s:0.5,A4s:0.5,JJ:0.3',
      call: '88+,77:0.5,ATs+,KTs+,QTs+,JTs,T9s,98s:0.5,AQo,KQo:0.3' },
    BTNvBB: { hero: 'BTN', villain: 'BB', open: 2.5, threebet: 11, fourbet: 24,
      raise: 'QQ+,JJ:0.4,AK,AQs:0.4,A5s-A2s:0.4,KTs:0.2',
      call: '22+,A2s+,K8s+,Q9s+,J9s+,T8s+,97s+,86s+,76s,65s,54s,ATo+,KJo+,QJo:0.5' },
    BTNvSB: { hero: 'BTN', villain: 'SB', open: 2.5, threebet: 11, fourbet: 24,
      raise: 'QQ+,JJ:0.4,AK,AQs:0.4,A5s-A3s:0.4',
      call: '22+,A2s+,K9s+,Q9s+,J9s+,T8s+,98s,87s,76s,65s,ATo+,KJo+' },
  },
};

function chartFreqs(chart, label) {
  if (!chart._r) { chart._r = parseRange(chart.raise); chart._c = parseRange(chart.call || ''); }
  const r = chart._r[label] || 0;
  const c = Math.min(chart._c[label] || 0, 1 - r);
  const rd = x => Math.round(x * 100) / 100;
  return { raise: rd(r), call: rd(c), fold: rd(Math.max(0, 1 - r - c)) };
}
