// THE BRAIN: the AI's own decision for ONE coin, split into three separate questions that must each pass on their own:
//   1. DIRECTION      LONG, SHORT or neither? (structure, supply/demand, relative strength, one momentum family, regime/news context)
//   2. TIMING         is NOW a good entry? (anti-chasing: move already made, distance from the level / swing, spent volume spike, stretch, share of the move already used; a concrete trigger)
//   3. TRADE GEOMETRY is the reward worth the risk? (structural stop, realistic target, net R:R, EMPIRICAL P(target before stop), expected value)
// A strong direction with bad timing is WAIT. The overall score is the WEAKEST of the three, so an 85 cannot hide a poor entry.
//   decide() -> { action: BUY | SHORT | WATCH | IGNORE, verdict: LONG | SHORT | WAIT | IGNORE, direction, cls, scores{direction,timing,geometry}, why{coin,direction,price,now,confirms,invalidates,failure}, ... }
// Pure functions: no I/O, no LLM, no randomness. Every reason is generated from the numbers that fed the decision. Other traders are a 1%-weight input and can never create a trade
// or lift a veto. Nothing here can touch the risk limits (guardrails.js has the last word).
import { config } from './config.js';
import { buildModel } from './empirical.js';

const B = config.brain, W = B.weights;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f2 = (x) => (x == null || !Number.isFinite(x) ? '?' : Math.abs(x) >= 100 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(3) : x.toPrecision(4));
const pc = (x) => `${(x * 100).toFixed(1)}%`;
const lo = (x, k) => (x == null ? null : x - k);   // null-safe "level minus buffer"
const hi = (x, k) => (x == null ? null : x + k);
const tfs = (T) => ({ d1: T['1d'], h4: T['4h'], h1: T['1h'], m15: T['15m'], m5: T['5m'] });
const isUp = (t) => !!t && t.trend.score >= 0.25;
const isDown = (t) => !!t && t.trend.score <= -0.25;
const stateName = { strong_up: 'strong uptrend', up: 'uptrend', range: 'sideways', down: 'downtrend', strong_down: 'strong downtrend' };
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const DEFAULT_MODEL = buildModel({}, []);       // zero-drift prior only: used when no measured history is supplied (tests, first run)

/** Legacy score -> probability prior. Kept for the unit tests and for displays that have no setup; real decisions use the empirical model. */
export function probability(score, calib = B.calib) {
  return +clamp(calib.floor + (calib.ceil - calib.floor) * sigmoid((score - calib.mid) / calib.width), calib.floor, calib.ceil).toFixed(3);
}

/**
 * Market regime from BTC (and ETH) structure plus breadth. It is a MODIFIER (probability shift and a risk multiplier), not a switch: only a genuinely severe market (BTC in a
 * strong 4h AND 1h downtrend, or a fast crash) sets `severe`, and only `severe` blocks new longs. score -1..1.
 */
export function marketRegime({ btc, eth, breadth, btcGate }) {
  const t = (x) => (x ? x.trend.score : 0);
  const b1 = btc?.['1h'], b4 = btc?.['4h'], bd = btc?.['1d'];
  if (!b1 || !b4) return { label: 'unknown', score: 0, severe: false, allowLongs: true, riskMult: 0.6, probShiftLong: -0.03, probShiftShort: 0, notes: ['BTC structure not available yet: trading at reduced size'], breadth: breadth ?? null };
  let s = 0.2 * t(bd) + 0.35 * t(b4) + 0.35 * t(b1);
  if (eth?.['1h']) s += 0.1 * t(eth['1h']);
  if (breadth != null) s += clamp((breadth - 0.4) / 0.4, -1, 1) * 0.15;
  s = clamp(s / 1.15, -1, 1);
  const up1 = isUp(b1), up4 = isUp(b4), dn1 = isDown(b1), dn4 = isDown(b4);
  let label;
  if (up4 && up1) label = 'risk_on_uptrend';
  else if (up4 && dn1) label = 'pullback_in_uptrend';
  else if (!dn4 && up1) label = 'recovering';
  else if (dn4 && dn1) label = 'risk_off_downtrend';
  else if (dn4 && !dn1) label = 'bounce_in_downtrend';
  else label = 'range';
  const crash = b1.momentum.roc6 <= -0.05 || b4.momentum.roc6 <= -0.08;                 // -5% in 6h or -8% in 24h
  const severe = (b4.trend.score <= -0.6 && b1.trend.score <= -0.6) || crash;
  const notes = [`BTC 1d ${stateName[bd?.trend.state] ?? 'n/a'}, 4h ${stateName[b4.trend.state]}, 1h ${stateName[b1.trend.state]}`];
  if (eth?.['1h']) notes.push(`ETH 1h ${stateName[eth['1h'].trend.state]}`);
  if (breadth != null) notes.push(`${(breadth * 100).toFixed(0)}% of analysed coins in a 1h uptrend`);
  if (severe) notes.push(crash ? 'BTC is crashing (-5% in 6h or -8% in 24h): new longs are blocked' : 'BTC is in a strong 4h AND 1h downtrend: new longs are blocked');
  else if (s < -0.25) notes.push('regime is bearish but not severe: longs are still judged on their own merits, with a lower probability and half-ish size');
  const riskMult = severe ? 0 : s >= 0.25 ? 1 : s > -0.25 ? 0.85 : 0.6;
  return { label, score: +s.toFixed(2), severe, allowLongs: !severe, riskMult, probShiftLong: +clamp(s * 0.06, -0.06, 0.04).toFixed(3), probShiftShort: +clamp(-s * 0.05, -0.05, 0.05).toFixed(3), notes, breadth: breadth ?? null };
}

const flowScore = (t) => (t ? clamp(t.flow.recent * 1.6, -1, 1) + (t.flow.shift === 'demand_takeover' ? 0.25 : t.flow.shift === 'supply_takeover' ? -0.25 : 0) + (t.flow.absorption === 'demand_absorbing_at_support' ? 0.2 : t.flow.absorption === 'supply_absorbing_at_resistance' ? -0.2 : 0) : 0);
const wavg = (pairs) => { let s = 0, w = 0; for (const [v, k] of pairs) if (v != null) { s += v * k; w += k; } return w ? s / w : 0; };

/** Structural stop candidates -> the nearest valid one: at least `minDist` away from price on the protective side. */
function pickStop(price, refs, minDist, side) {
  const ok = refs.filter((x) => x != null && Number.isFinite(x) && (side === 'long' ? price - x : x - price) >= minDist).sort((a, b) => (side === 'long' ? b - a : a - b));
  return ok[0] ?? null;
}

