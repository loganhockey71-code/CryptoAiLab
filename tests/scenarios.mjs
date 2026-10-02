// Synthetic but realistic multi-timeframe markets for the three situations the Brain must handle differently. A 5-minute path is generated from an hourly price/volume plan (seeded noise),
// then aggregated to 15m / 1h / 1d exactly like live candles, and run through the real structure engine and decision code.
process.env.PAPER_TRADING ??= 'true';
const { analyzeAll } = await import('../src/structure.js');
const { aggregate } = await import('../src/indicators.js');
const risk = await import('../src/risk.js');
const brain = await import('../src/brain.js');
const { buildModel, LEVELS } = await import('../src/empirical.js');

const T0 = 1_699_920_000;                         // aligned to a UTC day
export const HOURS = 2400;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** hourly plan -> 5m candles. price(h) is the close at the END of hour h; vol(h) the hour's volume; noise = per-bar random wiggle (fraction of price). */
export function build(price, vol, { noise = 0.004, seed = 7 } = {}) {
  const r = rng(seed), out = []; let prev = price(-1);
  for (let h = 0; h < HOURS; h++) {
    const p0 = price(h - 1), p1 = price(h);
    for (let k = 0; k < 12; k++) {
      const close = p0 + (p1 - p0) * ((k + 1) / 12) + p0 * noise * (r() - 0.5) * 2, o = prev;
      const wick = p0 * noise * 0.6 * r();
      out.push({ t: T0 + (h * 12 + k) * 300, o, c: close, h: Math.max(o, close) + wick, l: Math.min(o, close) - wick, v: (vol(h) / 12) * (0.7 + 0.6 * r()) });
      prev = close;
    }
  }
  return out;
}
export function analyse(c5) {
  const last = (a, n) => a.slice(-n);
  return analyzeAll({ d1: last(aggregate(c5, 86400), 300), h1: last(aggregate(c5, 3600), 300), m15: last(aggregate(c5, 900), 300), m5: last(c5, 300) });
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const base = (h) => 100 * (1 + 0.00035 * h + 0.03 * Math.sin(h / 13) + 0.018 * Math.sin(h / 5));       // a healthy, choppy 4h/1h uptrend
const baseVol = (h) => 1000 * (1 + 0.2 * Math.sin(h / 7));
const E = HOURS;

/** 1. A coin that already pumped: quiet range, vertical breakout 20 hours ago (+14% in 12h on a 6x volume spike), now stretched and drifting. Every indicator says "bullish". */
export function pumped() {
  const P = base(E - 70), hi0 = E - 20;
  const price = (h) => (h < E - 70 ? base(h) : h < hi0 ? P * (1 + 0.006 * Math.sin(h / 3)) : h < hi0 + 12 ? P * Math.pow(1.011, h - hi0 + 1) : P * Math.pow(1.011, 12) * (1 + 0.0012 * (h - hi0 - 12)));
  const vol = (h) => (h >= hi0 && h < hi0 + 4 ? 6000 : h >= hi0 + 4 && h < hi0 + 12 ? 2500 : baseVol(h));
  return build(price, vol, { seed: 11 });
}
/** 2. A fresh entry: a 2-day range, a breakout on volume ~8 hours ago, a pullback that retested the old range high and held, and a bullish turn off the retest. Price is still at the level. */
export function fresh() {
  const P = base(E - 60), rangeHi = P * 1.05, mid = P;
  const price = (h) => {
    if (h < E - 60) return base(h);
    if (h < E - 10) return mid + (rangeHi - mid) * Math.sin((h - (E - 60)) * 0.9);                               // oscillates between P*0.95 and P*1.05
    if (h < E - 7) return rangeHi * (1 + 0.04 * smooth(E - 10, E - 7, h));                                       // breakout +4% above the high
    if (h < E - 4) return rangeHi * (1 + 0.04 * (1 - smooth(E - 7, E - 4, h)) + 0.002);                         // pullback back onto the old high
    return rangeHi * (1.002 + 0.007 * smooth(E - 4, E, h));                                                       // holds and turns up
  };
  const vol = (h) => (h >= E - 10 && h < E - 7 ? 4200 : h >= E - 7 && h < E - 4 ? 700 : h >= E - 4 ? 1900 : baseVol(h));
  return build(price, vol, { seed: 23, noise: 0.0025 });
}
/** 3. Direction right, timing wrong: a smooth grind up with no pullback at all. Trend, flow and momentum are all bullish, but price is stretched above its mean mid-move with no level under it. */
export function lateGrind() {
  const price = (h) => (h < E - 45 ? base(h) : base(E - 45) * (1 + 0.0021 * (h - (E - 45)) + 0.0008 * Math.sin(h)));
  const vol = (h) => (h >= E - 45 ? 1500 : baseVol(h));
  return build(price, vol, { seed: 31, noise: 0.004 });
}

export const shape = (symbol = 'TEST', rank = 30) => (e, st, tg) => risk.shapeTrade(e, st, tg, { symbol, rank });
export const regimeBull = { label: 'risk_on_uptrend', score: 0.5, severe: false, allowLongs: true, riskMult: 1, probShiftLong: 0.03, probShiftShort: -0.025, notes: [] };

/** A model standing in for MEASURED history in which this setup reached 2.5R about 40% of the time. Labelled as a fixture everywhere: it exists to test the decision logic, not to claim an edge. */
export function fixtureModel(setups = ['breakout_retest', 'trend_pullback', 'range_breakout', 'momentum_continuation', 'liquidity_sweep', 'trend_reversal']) {
  const hits = [52, 44, 36, 29, 24, 19, 11];                                 // of n = 60 observations
  const tables = {};
  for (const s of setups) tables[`long:${s}`] = { n: 60, hits };
  return buildModel(tables, []);
}

/** run the Brain on a market with coin-level inputs (1h / 24h change taken from the candles themselves) */
export function decideOn(c5, { empirical, regime = regimeBull, rs, news = null } = {}) {
  const T = analyse(c5), h1 = T['1h'], m15 = T['15m'];
  const price = h1.price, back = (n) => c5[Math.max(0, c5.length - 1 - n * 12)].c;
  const chg1h = price / back(1) - 1, chg24h = price / back(24) - 1;
  const d = brain.decide({
    symbol: 'TEST', name: 'Test', ta: T, regime, news, market: null, book: null, chg1h, chg24h, rs: rs ?? { mkt1: 0.001, mkt24: 0.004, btc24: 0.006, eth24: 0.005 },
    smart: null, adj: [], empirical, selected: ['top of the relative-strength ranking'], shape: shape(), vol24: 5e7,
  });
  return { d, T, chg1h, chg24h, price };
}
export { LEVELS };

/** 4. A SHORT: a persistent downtrend, a bounce up into the 1h EMA20 / old swing high, and a rejection with sellers taking over. */
export function failedBounce() {
  const dbase = (h) => 300 * Math.exp(-0.002 * h) * (1 + 0.012 * Math.sin(h / 13) + 0.007 * Math.sin(h / 5));
  const smoothB = (h) => (h < E - 14 ? 0 : h < E - 4 ? 0.045 * smooth(E - 14, E - 4, h) : 0.045 - 0.03 * smooth(E - 4, E, h));        // a bounce ON TOP of the continuing downtrend, rejected near the end
  const price = (h) => dbase(h) * (h < E - 14 ? 1 : 1 + smoothB(h)) * (h < E - 14 ? 1 : 1);
  const vol = (h) => (h >= E - 4 ? 3200 : h >= E - 14 ? 700 : 1000 * (1 + 0.2 * Math.sin(h / 7)));
  return build(price, vol, { seed: 41, noise: 0.003 });
}
export const regimeBear = { label: 'bounce_in_downtrend', score: -0.4, severe: false, allowLongs: true, riskMult: 0.6, probShiftLong: -0.024, probShiftShort: 0.02, notes: [] };
export function fixtureModelShort(setups = ['failed_bounce', 'breakdown_retest', 'breakdown_volume', 'bull_trap']) {
  const hits = [52, 44, 36, 29, 24, 19, 11], tables = {};
  for (const s of setups) tables[`short:${s}`] = { n: 60, hits };
  return buildModel(tables, []);
}
