// Market-structure engine. Pure functions, no I/O. Candles are { t (unix s), o, h, l, c, v } oldest -> newest; the LAST candle is the still-forming one.
// Everything structural (swings, levels, ranges, candle patterns, buyer/seller pressure) is computed from COMPLETED candles only; the forming candle only supplies the live price.
// The Brain (brain.js) consumes this output; every number it reports comes from here, so explanations are built from the inputs the decision actually used.
import { ema, rsi, atr, macdHist, aggregate } from './indicators.js';

const last = (a) => a[a.length - 1];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Confirmed swing highs/lows: a pivot needs `L` lower bars before and `R` bars after it that do not exceed it. */
export function pivots(c, L = 3, R = 3) {
  const highs = [], lows = [];
  for (let i = L; i < c.length - R; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= L; k++) { if (c[i - k].h >= c[i].h) isH = false; if (c[i - k].l <= c[i].l) isL = false; }
    for (let k = 1; k <= R; k++) { if (c[i + k].h > c[i].h) isH = false; if (c[i + k].l < c[i].l) isL = false; }
    if (isH) highs.push({ i, p: c[i].h, t: c[i].t });
    if (isL) lows.push({ i, p: c[i].l, t: c[i].t });
  }
  return { highs, lows };
}

/** Trend from swing structure (higher highs / higher lows vs lower highs / lower lows) plus EMA alignment and slope. score in -1..1. */
function trendOf(done, price, a, piv, e20, e50, slope50) {
  const h2 = piv.highs.slice(-2), l2 = piv.lows.slice(-2), tol = 0.3 * a;       // a swing counts as higher / lower only if it differs by more than 0.3 ATR: equal-ish swings are a range, not a trend
  const hh = h2.length === 2 && h2[1].p > h2[0].p + tol, lh = h2.length === 2 && h2[1].p < h2[0].p - tol;
  const hl = l2.length === 2 && l2[1].p > l2[0].p + tol, ll = l2.length === 2 && l2[1].p < l2[0].p - tol;
  let s = 0;
  if (hh) s += 0.3; if (hl) s += 0.3; if (lh) s -= 0.3; if (ll) s -= 0.3;
  s += e20 > e50 ? 0.1 : -0.1;                                    // EMAs alone can never make a trend: at most +-0.25 without a swing-structure vote
  s += price > e50 ? 0.1 : -0.1;
  s += clamp(slope50 / 3, -0.05, 0.05);
  s = clamp(s, -1, 1);
  const state = s >= 0.6 ? 'strong_up' : s > 0.25 ? 'up' : s <= -0.6 ? 'strong_down' : s < -0.25 ? 'down' : 'range';
  const confirmedHighs = piv.highs.filter((x) => !x.provisional), confirmedLows = piv.lows.filter((x) => !x.provisional);
  const lastHigh = last(confirmedHighs)?.p ?? null, lastLow = last(confirmedLows)?.p ?? null;
  const closeNow = last(done).c;
  // Break of structure: a downtrend whose last lower-high is taken out (early reversal), or an uptrend whose last higher-low is lost (early weakness).
  const bullBreak = (lh || ll || s < 0) && lastHigh != null && closeNow > lastHigh;
  const bearBreak = (hh || hl || s > 0) && lastLow != null && closeNow < lastLow;
  return { state, score: +s.toFixed(3), hh, hl, lh, ll, lastHigh, lastLow, bullBreak, bearBreak, higherLowAfterLow: l2.length === 2 && hl };
}