/* ================================================================== LONG setups */
/** Each setup: { name, label, quality 0..1, level (the price it is anchored to), levelTf, trigger[] + triggerStrength 0..1 (the concrete reason to act NOW), stopRefs[], targetRefs[], why[] }. */
function detectLongSetups(T, ctx) {
  const { d1, h4, h1, m15, m5 } = tfs(T), price = h1.price, out = [];
  const a1 = h1.atr, a15 = m15.atr;
  const demandNow = (t) => t && (t.flow.shift === 'demand_takeover' || t.flow.control === 'demand_control' || t.flow.absorption === 'demand_absorbing_at_support');
  const bullCandle = (t) => t && t.candles.score >= 0.3;
  const bullPats = (...ts) => [...new Set(ts.flatMap((t) => t.candles.patterns.filter((p) => p.bias > 0).map((p) => p.name.replace(/_/g, ' '))))];
  const m15Turn = m15.trend.bullBreak || m15.trend.score > -0.25 || !!m15.sweep.bullish || demandNow(m15);

  // A. Pullback inside an uptrend: buy support / the 1h EMA20 after the dip, not the middle of the move.
  if (h1.trend.score >= 0.25 && h4.trend.score >= 0) {
    const nearEma = price <= h1.ema20 + 0.3 * a1 && price >= h1.ema50 - 0.3 * a1;
    const sup = h1.levels.support, nearSup = sup && price - sup.price <= 1.0 * a1;
    const rsiOk = h1.momentum.rsi != null && h1.momentum.rsi >= 35 && h1.momentum.rsi <= 62;
    const trigger = bullCandle(m15) || bullCandle(h1) || !!m15.sweep.bullish || m15.trend.bullBreak || m15.flow.shift === 'demand_takeover';
    if ((nearEma || nearSup) && rsiOk && trigger && m15Turn) {
      let q = 0.5; const why = [`1h ${stateName[h1.trend.state]} pulled back to ${nearSup ? `support ${f2(sup.price)}` : `its EMA20 ${f2(h1.ema20)}`} (RSI ${h1.momentum.rsi})`], trig = [];
      if (h4.trend.score >= 0.25) { q += 0.1; why.push('4h trend up as well'); }
      if (bullCandle(m15) || bullCandle(h1)) { q += 0.1; const p = bullPats(m15, h1); why.push(`bullish candle evidence: ${p.join(', ') || 'rejection'}`); trig.push(`${p.join('/') || 'rejection'} candle at ${nearSup ? 'support' : 'the 1h EMA20'}`); }
      if (m15.flow.shift === 'demand_takeover' || h1.flow.shift === 'demand_takeover') { q += 0.1; why.push('buyers taking control from sellers (supply -> demand shift)'); trig.push('supply -> demand shift just occurred'); }
      if (m15.sweep.bullish) trig.push('15m liquidity sweep reclaimed');
      if (m15.trend.bullBreak) trig.push('15m broke its last lower-high');
      if (sup && sup.touches >= 2) { q += 0.1; why.push(`support tested ${sup.touches}x`); }
      if (h1.volume.trend != null && h1.volume.trend < 1) { q += 0.05; why.push('selling volume drying up on the dip'); }
      out.push({ name: 'trend_pullback', label: 'Pullback in an uptrend', quality: clamp(q, 0.3, 1), level: nearSup ? sup.price : h1.ema20, levelTf: 'h1', trigger: trig, triggerStrength: clamp(0.35 + 0.2 * trig.length, 0, 1), why, stopRefs: [lo(m15.sweep.bullish?.wickLow, 0.25 * a15), lo(m15.swing.lastLow, 0.25 * a15), sup ? sup.price - 0.3 * a1 : null, lo(h1.swing.lastLow, 0.25 * a1)], targetRefs: [h1.levels.resistance?.price, h1.levels.resistance2?.price, h1.swing.lastHigh] });
    }
  }

  // B. Breakout of a box / range that has been retested and held (the preferred entry: breakout -> confirmation -> retest -> entry), on 1h or 15m.
  for (const t of [h1, m15]) {
    const bx = t.box;
    if (bx && bx.brokeUp && bx.retest && bx.extensionAtr <= 2.2 && !isDown(h4) && t.flow.recent > -0.1) {
      const q = 0.55 + (t.volume.rvol3 >= 1.2 ? 0.1 : 0) + (demandNow(t) ? 0.1 : 0) + (bx.heightAtr >= 3 ? 0.05 : 0) + (isUp(h1) ? 0.1 : 0);
      out.push({ name: 'breakout_retest', label: 'Range breakout + retest', quality: clamp(q, 0.3, 1), level: bx.hi, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`price retested the broken range high ${f2(bx.hi)} and held`], triggerStrength: 0.8 + (demandNow(t) ? 0.1 : 0), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} broken up ${bx.barsSinceBreak} bars ago, retested ${f2(bx.hi)} and held`, ...(demandNow(t) ? ['demand in control after the break'] : [])], stopRefs: [lo(bx.hi, 0.6 * t.atr), bx.mid, lo(t.swing.lastLow, 0.25 * t.atr)], targetRefs: [bx.hi + bx.height, h1.levels.resistance?.price, h1.levels.resistance2?.price] });
      break;
    }
  }

  // C. Fresh range breakout with volume: only valid while price is still right at the level (the extension rule below turns a late one into WAIT-for-retest).
  for (const t of [h1, m15]) {
    const bx = t.box, rv = Math.max(t.volume.rvol ?? 0, t.volume.rvol3 ?? 0);
    if (bx && bx.brokeUp && !bx.retest && bx.barsSinceBreak <= 4 && bx.extensionAtr <= 1.3 && rv >= 1.5 && !isDown(h4) && (demandNow(t) || t.flow.recent > 0.1) && !h1.momentum.overextended) {
      const q = 0.5 + (rv >= 2.5 ? 0.15 : 0.05) + (isUp(h1) ? 0.1 : 0) + (isUp(h4) ? 0.1 : 0);
      out.push({ name: 'range_breakout', label: 'Range breakout with volume', quality: clamp(q, 0.3, 1), level: bx.hi, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`closed ${bx.extensionAtr} ATR above the range high on ${rv.toFixed(1)}x volume`], triggerStrength: clamp(0.4 + (rv >= 2.5 ? 0.2 : 0.1) + (bx.extensionAtr <= 0.6 ? 0.2 : 0), 0, 1), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} just broken up on ${rv.toFixed(1)}x volume (${bx.extensionAtr} ATR beyond the edge)`], stopRefs: [lo(bx.hi, 0.6 * t.atr), bx.mid], targetRefs: [bx.hi + bx.height, h1.levels.resistance?.price, h1.levels.resistance2?.price] });
      break;
    }
  }

  // D. Early trend reversal: a downtrend whose last lower-high is broken, with a higher low and buyers taking over.
  const rev1 = h1.trend.bullBreak && h1.swing.lastLow > (h1.swing.prevLow ?? Infinity) && (h1.flow.shift === 'demand_takeover' || h1.flow.control === 'demand_control') && h1.momentum.score > 0;
  const rev15 = m15.trend.bullBreak && m15.flow.shift === 'demand_takeover' && m15.swing.lastLow > (m15.swing.prevLow ?? Infinity) && h1.trend.score > -0.6;
  if ((rev1 || rev15) && h4.trend.state !== 'strong_down') {
    const t = rev1 ? h1 : m15, broken = t.trend.lastHigh;
    const chase = broken != null ? (price - broken) / t.atr : 0;
    if (chase <= 2.5 && !t.momentum.overextended) {
      const q = 0.5 + (rev1 ? 0.1 : 0) + (t.volume.rvol3 >= 1.2 ? 0.1 : 0) + (t.candles.score >= 0.3 ? 0.1 : 0) + (h4.trend.score > -0.25 ? 0.1 : 0);
      out.push({ name: 'trend_reversal', label: 'Early trend reversal', quality: clamp(q, 0.3, 1), reversal: true, level: broken, levelTf: rev1 ? 'h1' : 'm15', trigger: [`${t.tf} closed above its last lower-high ${f2(broken)} with a higher low ${f2(t.swing.lastLow)}`], triggerStrength: clamp(0.5 + (t.volume.rvol3 >= 1.2 ? 0.2 : 0) + (t.candles.score >= 0.3 ? 0.15 : 0), 0, 1), why: [`${t.tf} downtrend broke its last lower-high ${f2(broken)} (structure shift), made a higher low ${f2(t.swing.lastLow)} and buyers took control (${t.flow.shift === 'demand_takeover' ? 'supply -> demand shift' : 'demand in control'})`], stopRefs: [lo(t.swing.lastLow, 0.25 * t.atr), lo(m15.swing.lastLow, 0.25 * a15)], targetRefs: [h1.levels.resistance?.price, h1.levels.resistance2?.price, t.swing.prevHigh] });
    }
  }

  // E. Liquidity sweep reclaim: a wick through support / the range low that closes straight back (stops were taken, sellers failed).
  for (const t of [h1, m15]) {
    const sw = t.sweep.bullish, bx = t.box;
    const boxSweep = bx && (bx.state === 'liquidity_sweep_low' || bx.state === 'fake_breakdown');
    if ((sw || boxSweep) && (demandNow(t) || t.candles.score >= 0.3) && h4.trend.state !== 'strong_down' && h1.trend.state !== 'strong_down') {
      const lvl = sw ? sw.level : bx.lo, wick = sw ? sw.wickLow : bx.lo;
      if (price > lvl) {
        const q = 0.55 + (sw && sw.lowerWick >= 0.6 ? 0.1 : 0) + (t.flow.shift === 'demand_takeover' ? 0.1 : 0) + (t.volume.rvol3 >= 1.3 ? 0.1 : 0) + (isUp(h4) ? 0.05 : 0);
        out.push({ name: 'liquidity_sweep', label: 'Liquidity sweep reclaim', quality: clamp(q, 0.3, 1), level: lvl, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`price swept ${f2(lvl)} and closed back above it`], triggerStrength: clamp(0.55 + (t.flow.shift === 'demand_takeover' ? 0.2 : 0) + (t.volume.rvol3 >= 1.3 ? 0.1 : 0), 0, 1), why: [`${t.tf} price swept below ${f2(lvl)} (stops taken) and closed back above it: sellers failed${t.flow.shift === 'demand_takeover' ? ', buyers now taking control' : ''}`], stopRefs: [lo(wick, 0.25 * t.atr), lo(m15.swing.lastLow, 0.25 * a15)], targetRefs: [bx ? bx.mid : null, bx ? bx.hi : null, h1.levels.resistance?.price, h1.levels.resistance2?.price] });
        break;
      }
    }
  }

  // F. Momentum continuation: a coin already moving in a healthy trend, entered only when it has come back close to its short-term mean (never vertical, never extended).
  const strongMove = h1.momentum.roc6 >= 0.025 || h4.momentum.roc6 >= 0.03 || (ctx.chg24h ?? 0) >= 0.07;
  const rv15 = Math.max(m15.volume.rvol ?? 0, m15.volume.rvol3 ?? 0), rv1 = Math.max(h1.volume.rvol ?? 0, h1.volume.rvol3 ?? 0);
  if (strongMove && h1.trend.score >= 0.4 && h4.trend.score >= 0.25 && (h1.flow.control === 'demand_control' || m15.flow.control === 'demand_control') && Math.max(rv15, rv1) >= 1.3
    && !h1.momentum.overextended && !m15.momentum.overextended && m15.momentum.extensionAtr <= 1.2 && (h1.momentum.rsi ?? 50) <= 75) {
    const q = 0.5 + (Math.max(rv15, rv1) >= 2 ? 0.1 : 0) + (isUp(d1) ? 0.1 : 0) + (m15.trend.score >= 0.25 ? 0.1 : 0) + ((ctx.rs24 ?? 0) > 0.03 ? 0.1 : 0);
    out.push({ name: 'momentum_continuation', label: 'Momentum continuation', quality: clamp(q, 0.3, 1), level: m15.ema20, levelTf: 'm15', trigger: [`pulled back to within ${m15.momentum.extensionAtr} ATR of the 15m mean with demand still in control on ${Math.max(rv15, rv1).toFixed(1)}x volume`], triggerStrength: clamp(0.4 + (m15.momentum.extensionAtr <= 0.6 ? 0.25 : 0.1) + (Math.max(rv15, rv1) >= 2 ? 0.1 : 0), 0, 1), why: [`strong mover (1h ${pc(h1.momentum.roc6)} / 6 bars, 24h ${pc(ctx.chg24h ?? 0)}) in a ${stateName[h1.trend.state]} with demand in control on ${Math.max(rv15, rv1).toFixed(1)}x volume; only ${m15.momentum.extensionAtr} ATR above the 15m mean (not vertical)`], stopRefs: [m15.ema20 - a15, lo(m15.swing.lastLow, 0.25 * a15), h1.ema20 - 0.5 * a1], targetRefs: [h1.levels.resistance?.price, h1.levels.resistance2?.price, price + 3 * a1] });
  }
  return out.sort((x, y) => y.quality - x.quality);
}

/* ================================================================== SHORT setups */
// Written from the seller's side, not as a mirror of the long logic: lower highs, failed bounces into resistance, resistance rejection, breakdown + failed retest, bull traps, selling volume.
function detectShortSetups(T, ctx) {
  const { h4, h1, m15 } = tfs(T), price = h1.price, out = [];
  const a1 = h1.atr, a15 = m15.atr;
  const supplyNow = (t) => t && (t.flow.shift === 'supply_takeover' || t.flow.control === 'supply_control' || t.flow.absorption === 'supply_absorbing_at_resistance');
  const bearCandle = (t) => t && t.candles.score <= -0.3;
  const bearPats = (...ts) => [...new Set(ts.flatMap((t) => t.candles.patterns.filter((p) => p.bias < 0).map((p) => p.name.replace(/_/g, ' '))))];
  const res = h1.levels.resistance;

  // A. Failed bounce: 1h downtrend bounced up into resistance / the 1h EMA20 and was rejected.
  if (h1.trend.score <= -0.25 && h4.trend.score <= 0.25) {
    const nearEma = price >= h1.ema20 - 0.5 * a1 && price <= h1.ema20 + 0.3 * a1;
    const atRes = res && res.price - price <= 0.6 * a1 && price - res.price <= 0.2 * a1;
    const rsiOk = h1.momentum.rsi != null && h1.momentum.rsi >= 38 && h1.momentum.rsi <= 64;
    const reject = bearCandle(m15) || bearCandle(h1) || m15.flow.shift === 'supply_takeover' || !!m15.sweep.bearish || m15.trend.bearBreak;
    if ((nearEma || atRes) && rsiOk && reject) {
      let q = 0.5; const why = [`1h ${stateName[h1.trend.state]} (${h1.trend.lh ? 'lower highs' : 'weak structure'}) bounced into ${atRes ? `resistance ${f2(res.price)}` : `its EMA20 ${f2(h1.ema20)}`} and was rejected (RSI ${h1.momentum.rsi})`], trig = [];
      if (h4.trend.score <= -0.25) { q += 0.1; why.push('4h is a downtrend as well'); }
      if (bearCandle(m15) || bearCandle(h1)) { q += 0.1; const p = bearPats(m15, h1); why.push(`rejection evidence: ${p.join(', ') || 'upper wicks'}`); trig.push(`${p.join('/') || 'rejection'} candle at ${atRes ? 'resistance' : 'the 1h EMA20'}`); }
      if (m15.flow.shift === 'supply_takeover' || h1.flow.shift === 'supply_takeover') { q += 0.1; why.push('sellers taking control from buyers (demand -> supply shift)'); trig.push('demand -> supply shift just occurred'); }
      if (m15.sweep.bearish) trig.push('15m failed breakout above a swing high');
      if (m15.trend.bearBreak) trig.push('15m lost its last higher-low');
      if (res && res.touches >= 2) { q += 0.1; why.push(`resistance rejected ${res.touches}x`); }
      out.push({ name: 'failed_bounce', label: 'Failed bounce into resistance', quality: clamp(q, 0.3, 1), level: atRes ? res.price : h1.ema20, levelTf: 'h1', trigger: trig, triggerStrength: clamp(0.35 + 0.2 * trig.length, 0, 1), why, stopRefs: [hi(m15.swing.lastHigh, 0.25 * a15), hi(res?.price, 0.3 * a1), hi(h1.swing.lastHigh, 0.25 * a1)], targetRefs: [h1.levels.support?.price, h1.levels.support2?.price, h1.swing.lastLow] });
    }
  }

  // B. Breakdown below a range that failed its retest from underneath (breakdown -> retest from below fails -> entry).
  for (const t of [h1, m15]) {
    const bx = t.box;
    if (bx && bx.brokeDown && bx.retest && bx.extensionAtr <= 2.2 && !isUp(h4) && t.flow.recent < 0.1) {
      const q = 0.55 + (t.volume.rvol3 >= 1.2 ? 0.1 : 0) + (supplyNow(t) ? 0.1 : 0) + (isDown(h1) ? 0.1 : 0);
      out.push({ name: 'breakdown_retest', label: 'Range breakdown + failed retest', quality: clamp(q, 0.3, 1), level: bx.lo, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`price retested the broken range low ${f2(bx.lo)} from below and failed`], triggerStrength: 0.8 + (supplyNow(t) ? 0.1 : 0), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} broken down ${bx.barsSinceBreak} bars ago; the retest of ${f2(bx.lo)} failed${supplyNow(t) ? '; sellers in control' : ''}`], stopRefs: [hi(bx.lo, 0.6 * t.atr), bx.mid, hi(t.swing.lastHigh, 0.25 * t.atr)], targetRefs: [bx.lo - bx.height, h1.levels.support?.price, h1.levels.support2?.price] });
      break;
    }
  }

  // C. Fresh breakdown on volume (valid only while price is still right at the level).
  for (const t of [h1, m15]) {
    const bx = t.box, rv = Math.max(t.volume.rvol ?? 0, t.volume.rvol3 ?? 0);
    if (bx && bx.brokeDown && !bx.retest && bx.barsSinceBreak <= 4 && bx.extensionAtr <= 1.3 && rv >= 1.5 && !isUp(h4) && (supplyNow(t) || t.flow.recent < -0.1) && (h1.momentum.rsi ?? 50) > 26) {
      const q = 0.5 + (rv >= 2.5 ? 0.15 : 0.05) + (isDown(h1) ? 0.1 : 0) + (isDown(h4) ? 0.1 : 0);
      out.push({ name: 'breakdown_volume', label: 'Range breakdown with volume', quality: clamp(q, 0.3, 1), level: bx.lo, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`closed ${bx.extensionAtr} ATR below the range low on ${rv.toFixed(1)}x volume`], triggerStrength: clamp(0.4 + (rv >= 2.5 ? 0.2 : 0.1) + (bx.extensionAtr <= 0.6 ? 0.2 : 0), 0, 1), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} just broken down on ${rv.toFixed(1)}x volume (${bx.extensionAtr} ATR beyond the edge)`], stopRefs: [hi(bx.lo, 0.6 * t.atr), bx.mid], targetRefs: [bx.lo - bx.height, h1.levels.support?.price, h1.levels.support2?.price] });
      break;
    }
  }

  // D. Bull trap: a break above a swing high / range high that closed straight back inside, with sellers taking over.
  for (const t of [h1, m15]) {
    const sw = t.sweep.bearish, bx = t.box;
    const trap = bx && (bx.state === 'liquidity_sweep_high' || bx.state === 'fake_breakout_up');
    if ((sw || trap) && (supplyNow(t) || t.candles.score <= -0.3) && h4.trend.state !== 'strong_up' && h1.trend.state !== 'strong_up') {
      const lvl = sw ? sw.level : bx.hi;
      if (price < lvl) {
        const q = 0.55 + (sw && sw.upperWick >= 0.6 ? 0.1 : 0) + (t.flow.shift === 'supply_takeover' ? 0.1 : 0) + (t.volume.rvol3 >= 1.3 ? 0.1 : 0) + (isDown(h4) ? 0.05 : 0);
        out.push({ name: 'bull_trap', label: 'Bull trap (failed breakout)', quality: clamp(q, 0.3, 1), level: lvl, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`price broke above ${f2(lvl)} and closed back below it`], triggerStrength: clamp(0.55 + (t.flow.shift === 'supply_takeover' ? 0.2 : 0) + (t.volume.rvol3 >= 1.3 ? 0.1 : 0), 0, 1), why: [`${t.tf} price broke above ${f2(lvl)} (buyers trapped) and closed back below it${t.flow.shift === 'supply_takeover' ? ', sellers now taking control' : ''}`], stopRefs: [hi(t.swing.lastHigh, 0.25 * t.atr), hi(lvl, 0.4 * t.atr)], targetRefs: [bx ? bx.mid : null, bx ? bx.lo : null, h1.levels.support?.price, h1.levels.support2?.price] });
        break;
      }
    }
  }
  return out.sort((x, y) => y.quality - x.quality);
}