/** Support / resistance from clustered swing points (a level touched more often is stronger). */
function levelsOf(piv, price, a, done) {
  const tol = Math.max(a * 0.5, price * 0.002);
  const pts = [...piv.highs.map((x) => x.p), ...piv.lows.map((x) => x.p)].sort((x, y) => x - y);
  const cl = [];
  for (const p of pts) { const k = last(cl); if (k && p - k.max <= tol) { k.max = p; k.sum += p; k.n++; } else cl.push({ max: p, sum: p, n: 1 }); }
  const all = cl.map((k) => ({ price: k.sum / k.n, touches: k.n }));
  const hi100 = Math.max(...done.slice(-100).map((x) => x.h)), lo100 = Math.min(...done.slice(-100).map((x) => x.l));
  if (!all.some((x) => Math.abs(x.price - hi100) < tol)) all.push({ price: hi100, touches: 1, extreme: 'high' });
  if (!all.some((x) => Math.abs(x.price - lo100) < tol)) all.push({ price: lo100, touches: 1, extreme: 'low' });
  const below = all.filter((x) => x.price < price * 0.9995).sort((x, y) => y.price - x.price);
  const above = all.filter((x) => x.price > price * 1.0005).sort((x, y) => x.price - y.price);
  return { support: below[0] ?? null, support2: below[1] ?? null, resistance: above[0] ?? null, resistance2: above[1] ?? null, count: all.length };
}

/** Box / range: a sideways window with at least two touches of both edges, little net drift, and a sensible height. Also reports what price did after it. */
function boxOf(done, price, a, n = 36) {
  let best = null;
  for (let skip = 0; skip <= 10; skip++) {
    if (done.length < n + skip + 5) break;
    const w = done.slice(done.length - n - skip, done.length - skip);
    const hi = Math.max(...w.map((x) => x.h)), lo = Math.min(...w.map((x) => x.l)), h = hi - lo;
    if (!(h > 0)) continue;
    const hiT = w.filter((x) => x.h >= hi - 0.15 * h).length, loT = w.filter((x) => x.l <= lo + 0.15 * h).length;
    const mean5 = (x) => x.reduce((t, k) => t + k.c, 0) / x.length;
    const drift = Math.abs(mean5(w.slice(-5)) - mean5(w.slice(0, 5))) / h;      // net drift between the start and the end of the window (5-bar averages, so one noisy bar cannot decide it)
    if (!(h / a >= 1.5 && h / a <= 9 && hiT >= 2 && loT >= 2 && drift < 0.5)) continue;
    const after = done.slice(done.length - skip);          // bars completed after the window
    const mid = (hi + lo) / 2;
    const out = { hi, lo, mid, height: h, heightAtr: +(h / a).toFixed(2), skip, bars: n, pos: +((price - lo) / h).toFixed(2), state: 'inside',
      brokeUp: false, brokeDown: false, fakeUp: false, fakeDown: false, retest: false, barsSinceBreak: null, extensionAtr: 0 };
    const upIdx = after.findIndex((x) => x.c > hi + 0.1 * a), dnIdx = after.findIndex((x) => x.c < lo - 0.1 * a);
    if (upIdx >= 0) {
      const tail = after.slice(upIdx);
      if (price > hi && tail.every((x) => x.c > hi - 0.1 * a)) {
        out.brokeUp = true; out.state = 'breakout_up'; out.barsSinceBreak = after.length - upIdx; out.extensionAtr = +((price - hi) / a).toFixed(2);
        out.retest = tail.slice(1).some((x) => x.l <= hi + 0.3 * a && x.c >= hi - 0.1 * a);
      } else if (price <= hi) { out.fakeUp = true; out.state = 'fake_breakout_up'; }       // closed above, then fell back inside: a bull trap
    } else if (dnIdx >= 0) {
      const tail = after.slice(dnIdx);
      if (price < lo && tail.every((x) => x.c < lo + 0.1 * a)) { out.brokeDown = true; out.state = 'breakdown'; out.barsSinceBreak = after.length - dnIdx; out.extensionAtr = +((lo - price) / a).toFixed(2); out.retest = tail.slice(1).some((x) => x.h >= lo - 0.3 * a && x.c <= lo + 0.1 * a); }   // retest = price came back up to the old range low and failed there
      else if (price >= lo) { out.fakeDown = true; out.state = 'fake_breakdown'; }          // closed below, then reclaimed: a bear trap
    }
    if (out.state === 'inside' && after.some((x) => x.l < lo - 0.05 * a && x.c > lo)) { out.fakeDown = true; out.state = 'liquidity_sweep_low'; }   // wick below the range, closed back inside
    if (out.state === 'inside' && after.some((x) => x.h > hi + 0.05 * a && x.c < hi)) { out.fakeUp = true; out.state = 'liquidity_sweep_high'; }
    if (!best || out.height < best.height) best = out;          // tightest window wins: one that swallowed the breakout bars is wide
  }
  return best;
}