/* ================================================================== shared pieces */
/**
 * ANTI-CHASING. How much of the move has ALREADY happened, measured five ways. score 0 (fresh) .. 1 (fully chased).
 * side +1 long / -1 short. level = the setup's anchor price. target = where the trade is aiming.
 */
const RETEST_STYLE = new Set(['trend_pullback', 'breakout_retest', 'liquidity_sweep', 'failed_bounce', 'breakdown_retest', 'bull_trap']);     // entries AT a level after the move: breakout -> retest -> entry
function chaseOf(side, T, setup, price, target) {
  const { h1, m15 } = tfs(T), sgn = side === 'long' ? 1 : -1;
  const mv = (t) => (sgn > 0 ? t.recent.runUpAtr12 : t.recent.dropAtr12);
  const moveAtr = Math.max(mv(h1), mv(m15));
  const tf = setup.levelTf === 'm15' ? m15 : h1;
  const distLevelAtr = setup.level != null ? sgn * (price - setup.level) / tf.atr : 0;            // > 0 = already beyond the level in the trade direction
  const fromSwingAtr = sgn > 0 ? h1.recent.fromSwingLowAtr : h1.recent.fromSwingHighAtr;
  const spikeSpent = [h1, m15].some((t) => t.recent.spike.rvol >= 2.5 && t.recent.spike.ageBars >= 3 && (sgn > 0 ? t.recent.spike.movedUpAtr : t.recent.spike.movedDownAtr) >= 1.5);
  const stretched = sgn > 0 ? (h1.momentum.extensionAtr > 2 || (h1.momentum.rsi ?? 50) > 72 || m15.momentum.extensionAtr > 2.5) : (h1.momentum.extensionAtr < -2 || (h1.momentum.rsi ?? 50) < 28 || m15.momentum.extensionAtr < -2.5);
  const made = sgn * (price - (sgn > 0 ? h1.recent.low12 : h1.recent.high12)), remaining = Math.max(sgn * (target - price), 1e-12);
  const used = made > 0 ? made / (made + remaining) : 0;
  // A retest-style entry sitting back AT its level is the intended sequence (breakout -> confirmation -> retest -> entry): the breakout leg and its volume spike are not 'chasing' it.
  const atLevel = RETEST_STYLE.has(setup.name) && distLevelAtr <= 0.6, k = atLevel ? 0.3 : 1;
  const score = clamp(0.3 * k * clamp(moveAtr / 4, 0, 1) + 0.25 * clamp(distLevelAtr / 2, 0, 1) + 0.2 * k * clamp(used, 0, 1) + 0.15 * (spikeSpent && !atLevel ? 1 : 0) + 0.1 * (stretched ? 1 : 0), 0, 1);
  return { atLevel, score: +score.toFixed(2), moveAtr: +moveAtr.toFixed(2), movePct: sgn > 0 ? h1.recent.runUp12 : h1.recent.drop12, distLevelAtr: +distLevelAtr.toFixed(2), fromSwingAtr: fromSwingAtr == null ? null : +fromSwingAtr.toFixed(2), spikeSpent, stretched, expectedMoveUsed: +used.toFixed(2),
    verdict: score >= B.chaseVeto ? 'chasing' : score >= B.chaseWarn ? 'late' : 'fresh' };
}

/** The entry zone the plan is anchored to. A confirmation outside it is CHASING and does not count. */
function zoneOf(side, setup, price, T) {
  const tf = setup.levelTf === 'm15' ? T['15m'] : T['1h'], a = tf.atr, L = setup.level;
  if (L == null) return { lo: price * 0.998, hi: price * 1.002, planned: price, level: null };
  return side === 'long'
    ? { lo: L - 0.4 * a, hi: L + 0.6 * a, planned: clamp(price, L - 0.4 * a, L + 0.6 * a), level: L }
    : { lo: L - 0.6 * a, hi: L + 0.4 * a, planned: clamp(price, L - 0.6 * a, L + 0.4 * a), level: L };
}

/** TIMING 0..100. Driven by anti-chasing first, then a concrete trigger, whether the flow agrees right now, and whether price is inside the planned zone. */
function timingOf(side, setup, chase, zone, T, price) {
  const { m15 } = tfs(T), sgn = side === 'long' ? 1 : -1;
  const flowNow = clamp(sgn * flowScore(m15), 0, 1);
  const outside = side === 'long' ? price - zone.hi : zone.lo - price;                                  // > 0 = beyond the zone, i.e. chasing
  const tf = setup.levelTf === 'm15' ? m15 : T['1h'];
  const proximity = outside <= 0 ? 1 : clamp(1 - outside / (1.5 * tf.atr), 0, 1);
  const score = 100 * (0.4 * (1 - chase.score) + 0.3 * (setup.triggerStrength ?? 0) + 0.15 * flowNow + 0.15 * proximity);
  return { score: +score.toFixed(1), trigger: setup.trigger ?? [], flowNow: +flowNow.toFixed(2), proximity: +proximity.toFixed(2), insideZone: outside <= 0 };
}

const stripSide = (d) => ({ action: d.action, verdict: d.verdict, score: d.score, scores: d.scores, setup: d.setup?.label ?? null, vetoes: d.vetoes.map((v) => v.text).slice(0, 3), pUp: d.pUp, rr: d.rr });

/** No setup, but is the coin extended away from where an entry would have been? The latest breakout level (or the 1h EMA20) is the reference, so "bullish but already pumped" is explained as LATE, not just "no setup". */
function pseudoAnchor(side, T) {
  const { h1, m15 } = tfs(T), long = side === 'long';
  const bx = [h1, m15].map((t) => t.box).find((b) => b && (long ? b.brokeUp : b.brokeDown));
  return { name: 'none', label: 'no setup', quality: 0, level: bx ? (long ? bx.hi : bx.lo) : h1.ema20, levelTf: 'h1', trigger: [], triggerStrength: 0, why: [] };
}