/** Liquidity sweep: a wick through the latest swing low (or high) that closes straight back, in the last 3 completed bars. */
function sweepOf(done, piv, a) {
  const out = { bullish: null, bearish: null };
  const recent = done.slice(-3);
  const lows = piv.lows.filter((p) => p.i < done.length - 3).slice(-3), highs = piv.highs.filter((p) => p.i < done.length - 3).slice(-3);
  for (const x of recent) {
    const r = x.h - x.l; if (!(r > 0)) continue;
    const lw = (Math.min(x.o, x.c) - x.l) / r, uw = (x.h - Math.max(x.o, x.c)) / r;
    for (const lv of lows) if (x.l < lv.p - 0.05 * a && x.c > lv.p && lw >= 0.4) out.bullish = { level: lv.p, wickLow: Math.min(x.l, out.bullish?.wickLow ?? Infinity), depthAtr: +((lv.p - x.l) / a).toFixed(2), lowerWick: +lw.toFixed(2) };
    for (const hv of highs) if (x.h > hv.p + 0.05 * a && x.c < hv.p && uw >= 0.4) out.bearish = { level: hv.p, depthAtr: +((x.h - hv.p) / a).toFixed(2), upperWick: +uw.toFixed(2) };
  }
  return out;
}

/** Candlestick patterns on the last completed bars, with bias (+bullish / -bearish) and strength 0..1. Location (at support / resistance) amplifies them. */
function candlesOf(done, a, lv, price) {
  const [z, y, x] = done.slice(-3);
  const pats = [];
  if (!x || !y || !z) return { patterns: pats, score: 0, atSupport: false, atResistance: false };
  const body = (k) => Math.abs(k.c - k.o), range = (k) => Math.max(k.h - k.l, 1e-12), up = (k) => k.c > k.o, dn = (k) => k.c < k.o;
  const upperW = (k) => k.h - Math.max(k.o, k.c), lowerW = (k) => Math.min(k.o, k.c) - k.l;
  const sig = clamp(range(x) / a, 0.3, 2) / 2;                       // bigger-than-noise bars carry more weight
  const priorDown = done.length > 6 && done[done.length - 6].c > done[done.length - 2].c * 1.004;
  const priorUp = done.length > 6 && done[done.length - 6].c < done[done.length - 2].c * 0.996;
  const add = (name, bias, strength) => pats.push({ name, bias, strength: +clamp(strength, 0.1, 1).toFixed(2) });
  if (range(x) >= 0.3 * a) {
    if (dn(y) && up(x) && x.o <= y.c && x.c >= y.o && body(x) > body(y)) add('bullish_engulfing', 1, 0.6 + sig * 0.4);
    if (up(y) && dn(x) && x.o >= y.c && x.c <= y.o && body(x) > body(y)) add('bearish_engulfing', -1, 0.6 + sig * 0.4);
    if (lowerW(x) >= 2 * body(x) && upperW(x) <= Math.max(body(x), 0.15 * range(x)) && body(x) / range(x) < 0.4 && priorDown) add('hammer', 1, 0.55 + sig * 0.3);
    if (upperW(x) >= 2 * body(x) && lowerW(x) <= Math.max(body(x), 0.15 * range(x)) && body(x) / range(x) < 0.4 && priorUp) add('shooting_star', -1, 0.55 + sig * 0.3);
    if (lowerW(x) >= 0.6 * range(x) && (x.c - x.l) / range(x) >= 0.6 && !pats.some((p) => p.name === 'hammer')) add('bullish_pin_bar', 1, 0.45 + sig * 0.3);
    if (upperW(x) >= 0.6 * range(x) && (x.h - x.c) / range(x) >= 0.6 && !pats.some((p) => p.name === 'shooting_star')) add('bearish_pin_bar', -1, 0.45 + sig * 0.3);
    if (dn(z) && body(z) >= 0.5 * range(z) && body(y) <= 0.35 * body(z) && up(x) && x.c > (z.o + z.c) / 2) add('morning_star', 1, 0.7);
    if (up(z) && body(z) >= 0.5 * range(z) && body(y) <= 0.35 * body(z) && dn(x) && x.c < (z.o + z.c) / 2) add('evening_star', -1, 0.7);
    if (up(z) && up(y) && up(x) && y.c > z.c && x.c > y.c && y.o >= z.o && x.o >= y.o && body(x) >= 0.5 * range(x)) add('three_white_soldiers', 1, 0.7);
    if (dn(z) && dn(y) && dn(x) && y.c < z.c && x.c < y.c && body(x) >= 0.5 * range(x)) add('three_black_crows', -1, 0.7);
    if (body(x) >= 0.75 * range(x) && range(x) >= 1.2 * a) add(up(x) ? 'bullish_momentum_bar' : 'bearish_momentum_bar', up(x) ? 1 : -1, 0.5);
  }
  if (body(x) <= 0.1 * range(x) && range(x) >= 0.5 * a) add('doji', 0, 0.3);
  if (x.h < y.h && x.l > y.l) add('inside_bar', 0, 0.2);
  const near = (p) => p != null && Math.abs(price - p) <= 0.6 * a;
  const atSupport = near(lv.support?.price) || near(lv.support2?.price), atResistance = near(lv.resistance?.price) || near(lv.resistance2?.price);
  if (atSupport && lowerW(x) >= 0.5 * range(x) && range(x) >= 0.3 * a) add('rejection_of_lows', 1, 0.6);
  if (atResistance && upperW(x) >= 0.5 * range(x) && range(x) >= 0.3 * a) add('rejection_of_highs', -1, 0.6);
  let score = pats.reduce((s, p) => s + p.bias * p.strength, 0);
  if (atSupport && score > 0) score *= 1.3;
  if (atResistance && score < 0) score *= 1.3;
  if (atResistance && score > 0) score *= 0.6;                         // a bullish bar INTO resistance is worth less
  return { patterns: pats, score: +clamp(score, -1, 1).toFixed(2), atSupport, atResistance };
}