/* ================================================================== evaluate one side */
function evaluate(side, inp, T) {
  const { d1, h4, h1, m15, m5 } = tfs(T), price = h1.price, long = side === 'long', sgn = long ? 1 : -1;
  const reg = inp.regime ?? { label: 'unknown', score: 0, severe: false, allowLongs: true, riskMult: 0.6, probShiftLong: 0, probShiftShort: 0, notes: [] };
  const model = inp.empirical ?? DEFAULT_MODEL;
  const vetoes = [], veto = (code, text, hard = true) => vetoes.push({ code, text, hard });
  const rs = inp.rs ?? {};
  const rel = { vs1h: (inp.chg1h ?? 0) - (rs.mkt1 ?? 0), vsBTC24: (inp.chg24h ?? 0) - (rs.btc24 ?? 0), vsETH24: (inp.chg24h ?? 0) - (rs.eth24 ?? 0), vsMkt24: (inp.chg24h ?? 0) - (rs.mkt24 ?? 0) };

  /* ---- hard vetoes for THIS side */
  if (long) {
    const revH1 = h1.trend.bullBreak && h1.swing.lastLow > (h1.swing.prevLow ?? Infinity) && (h1.flow.shift === 'demand_takeover' || h1.flow.control === 'demand_control');
    if (h4.trend.state === 'strong_down' || (isDown(h4) && !h4.trend.bullBreak && !revH1)) veto('downtrend_h4', `4h is in a ${stateName[h4.trend.state]} (${h4.trend.lh ? 'lower highs' : ''}${h4.trend.ll ? ' + lower lows' : ''}); no confirmed reversal yet`);
    if (isDown(h1) && !revH1) veto('downtrend_h1', `1h is in a ${stateName[h1.trend.state]} (lower highs/lows, below its EMAs); no confirmed structure break up`);
    if (d1 && d1.trend.state === 'strong_down' && !isUp(h4)) veto('downtrend_d1', 'daily trend is a strong downtrend and the 4h has not turned up');
    if (h1.flow.control === 'supply_control' && h1.flow.shift !== 'demand_takeover' && !revH1) veto('supply_control', `sellers are in control on the 1h (volume-weighted pressure ${h1.flow.recent}, ${h1.flow.shift === 'supply_takeover' ? 'a demand -> supply shift' : 'persistent'})`);
    const bearish = [isDown(h1), isDown(h4), h1.flow.control === 'supply_control', m15.candles.score <= -0.4, h1.candles.score <= -0.4, h1.momentum.score <= -0.3, !h1.aboveEma50, h1.sweep.bearish != null || h1.box?.fakeUp].filter(Boolean).length;
    if (bearish >= 4) veto('major_conflict', `${bearish} of 8 major bearish signals are active (trend, flow, candles, momentum, EMA, trap)`);
    if (inp.news?.dangerous) veto('bad_news', `dangerous news: ${inp.news.danger}`);
    if (!reg.allowLongs) veto('severe_regime', `severe market conditions: ${(reg.notes ?? []).slice(-1)[0] ?? reg.label}`);
  } else {
    const revDown = h1.trend.bearBreak && (h1.flow.shift === 'supply_takeover' || h1.flow.control === 'supply_control');
    if (isUp(h4) && isUp(h1) && !revDown) veto('uptrend', `4h and 1h are both in uptrends (${stateName[h4.trend.state]} / ${stateName[h1.trend.state]}) and no breakdown has happened`);
    else if (h4.trend.state === 'strong_up' && !revDown) veto('uptrend_h4', '4h is a strong uptrend: shorting against it needs a confirmed breakdown first');
    if (h1.flow.control === 'demand_control' && h1.flow.shift !== 'supply_takeover' && !revDown) veto('demand_control', `buyers are in control on the 1h (pressure ${h1.flow.recent})`);
    if (rel.vsBTC24 >= 0.08 && rel.vs1h >= 0) veto('strong_rs', `exceptional relative strength (+${(rel.vsBTC24 * 100).toFixed(1)}% vs BTC over 24h and still outperforming the market this hour): not a short`);
    const bullish = [isUp(h1), isUp(h4), h1.flow.control === 'demand_control', m15.candles.score >= 0.4, h1.candles.score >= 0.4, h1.momentum.score >= 0.3, h1.aboveEma50, h1.sweep.bullish != null || h1.box?.fakeDown].filter(Boolean).length;
    if (bullish >= 4) veto('major_conflict', `${bullish} of 8 major bullish signals are active`);
    if (inp.news?.bullishDanger) veto('squeeze_news', `strongly bullish news: ${inp.news.bullishDanger}`);
  }
  if (inp.book) {
    if (inp.book.spreadPct > B.maxSpreadPct) veto('illiquid_book', `order-book spread ${inp.book.spreadPct.toFixed(2)}% > ${B.maxSpreadPct}%`);
    else if (Math.min(inp.book.depthUsd.pct1.bid, inp.book.depthUsd.pct1.ask) < B.minDepthUsd) veto('illiquid_book', `thin book: under $${B.minDepthUsd.toLocaleString('en-US')} resting within 1% on one side`);
  }
  if (h1.atrPct < 0.0015) veto('dead_market', `1h ATR is only ${(h1.atrPct * 100).toFixed(2)}% of price: no volatility to trade`);

  /* ---- setup */
  const ctx = { chg24h: inp.chg24h, rs24: rel.vsBTC24 };
  const setups = long ? detectLongSetups(T, ctx) : detectShortSetups(T, ctx);
  const best = setups[0] ?? null;
  if (!best) veto('no_setup', long ? 'no defined long setup (pullback to support, breakout + retest, reversal, liquidity sweep reclaim or momentum continuation)' : 'no defined short setup (failed bounce, breakdown + failed retest, bull trap or fresh breakdown)', false);
  if (h1.box && h1.box.state === 'inside' && h1.box.pos > 0.35 && h1.box.pos < 0.65 && !(best && ['trend_pullback', 'failed_bounce'].includes(best.name))) veto('mid_range', `price is in the middle of the 1h range ${f2(h1.box.lo)}-${f2(h1.box.hi)} (${(h1.box.pos * 100).toFixed(0)}%): no edge from the middle`, false);
  if (long && isDown(m15) && !m15.trend.bullBreak && !m15.sweep.bullish && m15.flow.shift !== 'demand_takeover') veto('wait_15m_turn', `15m is still in a ${stateName[m15.trend.state]}: waiting for the short-term turn`, false);
  if (!long && isUp(m15) && !m15.trend.bearBreak && !m15.sweep.bearish && m15.flow.shift !== 'supply_takeover') veto('wait_15m_turn', `15m is still in a ${stateName[m15.trend.state]}: waiting for the short-term rollover`, false);

  /* ---- plan: stop, target, R:R, anti-chasing, zone, timing, empirical probability */
  let shaped = null, stopRef = null, targetRef = null, holdHours = null, room = null, chase = null, zone = null, timing = null, emp = null, realisticR = null, ev = null, pUp = null, rTarget = null;
  if (best) {
    const minDist = Math.max(0.5 * m15.atr, price * 0.004);
    stopRef = pickStop(price, best.stopRefs, minDist, side) ?? (long ? price - 1.5 * h1.atr : price + 1.5 * h1.atr);
    const tr = best.targetRefs.filter((x) => x != null && Number.isFinite(x) && (long ? x > price * 1.004 : x < price * 0.996)).sort((a, b) => (long ? a - b : b - a));
    const risk = Math.abs(price - stopRef);
    targetRef = tr.find((x) => Math.abs(x - price) >= 2.5 * risk) ?? tr[0] ?? (long ? price + 2.5 * risk : price - 2.5 * risk);
    room = tr[0] != null ? Math.abs(tr[0] - price) / risk : null;
    // risk.shapeTrade is long-only maths: for a short it is run on the mirrored prices
    const mirror = (x) => (2 * price - x);
    const sh = long ? inp.shape(price, stopRef, targetRef) : inp.shape(price, mirror(stopRef), mirror(targetRef));
    shaped = long ? sh : { ...sh, stop: mirror(sh.stop), target: mirror(sh.target) };
    if (shaped.stopDist > config.risk.stopAbsMaxPct + 1e-9) veto('no_valid_stop', `the structural stop (${pc(shaped.stopDist)}) is wider than the ${config.risk.stopAbsMaxPct * 100}% hard cap`);
    if (shaped.rr < config.risk.minRR) veto('poor_rr', `net R:R ${shaped.rr.toFixed(2)} < ${config.risk.minRR} (stop ${f2(shaped.stop)}, target ${f2(shaped.target)}${room != null ? `, nearest ${long ? 'resistance' : 'support'} only ${room.toFixed(1)}R away` : ''})`, false);
    holdHours = Math.round(clamp((Math.abs(shaped.target - price) / h1.atr) * 1.3, 2, 72));
    if (best.name === 'momentum_continuation') holdHours = Math.min(holdHours, 24);

    rTarget = Math.abs(shaped.target - price) / Math.abs(price - shaped.stop);                  // gross R the target asks for
    emp = model.pReach(best.name, side, rTarget);
    realisticR = model.realisticR(best.name, side, B.minPUp);          // the largest R this setup has reached at least as often as the entry gate demands
    pUp = +clamp(emp.p + ((long ? reg.probShiftLong : reg.probShiftShort) ?? 0), 0.02, 0.95).toFixed(3);
    ev = +(pUp * shaped.rr - (1 - pUp)).toFixed(2);
    if (rTarget > realisticR + 0.25) veto('unrealistic_target', `target asks for ${rTarget.toFixed(1)}R but this setup has historically reached at least that only ${(emp.p * 100).toFixed(0)}% of the time (realistic: about ${realisticR}R)`, false);
  }

  // ANTI-CHASING runs with or without a setup: the anchor is the setup's level, or the latest breakout level / 1h EMA20 when there is none
  const anchor = best ?? pseudoAnchor(side, T);
  {
    const tgt = shaped?.target ?? (long ? (h1.levels.resistance?.price ?? price + 3.75 * h1.atr) : (h1.levels.support?.price ?? price - 3.75 * h1.atr));
    chase = chaseOf(side, T, anchor, price, tgt);
    zone = zoneOf(side, anchor, price, T);
    timing = timingOf(side, anchor, chase, zone, T, price);
    const used = `${chase.moveAtr} ATR moved in the last 12 bars, ${chase.distLevelAtr} ATR ${chase.distLevelAtr >= 0 ? 'beyond' : 'before'} the level ${f2(anchor.level)}, ${(chase.expectedMoveUsed * 100).toFixed(0)}% of the move to the target already made${chase.spikeSpent ? ', the volume spike already happened' : ''}${chase.stretched ? ', momentum is stretched' : ''}`;
    if (chase.verdict === 'chasing') veto('chasing', `chasing: ${used}`, false);
    else if (chase.verdict === 'late') veto('late_entry', `late: ${used}`, false);
    if (!timing.insideZone) veto('outside_zone', `price ${f2(price)} is outside the planned entry zone ${f2(zone.lo)}-${f2(zone.hi)} (anchored to ${f2(anchor.level)}): wait for it to come back`, false);
    if (best && !best.trigger?.length) veto('no_why_now', 'no concrete trigger for acting at this price right now', false);
  }

  /* ---- three separate scores */
  // DIRECTION: independent evidence FAMILIES. RSI / MACD / ROC / EMA describe the same thing, so they enter as ONE momentum family and are not allowed to count as confirmation.
  const fam = long ? {
    structure: clamp(wavg([[d1?.trend.score, 0.15], [h4.trend.score, 0.30], [h1.trend.score, 0.35], [m15.trend.score, 0.20]]) + (isUp(h4) && isUp(h1) && isUp(m15) ? 0.1 : 0), -1, 1),
    flow: clamp(wavg([[flowScore(h1), 0.4], [flowScore(m15), 0.35], [flowScore(h4), 0.25]]), -1, 1),
    relStrength: clamp(0.5 * clamp(rel.vs1h / 0.02, -1, 1) + 0.3 * clamp(rel.vsBTC24 / 0.05, -1, 1) + 0.2 * clamp(rel.vsMkt24 / 0.05, -1, 1), -1, 1) * (rel.vsBTC24 > 0.12 ? 0.3 : 1),   // starting strong counts, already up the most does not
    momentum: clamp(wavg([[h1.momentum.score, 0.5], [m15.momentum.score, 0.3], [h4.momentum.score, 0.2]]) - (h1.momentum.overextended || m15.momentum.overextended ? 0.5 : 0) - (h1.momentum.extensionAtr > 2 ? 0.3 : 0), -1, 1),
  } : {
    structure: clamp(-wavg([[d1?.trend.score, 0.15], [h4.trend.score, 0.30], [h1.trend.score, 0.35], [m15.trend.score, 0.20]]) + (isDown(h4) && isDown(h1) && isDown(m15) ? 0.1 : 0) + (h1.trend.lh ? 0.1 : 0), -1, 1),
    flow: clamp(wavg([[-flowScore(h1), 0.4], [-flowScore(m15), 0.35], [-flowScore(h4), 0.25]]) + (0.5 - h1.flow.upVolRatio) * 0.5, -1, 1),         // supply: sellers closing bars low on volume, down-volume share
    relStrength: clamp(0.5 * clamp(-rel.vs1h / 0.02, -1, 1) + 0.3 * clamp(-rel.vsBTC24 / 0.05, -1, 1) + 0.2 * clamp(-rel.vsMkt24 / 0.05, -1, 1), -1, 1) * (rel.vsBTC24 < -0.12 ? 0.3 : 1),
    momentum: clamp(wavg([[-h1.momentum.score, 0.5], [-m15.momentum.score, 0.3], [-h4.momentum.score, 0.2]]) - (h1.momentum.extensionAtr < -2 || (h1.momentum.rsi ?? 50) < 28 ? 0.6 : 0), -1, 1),
  };
  const ctxFam = clamp(((long ? 1 : -1) * (reg.score ?? 0)) * 0.6 + (long ? 1 : -1) * (inp.news?.effect ?? 0) * 0.4 + (long ? 0 : 0), -1, 1);
  const dirW = { structure: 0.32, flow: 0.25, relStrength: 0.15, momentum: 0.10, context: 0.18 };
  const smart = inp.smart ? (long ? (inp.smart.net > 0 ? 0.5 : inp.smart.net < 0 ? -1 : 0) : (inp.smart.net < 0 ? 0.5 : inp.smart.net > 0 ? -1 : 0)) : 0;
  let dirRaw = dirW.structure * fam.structure + dirW.flow * fam.flow + dirW.relStrength * fam.relStrength + dirW.momentum * fam.momentum + dirW.context * ctxFam + 0.01 * smart;
  const adjDir = clamp((inp.adj ?? []).filter((a) => !/^(chase|timing)/.test(a.key)).reduce((s, a) => s + a.delta, 0), -B.learnBound, B.learnBound);
  const adjTim = clamp((inp.adj ?? []).filter((a) => /^(chase|timing)/.test(a.key)).reduce((s, a) => s + a.delta, 0), -B.learnBound, B.learnBound);
  const direction = +clamp(50 + 50 * dirRaw + adjDir, 0, 100).toFixed(1);
  // independent confirmation: momentum does not count (it duplicates structure), and at least two of the remaining families must agree with the direction
  const agree = [['structure', fam.structure > 0.25], ['flow', fam.flow > 0.2], ['relative strength', fam.relStrength > 0.15], ['context (regime/news)', ctxFam > 0.1]].filter(([, ok]) => ok).map(([k]) => k);
  if (best && agree.length < 2) veto('single_family', `only ${agree.length} independent evidence family agrees (${agree.join(', ') || 'none'}): RSI/MACD/momentum/EMAs describe the same condition and do not count as confirmation`, false);
  const timingScore = timing ? +clamp(timing.score + adjTim, 0, 100).toFixed(1) : 0;
  let geometry = 0;
  if (shaped) {
    const rrF = clamp((shaped.rr - 1.0) / 2.5, 0, 1), evF = clamp((ev + 0.1) / 0.8, 0, 1), roomF = clamp((room ?? 0) / 4, 0, 1), stopF = shaped.stopDist <= config.risk.stopAbsMaxPct ? 1 : 0;
    geometry = +(100 * (0.35 * rrF + 0.35 * evF + 0.2 * roomF + 0.1 * stopF)).toFixed(1);
  }
  const scores = { direction, timing: timingScore, geometry };
  const score = +Math.min(direction, timingScore, geometry).toFixed(1);       // the weakest link: a great trend cannot hide a poor entry
  const mean = +((direction + timingScore + geometry) / 3).toFixed(1);

  if (best && direction < B.minDirection) veto('weak_direction', `direction score ${direction} < ${B.minDirection}`, false);
  if (best && timingScore < B.minTiming) veto('bad_timing', `timing score ${timingScore} < ${B.minTiming}: ${timing.insideZone ? 'no concrete reason to enter at this exact price' : 'price is away from the planned entry'}`, false);
  if (best && shaped && geometry < B.minGeometry) veto('weak_geometry', `trade geometry score ${geometry} < ${B.minGeometry}`, false);
  if (best && shaped && pUp < B.minPUp) veto('low_probability', `estimated chance of reaching the target before the stop ${(pUp * 100).toFixed(0)}% < ${(B.minPUp * 100).toFixed(0)}% (${emp.source})`, false);
  if (best && ev != null && ev < B.minEV) veto('low_ev', `expected value ${ev}R < ${B.minEV}R after costs`, false);

  /* ---- verdict: direction and timing are different questions */
  const hard = vetoes.filter((v) => v.hard), soft = vetoes.filter((v) => !v.hard);
  const dirOk = !hard.length && !!best && direction >= B.minDirection && agree.length >= 2;
  let action = 'IGNORE', cls = 'NEUTRAL';
  if (!vetoes.length) { action = long ? 'BUY' : 'SHORT'; cls = long ? 'HOT' : 'SHORT'; }
  else if (!hard.length && (best || direction >= B.watchScore)) { action = 'WATCH'; cls = direction >= 68 && (!chase || chase.verdict !== 'chasing') ? 'HOT' : 'WATCH'; }
  else if (long && hard.some((v) => ['downtrend_h1', 'downtrend_h4', 'downtrend_d1', 'supply_control', 'major_conflict', 'bad_news'].includes(v.code))) { action = 'IGNORE'; cls = 'AVOID'; }
  else if (!long && hard.some((v) => ['uptrend', 'uptrend_h4', 'demand_control', 'major_conflict', 'strong_rs', 'squeeze_news'].includes(v.code))) { action = 'IGNORE'; cls = 'NEUTRAL'; }
  else if (hard.some((v) => ['illiquid_book', 'screened_out', 'no_data', 'dead_market'].includes(v.code))) { action = 'IGNORE'; cls = 'IGNORE'; }
  else if (hard.some((v) => v.code === 'severe_regime' || v.code === 'no_valid_stop')) { action = 'WATCH'; cls = best ? 'WATCH' : 'NEUTRAL'; }
  if (long && cls === 'AVOID' && (h1.trend.bullBreak || h1.sweep.bullish || h1.flow.shift === 'demand_takeover' || m15.trend.bullBreak) && !isDown(h4)) { action = 'WATCH'; cls = 'WATCH'; }
  const verdict = action === 'BUY' ? 'LONG' : action === 'SHORT' ? 'SHORT' : action === 'WATCH' ? 'WAIT' : 'IGNORE';

  /* ---- reasons and the "Why NOW?" answer, all from the numbers above */
  const reasons = [];
  if (best) reasons.push(`${best.label}: ${best.why.join('; ')}`);
  reasons.push(`Trend: 1d ${stateName[d1?.trend.state] ?? 'n/a'}, 4h ${stateName[h4.trend.state]}, 1h ${stateName[h1.trend.state]}, 15m ${stateName[m15.trend.state]}`);
  reasons.push(`Supply/demand: 1h ${h1.flow.control.replace('_', ' ')} (pressure ${h1.flow.recent}${h1.flow.shift !== 'none' ? `, ${h1.flow.shift.replace('_', ' ')}` : ''}${h1.flow.absorption ? `, ${h1.flow.absorption.replace(/_/g, ' ')}` : ''}), 15m ${m15.flow.control.replace('_', ' ')}`);
  const pats = [...m15.candles.patterns, ...h1.candles.patterns].filter((p) => p.bias !== 0).map((p) => p.name);
  if (pats.length) reasons.push(`Candles: ${[...new Set(pats)].join(', ')}${m15.candles.atSupport || h1.candles.atSupport ? ' at support' : ''}${m15.candles.atResistance || h1.candles.atResistance ? ' at resistance' : ''}`);
  reasons.push(`Relative strength: ${pc(rel.vs1h)} vs the market (1h), ${pc(rel.vsBTC24)} vs BTC and ${pc(rel.vsETH24)} vs ETH (24h)`);
  reasons.push(`Volume ${(m15.volume.rvol ?? 0).toFixed(1)}x (15m) / ${(h1.volume.rvol ?? 0).toFixed(1)}x (1h); momentum 1h RSI ${h1.momentum.rsi}, MACD ${h1.momentum.macdRising ? 'rising' : 'falling'} (one family, not counted as confirmation)`);
  if (h1.levels.support || h1.levels.resistance) reasons.push(`Levels: support ${f2(h1.levels.support?.price)}, resistance ${f2(h1.levels.resistance?.price)}${h1.box ? `; 1h range ${f2(h1.box.lo)}-${f2(h1.box.hi)} (${h1.box.state.replace(/_/g, ' ')})` : ''}`);
  if (inp.news?.events?.length) reasons.push(`News: ${inp.news.events.slice(0, 2).map((e) => `${e.label} (${e.direction}, ${e.pricedIn === 'unknown' ? 'priced-in unknown' : e.pricedIn === 'no' ? 'not priced in' : `priced in: ${e.pricedIn}`})`).join('; ')}`);
  reasons.push(`Market: ${reg.label.replace(/_/g, ' ')} (${(reg.score ?? 0).toFixed(2)}): used as a ${long ? reg.probShiftLong >= 0 ? '+' : '' : reg.probShiftShort >= 0 ? '+' : ''}${((long ? reg.probShiftLong : reg.probShiftShort) * 100).toFixed(1)}pt probability shift and a ${reg.riskMult}x size multiplier, not a switch`);
  for (const a of inp.adj ?? []) if (a.delta) reasons.push(`Learned rule: ${a.why} (${a.delta > 0 ? '+' : ''}${a.delta} pts)`);
  if (inp.smart && inp.smart.net !== 0) reasons.push(`Tracked traders net ${inp.smart.net > 0 ? 'long' : 'short'} (data point only, 1% weight)`);

  const why = {
    coin: [...(inp.selected ?? []).filter((r) => (long ? !/weak|short/i.test(r) : /weak|short/i.test(r))), `${rel.vsBTC24 >= 0 ? '+' : ''}${(rel.vsBTC24 * 100).toFixed(1)}% vs BTC / ${(rel.vsETH24 * 100).toFixed(1)}% vs ETH / ${(rel.vsMkt24 * 100).toFixed(1)}% vs market (24h); ${(rel.vs1h * 100).toFixed(1)}% vs market this hour`].filter(Boolean),
    direction: [`${long ? 'LONG' : 'SHORT'} bias: direction score ${direction} from ${agree.length} independent families (${agree.join(', ') || 'none'})`, ...(best ? best.why.slice(0, 2) : ['no defined setup is offering an entry'])],
    price: [shaped ? `price ${f2(price)} is ${chase.distLevelAtr} ATR ${chase.distLevelAtr >= 0 ? 'beyond' : 'before'} the entry level ${f2(anchor.level)} (zone ${f2(zone.lo)}-${f2(zone.hi)}); stop ${f2(shaped.stop)}, target ${f2(shaped.target)}, net R:R ${shaped.rr.toFixed(2)}` : `price ${f2(price)} is ${chase.distLevelAtr} ATR ${chase.distLevelAtr >= 0 ? 'beyond' : 'before'} the reference level ${f2(anchor.level)} (a good entry would be in ${f2(zone.lo)}-${f2(zone.hi)})`, `${(chase.expectedMoveUsed * 100).toFixed(0)}% of the move to the target is already behind us; ${chase.moveAtr} ATR moved in the last 12 bars`],
    now: best && timing.trigger.length && timing.insideZone && chase.verdict === 'fresh' ? [...timing.trigger, `price is inside the planned zone and the move is fresh (chase score ${chase.score})`, ...(timing.flowNow >= 0.3 ? ['15m flow agrees right now'] : [])] : [],
    confirms: best ? [`the 1m candle must close INSIDE the zone ${f2(zone.lo)}-${f2(zone.hi)} and hold the level ${f2(anchor.level)}, on at least normal volume; a candle that closes beyond the zone is chasing and does not count`] : [],
    invalidates: shaped ? [`price trades through the stop ${f2(shaped.stop)}`, long ? `a 1h close back below the level ${f2(anchor.level)} / a 1h structure break` : `a 1h close back above the level ${f2(anchor.level)} / a 1h structure break up`] : [],
    failure: [
      ...(room != null && room < 3 ? [`only ${room.toFixed(1)}R of room to the next ${long ? 'resistance' : 'support'}`] : []),
      ...(realisticR != null && rTarget != null && realisticR < rTarget ? [`the target asks for ${rTarget.toFixed(1)}R; this setup has historically reached about ${realisticR}R`] : []),
      ...(emp ? [`${emp.source}: P(target before stop) ${(pUp * 100).toFixed(0)}%`] : []),
      ...(reg.score < -0.25 && long ? ['market regime is bearish'] : []), ...(reg.score > 0.25 && !long ? ['market regime is bullish (short squeeze risk)'] : []),
      ...soft.slice(0, 3).map((v) => v.text),
    ].slice(0, 5),
  };
  if (!why.now.length && action === 'BUY') { action = 'WATCH'; }      // safety net: never trade without a concrete "why now"

  const waitingFor = [];
  if (action !== 'BUY' && action !== 'SHORT') {
    const codes = new Set(vetoes.map((v) => v.code));
    if (codes.has('chasing') || codes.has('late_entry') || codes.has('outside_zone')) waitingFor.push(`a pullback / retest into the entry zone ${f2(zone.lo)}-${f2(zone.hi)} around ${f2(anchor.level)} (price is ${chase.distLevelAtr} ATR ${chase.distLevelAtr >= 0 ? 'beyond' : 'before'} it): ${(best?.label ?? 'a continuation').toLowerCase()} is only worth entering at the level, not after the move`);
    if (long && (codes.has('downtrend_h1') || codes.has('downtrend_h4') || codes.has('downtrend_d1'))) { const t = isDown(h1) ? h1 : h4; waitingFor.push(`a confirmed reversal: close above the ${t.tf} lower-high ${f2(t.trend.lastHigh)}, hold a higher low above ${f2(t.swing.lastLow)}, with buyers taking control on rising volume`); }
    if (!long && codes.has('uptrend')) waitingFor.push(`a confirmed breakdown: a 1h close below the last higher-low ${f2(h1.trend.lastLow)} with sellers taking control`);
    if (codes.has('wait_15m_turn')) waitingFor.push(long ? `the 15m to stop making lower lows (close above ${f2(m15.trend.lastHigh)} or a bullish rejection at ${f2(m15.levels.support?.price)})` : `the 15m to roll over (close below ${f2(m15.trend.lastLow)} or a bearish rejection at ${f2(m15.levels.resistance?.price)})`);
    if (codes.has('poor_rr') && h1.levels.support && long) waitingFor.push(`a better entry nearer support ${f2(h1.levels.support.price)}, or a break above resistance ${f2(h1.levels.resistance?.price)} that opens room`);
    if (codes.has('unrealistic_target')) waitingFor.push(`a setup whose measured history supports the ${rTarget?.toFixed(1)}R this target needs (this one reaches about ${realisticR}R)`);
    if (codes.has('no_why_now') || codes.has('bad_timing')) waitingFor.push('a concrete trigger at the planned level (rejection candle, supply/demand shift, retest that holds)');
    if (codes.has('single_family')) waitingFor.push('a second independent kind of evidence (flow, relative strength, news/regime) agreeing with the structure');
    if (codes.has('mid_range') && h1.box) waitingFor.push(`price to reach the range edge (${f2(h1.box.lo)} bounce with rejection) or break and retest ${f2(h1.box.hi)}`);
    if (codes.has('no_setup') && !waitingFor.length) waitingFor.push('a defined setup at a level');
    if (codes.has('supply_control')) waitingFor.push('sellers to lose control (buying pressure back above zero on 1h)');
    if (codes.has('low_probability') || codes.has('low_ev') || codes.has('weak_geometry') || codes.has('weak_direction')) waitingFor.push('more confirming evidence and a better-measured payoff');
  }

  return {
    symbol: inp.symbol, at: Date.now(), action, verdict, direction: action === 'IGNORE' && !best ? 'NONE' : long ? 'LONG' : 'SHORT', side, cls,
    score, mean, scores, pUp: pUp ?? 0, pUpSource: emp ? emp.source : 'no setup', pSample: emp?.n ?? 0, ev, setup: best ? { name: best.name, label: best.label, quality: +best.quality.toFixed(2), reversal: !!best.reversal } : null,
    entry: shaped ? price : null, stop: shaped?.stop ?? null, target: shaped?.target ?? null, rr: shaped ? +shaped.rr.toFixed(2) : null, stopDist: shaped?.stopDist ?? null, holdHours,
    entryZone: zone ? { lo: zone.lo, hi: zone.hi, level: zone.level, planned: zone.planned } : null, maxEntry: zone ? (long ? zone.hi : zone.lo) : null,
    chase, timing, why, realisticR, targetR: rTarget != null ? +rTarget.toFixed(2) : null, riskMult: reg.riskMult ?? 1,
    reasons, vetoes, waitingFor, blocked: vetoes.map((v) => v.text), adjustments: inp.adj ?? [],
    factors: { ...Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, +v.toFixed(2)])), context: +ctxFam.toFixed(2) }, families: { agree, count: agree.length },
    relStrength: { vs1h: +rel.vs1h.toFixed(4), vsBTC24: +rel.vsBTC24.toFixed(4), vsETH24: +rel.vsETH24.toFixed(4), vsMkt24: +rel.vsMkt24.toFixed(4) },
    evidence: {
      trend: { '1d': d1?.trend.state, '4h': h4.trend.state, '1h': h1.trend.state, '15m': m15.trend.state },
      flow: { h1: h1.flow.control, h1shift: h1.flow.shift, m15: m15.flow.control, m15shift: m15.flow.shift, absorption: h1.flow.absorption ?? m15.flow.absorption },
      candles: [...new Set(pats)], volume: { rvol15: m15.volume.rvol, rvol1h: h1.volume.rvol },
      momentum: { rsi1h: h1.momentum.rsi, roc6: h1.momentum.roc6, ext1h: h1.momentum.extensionAtr, overextended: h1.momentum.overextended },
      levels: { support: h1.levels.support?.price ?? null, resistance: h1.levels.resistance?.price ?? null }, box: h1.box ? { state: h1.box.state, lo: h1.box.lo, hi: h1.box.hi, pos: h1.box.pos } : null,
      news: inp.news ? { effect: inp.news.effect, events: inp.news.events } : null, regime: reg.label, regimeScore: reg.score, price, atr1h: h1.atr, atr15: m15.atr, room,
      book: inp.book ? { spreadPct: inp.book.spreadPct, depth1pct: Math.min(inp.book.depthUsd.pct1.bid, inp.book.depthUsd.pct1.ask) } : null,
    },
  };
}