const buyPressure = (w) => { let num = 0, den = 0; for (const k of w) { const r = k.h - k.l, clv = r > 0 ? ((k.c - k.l) - (k.h - k.c)) / r : 0; num += clv * k.v; den += k.v; } return den > 0 ? num / den : 0; };

/** Who is in control: volume-weighted close location (buyers close bars near the high on volume, sellers near the low), shifts between the two, and absorption. */
function pressureOf(done, a, lv, price) {
  const recent = done.slice(-8), prior = done.slice(-20, -8);
  const r = buyPressure(recent), p = buyPressure(prior), all = buyPressure(done.slice(-20));
  const control = r >= 0.2 ? 'demand_control' : r <= -0.2 ? 'supply_control' : 'balanced';
  const shift = r >= 0.15 && p <= 0.05 ? 'demand_takeover' : r <= -0.15 && p >= -0.05 ? 'supply_takeover' : 'none';   // supply -> demand / demand -> supply
  const upVol = recent.filter((k) => k.c >= k.o).reduce((s, k) => s + k.v, 0), dnVol = recent.filter((k) => k.c < k.o).reduce((s, k) => s + k.v, 0);
  const av20 = avg(done.slice(-23, -3).map((k) => k.v)), last3 = done.slice(-3);
  let absorption = null;
  if (av20 > 0 && avg(last3.map((k) => k.v)) > 1.5 * av20 && avg(last3.map((k) => k.h - k.l)) < 0.8 * a) {
    const clv = buyPressure(last3);
    if (clv > 0.2 && lv.support && price - lv.support.price <= 1.2 * a) absorption = 'demand_absorbing_at_support';
    if (clv < -0.2 && lv.resistance && lv.resistance.price - price <= 1.2 * a) absorption = 'supply_absorbing_at_resistance';
  }
  return { pressure: +all.toFixed(2), recent: +r.toFixed(2), prior: +p.toFixed(2), control, shift, upVolRatio: dnVol + upVol > 0 ? +(upVol / (upVol + dnVol)).toFixed(2) : 0.5, absorption };
}