/**
 * The decision for ONE coin. input:
 *  symbol, name, ta {1d,4h,1h,15m,5m} (structure.analyzeAll), regime (marketRegime), news (newsimpact.coinImpact), market, book, chg1h, chg24h, rs {btc24,eth24,mkt24,mkt1},
 *  vol24, smart ({net}|null), adj (learning adjustments), empirical (empirical.buildModel), selected (why this coin was picked), shape(entry, stop, target), rejected ({text}|null)
 */
export function decide(inp) {
  const { symbol, ta: T } = inp;
  const base = { symbol, at: Date.now(), action: 'IGNORE', verdict: 'IGNORE', direction: 'NONE', cls: 'IGNORE', score: 0, scores: { direction: 0, timing: 0, geometry: 0 }, pUp: 0, ev: null, setup: null, reasons: [], vetoes: [], waitingFor: [], evidence: {}, entry: null, stop: null, target: null, rr: null, holdHours: null, factors: {}, why: null };
  if (inp.rejected) return { ...base, vetoes: [{ code: 'screened_out', hard: true, text: inp.rejected.text }], reasons: [inp.rejected.text] };
  if (!T?.['1h'] || !T['15m'] || !T['4h'] || !T['5m']) return { ...base, vetoes: [{ code: 'no_data', hard: true, text: 'not enough completed candles to analyse structure' }], reasons: ['not enough completed candles to analyse structure'] };
  const L = evaluate('long', inp, T);
  const S = B.detectShorts ? evaluate('short', inp, T) : null;
  let primary = L;
  if (L.action !== 'BUY') {
    if (S && S.action === 'SHORT') primary = S;
    else if (S && S.setup && S.scores.direction > L.scores.direction + 8 && S.action !== 'IGNORE') primary = S;       // the better-supported side is the one reported
  }
  const other = primary === L ? S : L;
  return { ...primary, long: stripSide(L), short: S ? stripSide(S) : null, alt: other ? { side: other.side, ...stripSide(other) } : null, ...(inp.full ? { _both: { long: L, short: S } } : {}) };      // `full` is for research scripts: both complete evaluations
}