function volumeOf(done) {
  if (done.length < 25) return { rvol: null, rvol3: null, trend: null };
  const cur = last(done).v, prior = done.slice(-21, -1), av = avg(prior.map((k) => k.v));
  const av3 = avg(done.slice(-3).map((k) => k.v));
  const base = avg(done.slice(-25, -5).map((k) => k.v));
  return { rvol: av > 0 ? +(cur / av).toFixed(2) : null, rvol3: av > 0 ? +(av3 / av).toFixed(2) : null, trend: base > 0 ? +(avg(done.slice(-5).map((k) => k.v)) / base).toFixed(2) : null };
}

function momentumOf(done, price, a, e20) {
  const closes = done.map((k) => k.c);
  const roc = (n) => (closes.length > n ? price / closes[closes.length - 1 - n] - 1 : 0);
  const r = rsi(closes), m = macdHist(closes);
  const ext = e20 ? (price - e20) / a : 0;
  let s = 0;
  if (r != null) s += clamp((r - 50) / 30, -0.5, 0.5);
  if (m) { s += m.hist > 0 ? 0.25 : -0.25; if (m.prevHist != null) s += m.hist > m.prevHist ? 0.15 : -0.15; }
  s += clamp(roc(6) / Math.max(a / price * 2, 0.002), -0.3, 0.3);
  return { rsi: r != null ? +r.toFixed(1) : null, macdHist: m?.hist ?? null, macdRising: m && m.prevHist != null ? m.hist > m.prevHist : null, roc3: +roc(3).toFixed(4), roc6: +roc(6).toFixed(4), roc24: +roc(24).toFixed(4), extensionAtr: +ext.toFixed(2), overextended: ext > 3.5 || (r != null && r > 82), score: +clamp(s, -1, 1).toFixed(2) };
}

/**
 * What has ALREADY happened (anti-chasing inputs): run-up / drop over the last bars in ATRs, where the biggest volume spike of the last 12 bars was and how far price travelled since it,
 * and how far price is from the latest swing low / high. All from completed bars; nothing here predicts, it only measures the move that is already behind us.
 */
function recentOf(done, price, a, piv) {
  const w6 = done.slice(-6), w12 = done.slice(-12);
  const lo12 = Math.min(...w12.map((k) => k.l)), hi12 = Math.max(...w12.map((k) => k.h)), lo6 = Math.min(...w6.map((k) => k.l));
  let spike = { rvol: 0, ageBars: null, movedUpAtr: 0, movedDownAtr: 0 };
  for (let i = done.length - 24; i < done.length; i++) {
    const prior = done.slice(Math.max(0, i - 20), i), av = avg(prior.map((k) => k.v));
    const r = av > 0 ? done[i].v / av : 0;
    if (r > spike.rvol) spike = { rvol: +r.toFixed(2), ageBars: done.length - 1 - i, movedUpAtr: +((price - done[i].o) / a).toFixed(2), movedDownAtr: +((done[i].o - price) / a).toFixed(2) };
  }
  const lastLow = last(piv.lows)?.p, lastHigh = last(piv.highs)?.p;
  return {
    runUp6: +(price / lo6 - 1).toFixed(4), runUpAtr12: +((price - lo12) / a).toFixed(2), dropAtr12: +((hi12 - price) / a).toFixed(2), runUp12: +(price / lo12 - 1).toFixed(4), drop12: +(1 - price / hi12).toFixed(4),
    spike, fromSwingLowAtr: lastLow != null ? +((price - lastLow) / a).toFixed(2) : null, fromSwingHighAtr: lastHigh != null ? +((lastHigh - price) / a).toFixed(2) : null, low12: lo12, high12: hi12,
  };
}

/** Full structural read of ONE timeframe. Returns null when there is not enough completed history. */
export function analyze(candles, tf = '') {
  if (!candles || candles.length < 60) return null;
  const done = candles.slice(0, -1), price = last(candles).c;
  const a = atr(done) ?? 0;
  if (!(a > 0) || !(price > 0)) return null;
  const closes = done.map((k) => k.c), e20s = ema(closes, 20), e50s = ema(closes, 50);
  const e20 = last(e20s), e50 = last(e50s), slope50 = e50s.length > 11 ? (e50 - e50s[e50s.length - 11]) / a : 0;
  const piv = pivots(done);
  // A pivot needs 3 bars after it, so a smooth grind to new highs (or a slide to new lows) has no NEW confirmed swing. The running extreme since the last pivot counts as a provisional swing for the trend read.
  const provHigh = piv.highs.length ? Math.max(...done.slice(piv.highs[piv.highs.length - 1].i + 1).map((k) => k.h)) : null, provLow = piv.lows.length ? Math.min(...done.slice(piv.lows[piv.lows.length - 1].i + 1).map((k) => k.l)) : null;
  const tolP = 0.3 * a;
  const trendPiv = { highs: provHigh != null && provHigh > last(piv.highs).p + tolP ? [...piv.highs, { i: done.length - 1, p: provHigh, provisional: true }] : piv.highs, lows: provLow != null && provLow < last(piv.lows).p - tolP ? [...piv.lows, { i: done.length - 1, p: provLow, provisional: true }] : piv.lows };
  const trend = trendOf(done, price, a, trendPiv, e20, e50, slope50);
  const lv = levelsOf(piv, price, a, done);
  const out = {
    tf, price, atr: a, atrPct: +(a / price).toFixed(4), ema20: e20, ema50: e50, aboveEma20: price > e20, aboveEma50: price > e50,
    trend, levels: lv, box: boxOf(done, price, a), sweep: sweepOf(done, piv, a), candles: candlesOf(done, a, lv, price),
    flow: pressureOf(done, a, lv, price), volume: volumeOf(done), momentum: momentumOf(done, price, a, e20), recent: recentOf(done, price, a, piv),
    swing: { lastLow: last(piv.lows)?.p ?? null, prevLow: piv.lows.at(-2)?.p ?? null, lastHigh: last(piv.highs)?.p ?? null, prevHigh: piv.highs.at(-2)?.p ?? null },
    lastBar: { o: last(done).o, h: last(done).h, l: last(done).l, c: last(done).c, t: last(done).t },
  };
  return out;
}

/** The five working timeframes from raw Coinbase candles: 1d, 4h (aggregated from 1h), 1h, 15m, 5m. */
export function analyzeAll({ d1, h1, m15, m5 }) {
  return { '1d': analyze(d1, '1d'), '4h': analyze(aggregate(h1, 4 * 3600), '4h'), '1h': analyze(h1, '1h'), '15m': analyze(m15, '15m'), '5m': analyze(m5, '5m') };
}