/** Open position: HOLD while the structure that justified it is intact, SELL when it breaks. */
export function manage(pos, ta, price) {
  const h1 = ta?.['1h'], h4 = ta?.['4h'];
  if (!h1 || !h4) return { action: 'HOLD', reasons: ['no fresh structure read: the stop and trailing stop keep protecting the position'], sell: false };
  const reasons = [], broke = h1.trend.bearBreak && (h1.flow.control === 'supply_control' || h1.flow.shift === 'supply_takeover') && h1.momentum.score < 0;
  const dead = isDown(h4) && isDown(h1) && price < h1.ema50;
  if (broke) reasons.push(`1h structure broke: lost the higher low ${f2(h1.trend.lastLow)} with sellers in control (pressure ${h1.flow.recent})`);
  if (dead) reasons.push(`both 4h and 1h are now in downtrends and price is below the 1h EMA50 ${f2(h1.ema50)}`);
  if (reasons.length) return { action: 'SELL', reasons, sell: true, invalidation: h1.trend.lastLow };
  return { action: 'HOLD', reasons: [`structure intact: 1h ${stateName[h1.trend.state]}, 4h ${stateName[h4.trend.state]}${h1.trend.lastLow ? `, higher low ${f2(h1.trend.lastLow)} holds` : ''}`], sell: false, invalidation: h1.trend.lastLow };
}
