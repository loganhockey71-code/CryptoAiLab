// THE BRAIN: the AI's own decision for ONE coin, built from three separate questions that are COMBINED into one ranking score (not three independent cutoffs):
//   1. DIRECTION      LONG, SHORT or neither? (structure, supply/demand, relative strength vs BTC / ETH / the market, one momentum family, regime/news context)
//   2. TIMING         is NOW a good entry? (anti-chasing: move already made, distance from the level / swing, spent volume spike, stretch; a trigger)
//   3. TRADE GEOMETRY is the reward worth the risk? (structural stop, realistic target, net R:R, EMPIRICAL probability, expected value after fees + spread + slippage)
// composite = weighted blend of the three, pulled DOWN when any one is very weak (a strong trend cannot buy a terrible entry) and when the coin is chased. A coin is eligible when its composite
// clears a floor (tighter in a weak BTC regime, looser for exceptional relative strength), its EV is MEANINGFULLY positive (also after subtracting uncertainty), and the protected R:R / stop rules
// hold. The engine then RANKS the eligible coins against each other and takes the best.
// HARD VETOES are limited to genuinely dangerous conditions; everything else is a score penalty or a caution. Other traders are a 1%-weight input and can never create a trade.
// Pure functions: no I/O, no LLM, no randomness. Every reason is generated from the numbers that fed the decision. Nothing here can touch the protected risk limits (guardrails.js).
import { config } from './config.js';
import { buildModel } from './empirical.js';
import { featuresOf, matches } from './discovery.js';

const B = config.brain, R = config.risk;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f2 = (x) => (x == null || !Number.isFinite(x) ? '?' : Math.abs(x) >= 100 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(3) : x.toPrecision(4));
const pc = (x) => `${(x * 100).toFixed(1)}%`;
const lo = (x, k) => (x == null ? null : x - k);   // null-safe "level minus buffer"
const hi = (x, k) => (x == null ? null : x + k);
const COST_RT = 2 * (R.feePct + R.slippagePct);
const tfs = (T) => ({ d1: T['1d'], h4: T['4h'], h1: T['1h'], m15: T['15m'], m5: T['5m'] });
const isUp = (t) => !!t && t.trend.score >= 0.25;
const isDown = (t) => !!t && t.trend.score <= -0.25;
const stateName = { strong_up: 'strong uptrend', up: 'uptrend', range: 'sideways', down: 'downtrend', strong_down: 'strong downtrend' };
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const DEFAULT_MODEL = buildModel({}, []);       // zero-drift prior only: used when no measured history is supplied (tests, first run)

/** Legacy score -> probability prior. Kept for the unit tests and displays that have no setup; real decisions use the empirical model. */
export function probability(score, calib = B.calib) {
  return +clamp(calib.floor + (calib.ceil - calib.floor) * sigmoid((score - calib.mid) / calib.width), calib.floor, calib.ceil).toFixed(3);
}

/**
 * Market regime from BTC (and ETH) structure plus breadth. It is a MODIFIER (probability shift, a size multiplier, a stricter or looser composite floor), not a switch: only a genuinely
 * SEVERE market (BTC in a strong 4h AND 1h downtrend, or a fast crash) sets `severe`, and only `severe` blocks new longs. score -1..1.
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
  else if (s < -0.25) notes.push('BTC is weak: the AI is more selective (higher composite floor, lower probability, smaller size); a coin with exceptional relative strength is still judged on its own merits');
  else if (s > 0.5) notes.push('BTC is strong: good long setups get a small confidence boost');
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

/** Several WEAKER confirmations agreeing can stand in for one textbook trigger: the AI does not need a perfect candle. Returns the list that applies. */
function weakConfirms(side, T, rel) {
  const { h1, m15 } = tfs(T), L = side === 'long', sg = L ? 1 : -1, out = [];
  if (sg * m15.candles.score >= 0.15 || sg * h1.candles.score >= 0.15) out.push(L ? 'bullish candle evidence' : 'bearish candle evidence');
  if (sg * flowScore(m15) > 0.2 || sg * flowScore(h1) > 0.2) out.push(L ? 'demand in control' : 'supply in control');
  const lvl = L ? h1.levels.support : h1.levels.resistance;
  if (lvl && Math.abs(h1.price - lvl.price) <= 1.0 * h1.atr) out.push(L ? 'at support' : 'at resistance');
  if (Math.max(m15.volume.rvol ?? 0, h1.volume.rvol ?? 0) >= 1.2) out.push('volume above normal');
  if (L ? (m15.trend.bullBreak || m15.trend.score > -0.25) : (m15.trend.bearBreak || m15.trend.score < 0.25)) out.push(L ? '15m has turned' : '15m has rolled over');
  if (L ? ((h1.momentum.rsi ?? 50) > 30 && (h1.momentum.rsi ?? 50) < 60 && h1.momentum.macdRising) : ((h1.momentum.rsi ?? 50) < 70 && (h1.momentum.rsi ?? 50) > 40 && h1.momentum.macdRising === false)) out.push('momentum turning your way');
  if (sg * (rel?.vs1h ?? 0) > 0.003) out.push('outperforming the market this hour');
  return out;
}

/* ================================================================== LONG setups */
/** Each setup: { name, label, quality 0..1, level (the price it is anchored to), levelTf, trigger[] + triggerStrength 0..1, stopRefs[], targetRefs[], why[] }. A setup does not need every condition to be perfect. */
function detectLongSetups(T, ctx) {
  const { d1, h4, h1, m15 } = tfs(T), price = h1.price, out = [];
  const a1 = h1.atr, a15 = m15.atr, rel = ctx.rel ?? {};
  const demandNow = (t) => t && (t.flow.shift === 'demand_takeover' || t.flow.control === 'demand_control' || t.flow.absorption === 'demand_absorbing_at_support');
  const bullCandle = (t) => t && t.candles.score >= 0.3;
  const bullPats = (...ts) => [...new Set(ts.flatMap((t) => t.candles.patterns.filter((p) => p.bias > 0).map((p) => p.name.replace(/_/g, ' '))))];
  const weak = weakConfirms('long', T, rel);
  const improving = h1.trend.higherLowAfterLow || m15.trend.bullBreak || h1.flow.shift === 'demand_takeover' || !!h1.sweep.bullish;       // structure is getting better even if the trend is not up yet
  const res1 = h1.levels.resistance?.price, res2 = h1.levels.resistance2?.price;

  // A. Pullback: prefer an uptrend, but allow a developing reversal when structure is improving.
  if ((h1.trend.score >= 0.25 && h4.trend.score >= -0.25) || (h1.trend.score >= -0.25 && improving)) {
    const nearEma = price <= h1.ema20 + 0.4 * a1 && price >= h1.ema50 - 0.5 * a1;
    const sup = h1.levels.support, nearSup = sup && price - sup.price <= 1.2 * a1;
    const rsiOk = h1.momentum.rsi != null && h1.momentum.rsi >= 30 && h1.momentum.rsi <= 68;
    const trig = [];
    if (bullCandle(m15) || bullCandle(h1)) { const p = bullPats(m15, h1); trig.push(`${p.join('/') || 'rejection'} candle at ${nearSup ? 'support' : 'the 1h EMA20'}`); }
    if (m15.flow.shift === 'demand_takeover' || h1.flow.shift === 'demand_takeover') trig.push('supply -> demand shift just occurred');
    if (m15.sweep.bullish) trig.push('15m liquidity sweep reclaimed');
    if (m15.trend.bullBreak) trig.push('15m broke its last lower-high');
    if ((nearEma || nearSup) && rsiOk && (trig.length || weak.length >= 2)) {
      let q = 0.5; const why = [`1h ${stateName[h1.trend.state]}${h1.trend.score < 0.25 ? ' with improving structure' : ''} pulled back to ${nearSup ? `support ${f2(sup.price)}` : `its EMA20 ${f2(h1.ema20)}`} (RSI ${h1.momentum.rsi})`];
      if (h4.trend.score >= 0.25) { q += 0.1; why.push('4h trend up as well'); }
      if (trig.length) { q += 0.1; why.push(`trigger evidence: ${trig.join('; ')}`); }
      if (sup && sup.touches >= 2) { q += 0.1; why.push(`support tested ${sup.touches}x`); }
      if (h1.volume.trend != null && h1.volume.trend < 1) { q += 0.05; why.push('selling volume drying up on the dip'); }
      out.push({ name: 'trend_pullback', label: 'Pullback', quality: clamp(q, 0.3, 1), level: nearSup ? sup.price : h1.ema20, levelTf: 'h1', trigger: trig, triggerStrength: trig.length ? clamp(0.35 + 0.2 * trig.length, 0, 1) : 0, why, stopRefs: [lo(m15.sweep.bullish?.wickLow, 0.25 * a15), lo(m15.swing.lastLow, 0.25 * a15), sup ? sup.price - 0.3 * a1 : null, lo(h1.swing.lastLow, 0.25 * a1)], targetRefs: [res1, res2, h1.swing.lastHigh] });
    }
  }

  // B. Breakout + retest: the level must hold REASONABLY well; the exact ATR distance is not mandatory.
  for (const t of [h1, m15]) {
    const bx = t.box;
    if (bx && bx.brokeUp && bx.retest && bx.extensionAtr <= 3 && h4.trend.score > -0.6 && t.flow.recent > -0.2) {
      const q = 0.55 + (t.volume.rvol3 >= 1.2 ? 0.1 : 0) + (demandNow(t) ? 0.1 : 0) + (bx.heightAtr >= 3 ? 0.05 : 0) + (isUp(h1) ? 0.1 : 0);
      out.push({ name: 'breakout_retest', label: 'Breakout + retest', quality: clamp(q, 0.3, 1), level: bx.hi, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`price retested the broken range high ${f2(bx.hi)} and held`], triggerStrength: 0.8 + (demandNow(t) ? 0.1 : 0), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} broken up ${bx.barsSinceBreak} bars ago, retested ${f2(bx.hi)} and held`, ...(demandNow(t) ? ['demand in control after the break'] : [])], stopRefs: [lo(bx.hi, 0.6 * t.atr), bx.mid, lo(t.swing.lastLow, 0.25 * t.atr)], targetRefs: [bx.hi + bx.height, res1, res2] });
      break;
    }
  }

  // C. Fresh / range breakout: volume is compared with the coin's OWN normal (1.2x is enough), not a fixed 1.5x.
  for (const t of [h1, m15]) {
    const bx = t.box, rv = Math.max(t.volume.rvol ?? 0, t.volume.rvol3 ?? 0);
    if (bx && bx.brokeUp && !bx.retest && bx.barsSinceBreak <= 6 && bx.extensionAtr <= 1.8 && rv >= 1.2 && h4.trend.score > -0.6 && (demandNow(t) || t.flow.recent > 0)) {
      const q = 0.5 + (rv >= 2.5 ? 0.15 : rv >= 1.8 ? 0.1 : 0.03) + (isUp(h1) ? 0.1 : 0) + (isUp(h4) ? 0.1 : 0);
      out.push({ name: 'range_breakout', label: 'Fresh / range breakout', quality: clamp(q, 0.3, 1), level: bx.hi, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`closed ${bx.extensionAtr} ATR above the range high on ${rv.toFixed(1)}x its normal volume`], triggerStrength: clamp(0.4 + (rv >= 2.5 ? 0.2 : 0.1) + (bx.extensionAtr <= 0.6 ? 0.2 : 0), 0, 1), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} just broken up on ${rv.toFixed(1)}x volume (${bx.extensionAtr} ATR beyond the edge)`], stopRefs: [lo(bx.hi, 0.6 * t.atr), bx.mid], targetRefs: [bx.hi + bx.height, res1, res2] });
      break;
    }
  }

  // D. Early reversal: a lower-high break OR equivalent structure improvement (higher low + buyers + back above the EMA20).
  const rev1 = (h1.trend.bullBreak || (h1.trend.higherLowAfterLow && price > h1.ema20)) && h1.swing.lastLow > (h1.swing.prevLow ?? Infinity) && (demandNow(h1) || h1.candles.score >= 0.3);
  const rev15 = m15.trend.bullBreak && m15.flow.shift === 'demand_takeover' && m15.swing.lastLow > (m15.swing.prevLow ?? Infinity) && h1.trend.score > -0.8;
  if (rev1 || rev15) {
    const t = rev1 ? h1 : m15, broken = t.trend.lastHigh ?? t.ema20;
    if ((price - broken) / t.atr <= 3.5) {
      const q = 0.5 + (rev1 ? 0.1 : 0) + (t.volume.rvol3 >= 1.2 ? 0.1 : 0) + (t.candles.score >= 0.3 ? 0.1 : 0) + (h4.trend.score > -0.25 ? 0.1 : 0);
      out.push({ name: 'trend_reversal', label: 'Early reversal', quality: clamp(q, 0.3, 1), reversal: true, level: broken, levelTf: rev1 ? 'h1' : 'm15', trigger: [`${t.tf} structure improved: ${t.trend.bullBreak ? `closed above its last lower-high ${f2(broken)}` : 'higher low formed and price is back above the EMA20'}, with a higher low ${f2(t.swing.lastLow)}`], triggerStrength: clamp(0.5 + (t.volume.rvol3 >= 1.2 ? 0.2 : 0) + (t.candles.score >= 0.3 ? 0.15 : 0), 0, 1), why: [`${t.tf} downtrend is improving (structure shift), made a higher low ${f2(t.swing.lastLow)} and buyers took control (${t.flow.shift === 'demand_takeover' ? 'supply -> demand shift' : 'demand in control'})`], stopRefs: [lo(t.swing.lastLow, 0.25 * t.atr), lo(m15.swing.lastLow, 0.25 * a15)], targetRefs: [res1, res2, t.swing.prevHigh] });
    }
  }

  // E. Liquidity sweep reclaim: reclaiming an important level with a buying response can qualify even when the larger trend is still bearish.
  for (const t of [h1, m15]) {
    const sw = t.sweep.bullish, bx = t.box;
    const boxSweep = bx && (bx.state === 'liquidity_sweep_low' || bx.state === 'fake_breakdown');
    if ((sw || boxSweep) && (demandNow(t) || t.candles.score >= 0.2)) {
      const lvl = sw ? sw.level : bx.lo, wick = sw ? sw.wickLow : bx.lo;
      if (price > lvl) {
        const q = 0.55 + (sw && sw.lowerWick >= 0.6 ? 0.1 : 0) + (t.flow.shift === 'demand_takeover' ? 0.1 : 0) + (t.volume.rvol3 >= 1.3 ? 0.1 : 0) + (isUp(h4) ? 0.05 : 0);
        out.push({ name: 'liquidity_sweep', label: 'Liquidity sweep + reclaim', quality: clamp(q, 0.3, 1), level: lvl, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`price swept ${f2(lvl)} and closed back above it with a buying response`], triggerStrength: clamp(0.55 + (t.flow.shift === 'demand_takeover' ? 0.2 : 0) + (t.volume.rvol3 >= 1.3 ? 0.1 : 0), 0, 1), why: [`${t.tf} price swept below ${f2(lvl)} (stops taken) and closed back above it: sellers failed${t.flow.shift === 'demand_takeover' ? ', buyers now taking control' : ''}`], stopRefs: [lo(wick, 0.25 * t.atr), lo(m15.swing.lastLow, 0.25 * a15)], targetRefs: [bx ? bx.mid : null, bx ? bx.hi : null, res1, res2] });
        break;
      }
    }
  }

  // F. Momentum continuation: strong relative strength can qualify even when RSI / EMA conditions are not perfect.
  const rsStrong = (rel.vsBTC24 ?? 0) >= 0.03 && (rel.vs1h ?? 0) >= 0;
  const strongMove = h1.momentum.roc6 >= 0.02 || h4.momentum.roc6 >= 0.03 || (ctx.chg24h ?? 0) >= 0.06 || rsStrong;
  const rv15 = Math.max(m15.volume.rvol ?? 0, m15.volume.rvol3 ?? 0), rv1 = Math.max(h1.volume.rvol ?? 0, h1.volume.rvol3 ?? 0);
  if (strongMove && (h1.trend.score >= 0.25 || (rsStrong && h1.trend.score >= -0.25)) && h4.trend.score >= -0.25 && (demandNow(h1) || demandNow(m15)) && Math.max(rv15, rv1) >= 1.1 && m15.momentum.extensionAtr <= 1.8 && (h1.momentum.rsi ?? 50) <= 80) {
    const q = 0.5 + (Math.max(rv15, rv1) >= 2 ? 0.1 : 0) + (isUp(d1) ? 0.1 : 0) + (m15.trend.score >= 0.25 ? 0.1 : 0) + (rsStrong ? 0.1 : 0);
    out.push({ name: 'momentum_continuation', label: 'Momentum continuation', quality: clamp(q, 0.3, 1), level: m15.ema20, levelTf: 'm15', trigger: [`pulled back to within ${m15.momentum.extensionAtr} ATR of the 15m mean with demand still in control on ${Math.max(rv15, rv1).toFixed(1)}x volume`], triggerStrength: clamp(0.4 + (m15.momentum.extensionAtr <= 0.6 ? 0.25 : 0.1) + (Math.max(rv15, rv1) >= 2 ? 0.1 : 0), 0, 1), why: [`strong mover (1h ${pc(h1.momentum.roc6)} / 6 bars, 24h ${pc(ctx.chg24h ?? 0)}${rsStrong ? `, ${pc(rel.vsBTC24)} vs BTC` : ''}) with demand in control on ${Math.max(rv15, rv1).toFixed(1)}x volume; ${m15.momentum.extensionAtr} ATR above the 15m mean`], stopRefs: [m15.ema20 - a15, lo(m15.swing.lastLow, 0.25 * a15), h1.ema20 - 0.5 * a1], targetRefs: [res1, res2, price + 3 * a1] });
  }

  // G. Strong relative-strength move: outperforming BTC, ETH and the market while its own structure is not broken.
  if ((rel.vsBTC24 ?? 0) >= 0.04 && (rel.vsETH24 ?? 0) >= 0.02 && (rel.vs1h ?? 0) >= 0.004 && h1.trend.score >= -0.25 && h1.flow.control !== 'supply_control' && h1.momentum.extensionAtr <= 2.5) {
    out.push({ name: 'relative_strength', label: 'Relative-strength move', quality: clamp(0.5 + (isUp(h1) ? 0.1 : 0) + (demandNow(h1) || demandNow(m15) ? 0.1 : 0) + ((rel.vsBTC24 ?? 0) >= 0.08 ? 0.05 : 0), 0.3, 1), level: m15.ema20, levelTf: 'm15',
      trigger: [`outperforming BTC (${pc(rel.vsBTC24)}), ETH (${pc(rel.vsETH24)}) and the market this hour (${pc(rel.vs1h)}) with its own structure intact`], triggerStrength: clamp(0.4 + ((rel.vsBTC24 ?? 0) >= 0.08 ? 0.2 : 0.1) + (demandNow(m15) ? 0.15 : 0), 0, 1),
      why: [`relative strength: ${pc(rel.vsBTC24)} vs BTC, ${pc(rel.vsETH24)} vs ETH over 24h and ${pc(rel.vs1h)} vs the market this hour, 1h ${stateName[h1.trend.state]}`], stopRefs: [lo(m15.swing.lastLow, 0.25 * a15), h1.ema20 - 0.5 * a1, lo(h1.swing.lastLow, 0.25 * a1)], targetRefs: [res1, res2, price + 3 * a1] });
  }

  // H. Support bounce: a tested support with a rejection, in any market (not only uptrends).
  {
    const sup = h1.levels.support, bx = h1.box, base = sup && sup.touches >= 2 ? sup.price : bx && bx.state === 'inside' && bx.pos <= 0.25 ? bx.lo : null;
    if (base != null && price - base >= 0 && price - base <= 0.8 * a1 && h1.trend.score >= -0.6 && (bullCandle(m15) || bullCandle(h1) || m15.sweep.bullish || demandNow(m15) || weak.length >= 2)) {
      const trig = [`${bullPats(m15, h1).join('/') || (m15.sweep.bullish ? 'sweep reclaim' : 'buying response')} at the tested support ${f2(base)}`];
      out.push({ name: 'support_bounce', label: 'Support bounce', quality: clamp(0.5 + ((sup?.touches ?? 0) >= 3 ? 0.1 : 0) + (demandNow(m15) ? 0.1 : 0) + (bullCandle(m15) ? 0.1 : 0), 0.3, 1), level: base, levelTf: 'h1', trigger: trig, triggerStrength: clamp(0.4 + (bullCandle(m15) || bullCandle(h1) ? 0.25 : 0) + (demandNow(m15) ? 0.15 : 0), 0, 1),
        why: [`price is ${((price - base) / a1).toFixed(2)} ATR above the tested support ${f2(base)} with a buying response`], stopRefs: [lo(base, 0.4 * a1), lo(m15.swing.lastLow, 0.25 * a15)], targetRefs: [bx ? bx.mid : null, res1, res2] });
    }
  }

  // I. Trend continuation: a shallow dip to a rising EMA20 in an established uptrend, demand still in control.
  if (isUp(h1) && h4.trend.score >= 0 && price >= h1.ema20 - 0.3 * a1 && price <= h1.ema20 + 1.2 * a1 && (demandNow(h1) || demandNow(m15)) && (h1.momentum.rsi ?? 50) >= 45 && (h1.momentum.rsi ?? 50) <= 72 && !h1.momentum.overextended) {
    out.push({ name: 'trend_continuation', label: 'Trend continuation', quality: clamp(0.5 + (isUp(h4) ? 0.1 : 0) + (isUp(d1) ? 0.05 : 0) + (m15.trend.score >= 0.25 ? 0.1 : 0), 0.3, 1), level: h1.ema20, levelTf: 'h1', trigger: ['holding above the rising 1h EMA20 with demand in control'], triggerStrength: clamp(0.4 + (demandNow(m15) ? 0.15 : 0) + (h1.volume.trend != null && h1.volume.trend < 1 ? 0.1 : 0), 0, 1),
      why: [`established ${stateName[h1.trend.state]} holding ${((price - h1.ema20) / a1).toFixed(2)} ATR above its EMA20 with demand in control`], stopRefs: [h1.ema20 - 0.6 * a1, lo(m15.swing.lastLow, 0.25 * a15), lo(h1.swing.lastLow, 0.25 * a1)], targetRefs: [res1, res2, h1.swing.lastHigh, price + 3 * a1] });
  }

  // Discovered setups: feature combinations mined from history that survived out-of-sample validation (src/discovery.js).
  const x = ctx.discovered?.length ? featuresOf(T, ctx.chg24h ?? 0) : null;
  for (const rule of ctx.discovered ?? []) {
    if (!matches(rule, x)) continue;
    out.push({ name: `discovered:${rule.id}`, label: `Discovered: ${rule.label}`, quality: 0.5, discovered: true, level: h1.ema20, levelTf: 'h1', trigger: [`matches a rule found in history (${rule.test.n} unseen cases, +${(rule.test.excess * 100).toFixed(2)}% vs the market after costs)`], triggerStrength: 0.55,
      why: [`discovered pattern: ${rule.label} (out-of-sample t=${rule.test.t})`], stopRefs: [lo(h1.swing.lastLow, 0.25 * a1), lo(m15.swing.lastLow, 0.25 * a15), price - 1.5 * a1], targetRefs: [res1, res2, price + 3.75 * a1] });
  }
  return out.sort((p, q) => q.quality - p.quality);
}

/* ================================================================== SHORT setups */
// Written from the seller's side, not as a mirror of the long logic: lower highs, failed bounces into resistance, resistance rejection, breakdown + failed retest, bull traps.
function detectShortSetups(T, ctx) {
  const { h4, h1, m15 } = tfs(T), price = h1.price, out = [];
  const a1 = h1.atr, a15 = m15.atr, rel = ctx.rel ?? {};
  const supplyNow = (t) => t && (t.flow.shift === 'supply_takeover' || t.flow.control === 'supply_control' || t.flow.absorption === 'supply_absorbing_at_resistance');
  const bearCandle = (t) => t && t.candles.score <= -0.3;
  const bearPats = (...ts) => [...new Set(ts.flatMap((t) => t.candles.patterns.filter((p) => p.bias < 0).map((p) => p.name.replace(/_/g, ' '))))];
  const weak = weakConfirms('short', T, rel);
  const res = h1.levels.resistance;

  if (h1.trend.score <= -0.25 && h4.trend.score <= 0.25) {
    const nearEma = price >= h1.ema20 - 0.5 * a1 && price <= h1.ema20 + 0.3 * a1;
    const atRes = res && res.price - price <= 0.6 * a1 && price - res.price <= 0.2 * a1;
    const rsiOk = h1.momentum.rsi != null && h1.momentum.rsi >= 36 && h1.momentum.rsi <= 66;
    const trig = [];
    if (bearCandle(m15) || bearCandle(h1)) trig.push(`${bearPats(m15, h1).join('/') || 'rejection'} candle at ${atRes ? 'resistance' : 'the 1h EMA20'}`);
    if (m15.flow.shift === 'supply_takeover' || h1.flow.shift === 'supply_takeover') trig.push('demand -> supply shift just occurred');
    if (m15.sweep.bearish) trig.push('15m failed breakout above a swing high');
    if (m15.trend.bearBreak) trig.push('15m lost its last higher-low');
    if ((nearEma || atRes) && rsiOk && (trig.length || weak.length >= 2)) {
      let q = 0.5; const why = [`1h ${stateName[h1.trend.state]} (${h1.trend.lh ? 'lower highs' : 'weak structure'}) bounced into ${atRes ? `resistance ${f2(res.price)}` : `its EMA20 ${f2(h1.ema20)}`} and was rejected (RSI ${h1.momentum.rsi})`];
      if (h4.trend.score <= -0.25) { q += 0.1; why.push('4h is a downtrend as well'); }
      if (trig.length) { q += 0.1; why.push(`rejection evidence: ${trig.join('; ')}`); }
      if (res && res.touches >= 2) { q += 0.1; why.push(`resistance rejected ${res.touches}x`); }
      out.push({ name: 'failed_bounce', label: 'Failed bounce into resistance', quality: clamp(q, 0.3, 1), level: atRes ? res.price : h1.ema20, levelTf: 'h1', trigger: trig, triggerStrength: trig.length ? clamp(0.35 + 0.2 * trig.length, 0, 1) : 0, why, stopRefs: [hi(m15.swing.lastHigh, 0.25 * a15), hi(res?.price, 0.3 * a1), hi(h1.swing.lastHigh, 0.25 * a1)], targetRefs: [h1.levels.support?.price, h1.levels.support2?.price, h1.swing.lastLow] });
    }
  }
  for (const t of [h1, m15]) {
    const bx = t.box;
    if (bx && bx.brokeDown && bx.retest && bx.extensionAtr <= 3 && h4.trend.score < 0.6 && t.flow.recent < 0.2) {
      const q = 0.55 + (t.volume.rvol3 >= 1.2 ? 0.1 : 0) + (supplyNow(t) ? 0.1 : 0) + (isDown(h1) ? 0.1 : 0);
      out.push({ name: 'breakdown_retest', label: 'Range breakdown + failed retest', quality: clamp(q, 0.3, 1), level: bx.lo, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`price retested the broken range low ${f2(bx.lo)} from below and failed`], triggerStrength: 0.8 + (supplyNow(t) ? 0.1 : 0), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} broken down ${bx.barsSinceBreak} bars ago; the retest of ${f2(bx.lo)} failed${supplyNow(t) ? '; sellers in control' : ''}`], stopRefs: [hi(bx.lo, 0.6 * t.atr), bx.mid, hi(t.swing.lastHigh, 0.25 * t.atr)], targetRefs: [bx.lo - bx.height, h1.levels.support?.price, h1.levels.support2?.price] });
      break;
    }
  }
  for (const t of [h1, m15]) {
    const bx = t.box, rv = Math.max(t.volume.rvol ?? 0, t.volume.rvol3 ?? 0);
    if (bx && bx.brokeDown && !bx.retest && bx.barsSinceBreak <= 6 && bx.extensionAtr <= 1.8 && rv >= 1.2 && h4.trend.score < 0.6 && (supplyNow(t) || t.flow.recent < 0) && (h1.momentum.rsi ?? 50) > 26) {
      const q = 0.5 + (rv >= 2.5 ? 0.15 : 0.05) + (isDown(h1) ? 0.1 : 0) + (isDown(h4) ? 0.1 : 0);
      out.push({ name: 'breakdown_volume', label: 'Range breakdown with volume', quality: clamp(q, 0.3, 1), level: bx.lo, levelTf: t === h1 ? 'h1' : 'm15', trigger: [`closed ${bx.extensionAtr} ATR below the range low on ${rv.toFixed(1)}x volume`], triggerStrength: clamp(0.4 + (rv >= 2.5 ? 0.2 : 0.1) + (bx.extensionAtr <= 0.6 ? 0.2 : 0), 0, 1), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} just broken down on ${rv.toFixed(1)}x volume (${bx.extensionAtr} ATR beyond the edge)`], stopRefs: [hi(bx.lo, 0.6 * t.atr), bx.mid], targetRefs: [bx.lo - bx.height, h1.levels.support?.price, h1.levels.support2?.price] });
      break;
    }
  }
  for (const t of [h1, m15]) {
    const sw = t.sweep.bearish, bx = t.box;
    const trap = bx && (bx.state === 'liquidity_sweep_high' || bx.state === 'fake_breakout_up');
    if ((sw || trap) && (supplyNow(t) || t.candles.score <= -0.2)) {
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
 * ANTI-CHASING. How much of the move has ALREADY happened, measured five ways. score 0 (fresh) .. 1 (fully chased). It is a PENALTY (timing and composite), never an automatic rejection.
 * side +1 long / -1 short. level = the setup's anchor price. target = where the trade is aiming.
 */
const RETEST_STYLE = new Set(['trend_pullback', 'breakout_retest', 'liquidity_sweep', 'support_bounce', 'trend_continuation', 'failed_bounce', 'breakdown_retest', 'bull_trap']);     // entries AT a level after the move: breakout -> retest -> entry
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

/**
 * The entry zone the plan is anchored to. If price has moved only SLIGHTLY past it (within zoneTolerance ATRs) and the setup is still valid, the zone is RECALCULATED around the live price
 * instead of the trade being abandoned; further away it stays outside (a confirmation there is chasing and the entry is cancelled).
 */
function zoneOf(side, setup, price, T) {
  const tf = setup.levelTf === 'm15' ? T['15m'] : T['1h'], a = tf.atr, L = setup.level;
  if (L == null) return { lo: price * 0.998, hi: price * 1.002, planned: price, level: null, atr: a };
  const base = side === 'long' ? { lo: L - 0.4 * a, hi: L + 0.6 * a } : { lo: L - 0.6 * a, hi: L + 0.4 * a };
  const outside = side === 'long' ? price - base.hi : base.lo - price;
  if (outside > 0 && outside <= B.zoneTolerance * a) {
    return side === 'long' ? { lo: base.lo, hi: price + 0.4 * a, planned: price, level: L, atr: a, recalculated: true, baseHi: base.hi } : { lo: price - 0.4 * a, hi: base.hi, planned: price, level: L, atr: a, recalculated: true, baseLo: base.lo };
  }
  return { ...base, planned: clamp(price, base.lo, base.hi), level: L, atr: a };
}

/** TIMING 0..100. Anti-chasing first, then a trigger (a concrete one or several weaker ones), whether the flow agrees right now, and whether price is inside the planned zone. */
function timingOf(side, setup, chase, zone, T, price) {
  const { m15 } = tfs(T), sgn = side === 'long' ? 1 : -1;
  const flowNow = clamp(sgn * flowScore(m15), 0, 1);
  const edge = side === 'long' ? (zone.baseHi ?? zone.hi) : (zone.baseLo ?? zone.lo);
  const outside = side === 'long' ? price - edge : edge - price;                                   // > 0 = beyond the original zone, i.e. chasing
  const tf = setup.levelTf === 'm15' ? m15 : T['1h'];
  const proximity = outside <= 0 ? 1 : clamp(1 - outside / (1.5 * tf.atr), 0, 1);
  const score = 100 * (0.4 * (1 - chase.score) + 0.3 * (setup.triggerStrength ?? 0) + 0.15 * flowNow + 0.15 * proximity);
  return { score: +score.toFixed(1), trigger: setup.trigger ?? [], flowNow: +flowNow.toFixed(2), proximity: +proximity.toFixed(2), insideZone: outside <= 0 || !!zone.recalculated, recalculated: !!zone.recalculated };
}

const stripSide = (d) => ({ action: d.action, verdict: d.verdict, score: d.score, scores: d.scores, setup: d.setup?.label ?? null, vetoes: d.vetoes.map((v) => v.text).slice(0, 3), pUp: d.pUp, rr: d.rr });

/** No setup, but is the coin extended away from where an entry would have been? The latest breakout level (or the 1h EMA20) is the reference, so "bullish but already pumped" is explained as LATE. */
function pseudoAnchor(side, T) {
  const { h1, m15 } = tfs(T), long = side === 'long';
  const bx = [h1, m15].map((t) => t.box).find((b) => b && (long ? b.brokeUp : b.brokeDown));
  return { name: 'none', label: 'no setup', quality: 0, level: bx ? (long ? bx.hi : bx.lo) : h1.ema20, levelTf: 'h1', trigger: [], triggerStrength: 0, why: [] };
}

/* ================================================================== evaluate one side */
function evaluate(side, inp, T) {
  const { d1, h4, h1, m15 } = tfs(T), price = h1.price, long = side === 'long', sgn = long ? 1 : -1;
  const reg = inp.regime ?? { label: 'unknown', score: 0, severe: false, allowLongs: true, riskMult: 0.6, probShiftLong: 0, probShiftShort: 0, notes: [] };
  const model = inp.empirical ?? DEFAULT_MODEL;
  const vetoes = [], cautions = [], pens = [];
  const veto = (code, text, hard = true) => vetoes.push({ code, text, hard });          // BLOCKS the trade
  const caution = (code, text) => cautions.push({ code, text });                       // does not block: costs score and is shown
  const pen = (code, pts, text) => { pens.push({ code, pts, text }); };
  const rs = inp.rs ?? {};
  const rel = { vs1h: (inp.chg1h ?? 0) - (rs.mkt1 ?? 0), vsBTC24: (inp.chg24h ?? 0) - (rs.btc24 ?? 0), vsETH24: (inp.chg24h ?? 0) - (rs.eth24 ?? 0), vsMkt24: (inp.chg24h ?? 0) - (rs.mkt24 ?? 0) };
  const exceptionalRS = long ? rel.vsBTC24 >= 0.05 && rel.vs1h >= 0 : rel.vsBTC24 <= -0.05 && rel.vs1h <= 0;
  for (const w of inp.warnings ?? []) pen('warning', 3, w);

  /* ---- 1. VETOES: only genuinely dangerous conditions. Everything else is a penalty. */
  const reversalEvidence = long && (h1.trend.bullBreak || !!h1.sweep.bullish || h1.flow.shift === 'demand_takeover' || m15.trend.bullBreak || h1.trend.higherLowAfterLow || !!m15.sweep.bullish);
  if (long) {
    if (h4.trend.score <= -0.6 && !reversalEvidence) veto('downtrend_h4_extreme', `4h is in a ${stateName[h4.trend.state]} and there is no meaningful reversal evidence (no structure break, sweep, higher low or demand shift)`);
    else if (isDown(h4)) pen('downtrend_h4', reversalEvidence ? 2 : 6, `4h is in a ${stateName[h4.trend.state]}${reversalEvidence ? ' (reversal evidence present)' : ''}`);
    if (h1.trend.score <= -0.6 && h1.flow.control === 'supply_control' && h1.flow.recent <= -0.25 && !reversalEvidence) veto('downtrend_h1_extreme', `1h is a ${stateName[h1.trend.state]} with strong selling (pressure ${h1.flow.recent}) and no reversal / structure-break evidence`);
    else if (isDown(h1)) pen('downtrend_h1', reversalEvidence ? 2 : 5, `1h is in a ${stateName[h1.trend.state]}${reversalEvidence ? ' (reversal evidence present)' : ''}`);
    if (d1 && d1.trend.state === 'strong_down') pen('downtrend_d1', 2, 'daily trend is a strong downtrend (context only)');
    if (h1.flow.control === 'supply_control' && h1.flow.shift !== 'demand_takeover') pen('supply_control', 4, `sellers are in control on the 1h (pressure ${h1.flow.recent})`);
    const bearish = [isDown(h1), isDown(h4), h1.flow.control === 'supply_control', m15.candles.score <= -0.4, h1.candles.score <= -0.4, h1.momentum.score <= -0.3, !h1.aboveEma50, h1.sweep.bearish != null || h1.box?.fakeUp].filter(Boolean).length;
    if (bearish >= 4) pen('bearish_signals', Math.min(16, 4 * (bearish - 3)), `${bearish} of 8 bearish signals are active: lower confidence`);
    if (inp.news?.catastrophic) veto('catastrophic_news', `catastrophic coin-specific news: ${inp.news.catastrophic}`);
    else if (inp.news?.dangerous) caution('negative_news', `negative news: ${inp.news.danger}`);
    if (!reg.allowLongs) veto('severe_regime', `severe market conditions: ${(reg.notes ?? []).slice(-1)[0] ?? reg.label}`);
  } else {
    const revDown = h1.trend.bearBreak && (h1.flow.shift === 'supply_takeover' || h1.flow.control === 'supply_control');
    if (isUp(h4) && isUp(h1) && !revDown) veto('uptrend', `4h and 1h are both in uptrends (${stateName[h4.trend.state]} / ${stateName[h1.trend.state]}) and no breakdown has happened`);
    else if (h4.trend.state === 'strong_up' && !revDown) veto('uptrend_h4', '4h is a strong uptrend: shorting against it needs a confirmed breakdown first');
    if (h1.flow.control === 'demand_control' && h1.flow.shift !== 'supply_takeover' && !revDown) veto('demand_control', `buyers are in control on the 1h (pressure ${h1.flow.recent})`);
    if (rel.vsBTC24 >= 0.08 && rel.vs1h >= 0) veto('strong_rs', `exceptional relative strength (+${(rel.vsBTC24 * 100).toFixed(1)}% vs BTC over 24h and still outperforming the market this hour): not a short`);
    const bullish = [isUp(h1), isUp(h4), h1.flow.control === 'demand_control', m15.candles.score >= 0.4, h1.candles.score >= 0.4, h1.momentum.score >= 0.3, h1.aboveEma50, h1.sweep.bullish != null || h1.box?.fakeDown].filter(Boolean).length;
    if (bullish >= 4) pen('bullish_signals', Math.min(16, 4 * (bullish - 3)), `${bullish} of 8 bullish signals are active: lower confidence`);
    if (inp.news?.bullishDanger) veto('squeeze_news', `strongly bullish news: ${inp.news.bullishDanger}`);
  }
  if (inp.book) {
    if (inp.book.spreadPct > B.maxSpreadPct) veto('illiquid_book', `order-book spread ${inp.book.spreadPct.toFixed(2)}% > ${B.maxSpreadPct}%`);
    else if (Math.min(inp.book.depthUsd.pct1.bid, inp.book.depthUsd.pct1.ask) < B.minDepthUsd) veto('illiquid_book', `extremely thin book: under $${B.minDepthUsd.toLocaleString('en-US')} resting within 1% on one side`);
  }

  /* ---- 2. setup (one strong setup is enough; a couple of disagreeing indicators do not disqualify it) */
  const ctx = { chg24h: inp.chg24h, rel, discovered: inp.discovered };
  const setups = long ? detectLongSetups(T, ctx) : detectShortSetups(T, ctx);
  const best = setups[0] ?? null;
  const weak = weakConfirms(side, T, rel);
  if (best && !best.trigger?.length && weak.length >= 3) { best.trigger = [`several weaker confirmations agree: ${weak.slice(0, 4).join(', ')}`]; best.triggerStrength = 0.45; }
  else if (best && best.trigger?.length && weak.length >= 3) best.triggerStrength = clamp((best.triggerStrength ?? 0) + 0.1, 0, 1);
  if (!best) veto('no_setup', long ? 'no defined long setup (pullback, breakout + retest, fresh breakout, reversal, sweep reclaim, momentum, relative strength, support bounce, trend continuation or a discovered pattern)' : 'no defined short setup (failed bounce, breakdown + failed retest, bull trap or fresh breakdown)', false);
  if (h1.box && h1.box.state === 'inside' && h1.box.pos > 0.35 && h1.box.pos < 0.65 && !(best && ['trend_pullback', 'failed_bounce', 'support_bounce'].includes(best.name))) pen('mid_range', 3, `price is in the middle of the 1h range ${f2(h1.box.lo)}-${f2(h1.box.hi)}: a weaker location, not a rejection`);

  /* ---- 3. plan: stop, target, spread-inclusive R:R, empirical probability and EV */
  let shaped = null, stopRef = null, targetRef = null, holdHours = null, room = null, chase = null, zone = null, timing = null, emp = null, realisticR = null, ev = null, evLB = null, evSE = null, pUp = null, rTarget = null, rrNet = null, confidence = 0;
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
    // EV must include fees, slippage AND the spread: rr (net of fees + slippage) is re-priced with the quoted spread
    const sp = (inp.book?.spreadPct ?? 0) / 100, riskPct = shaped.stopDist + COST_RT;
    rrNet = +(((shaped.rr * riskPct) - sp) / (riskPct + sp)).toFixed(3);
    if (shaped.stopDist > R.stopAbsMaxPct + 1e-9) veto('no_valid_stop', `the structural stop (${pc(shaped.stopDist)}) is wider than the protected ${R.stopAbsMaxPct * 100}% maximum`);
    if (rrNet < R.minRR) veto('poor_rr', `net R:R ${rrNet.toFixed(2)} < the protected ${R.minRR} (stop ${f2(shaped.stop)}, target ${f2(shaped.target)}${room != null ? `, nearest ${long ? 'resistance' : 'support'} only ${room.toFixed(1)}R away` : ''})`, false);
    holdHours = Math.round(clamp((Math.abs(shaped.target - price) / h1.atr) * 1.3, 2, 72));
    if (best.name === 'momentum_continuation') holdHours = Math.min(holdHours, 24);
    // low volatility only blocks when the expected move CANNOT realistically cover fees, spread, stop and target (72h random-walk range ~ 8.5 x the 1h ATR)
    const reachable = 8.5 * h1.atrPct, needed = Math.abs(shaped.target - price) / price;
    if (reachable < 0.6 * needed || reachable < 3 * (COST_RT + sp)) veto('dead_market', `too little volatility: the ~72h reachable range (${pc(reachable)}) cannot realistically cover the ${pc(needed)} the target needs plus fees and spread`);
    rTarget = Math.abs(shaped.target - price) / Math.abs(price - shaped.stop);                  // gross R the target asks for
    emp = model.pReach(best.name, side, rTarget);
    realisticR = model.realisticR(best.name, side, B.minPUp);
    pUp = +clamp(emp.p + (((long ? reg.probShiftLong : reg.probShiftShort) ?? 0) * (long && exceptionalRS && reg.probShiftLong < 0 ? 0.4 : 1)), 0.02, 0.95).toFixed(3);
    ev = +(pUp * rrNet - (1 - pUp)).toFixed(3);
    const nEff = Math.max(1, emp.n + Math.min(10, (emp.nPooled ?? 0) / 20));                    // how much measured history stands behind this number
    evSE = +((rrNet + 1) * Math.sqrt(pUp * (1 - pUp) / nEff)).toFixed(3);
    evLB = +(ev - B.evSeK * evSE).toFixed(3);
    confidence = +clamp(emp.n / (2 * B.dataMinN), 0.05, 1).toFixed(2);
    if (rTarget > realisticR + 0.25) caution('unrealistic_target', `target asks for ${rTarget.toFixed(1)}R but this setup has historically reached that only ${(emp.p * 100).toFixed(0)}% of the time (realistic: about ${realisticR}R)`);
    if (emp.n < B.dataMinN) caution('thin_history', `only ${emp.n} measured cases for this setup (${emp.source}): confidence is reduced, not invented`);
  }

  /* ---- 4. ANTI-CHASING with or without a setup (the anchor is the setup's level, or the latest breakout level / 1h EMA20): a penalty, never an automatic rejection */
  const anchor = best ?? pseudoAnchor(side, T);
  {
    const tgt = shaped?.target ?? (long ? (h1.levels.resistance?.price ?? price + 3.75 * h1.atr) : (h1.levels.support?.price ?? price - 3.75 * h1.atr));
    chase = chaseOf(side, T, anchor, price, tgt);
    zone = zoneOf(side, anchor, price, T);
    timing = timingOf(side, anchor, chase, zone, T, price);
    const used = `${chase.moveAtr} ATR moved in the last 12 bars, ${chase.distLevelAtr} ATR ${chase.distLevelAtr >= 0 ? 'beyond' : 'before'} the level ${f2(anchor.level)}, ${(chase.expectedMoveUsed * 100).toFixed(0)}% of the move to the target already made${chase.spikeSpent ? ', the volume spike already happened' : ''}${chase.stretched ? ', momentum is stretched' : ''}`;
    if (chase.verdict === 'chasing') caution('chasing', `chasing: ${used}`);
    else if (chase.verdict === 'late') caution('late_entry', `late: ${used}`);
    if (!timing.insideZone) caution('outside_zone', `price ${f2(price)} is outside the planned entry zone ${f2(zone.lo)}-${f2(zone.hi)} (anchored to ${f2(anchor.level)}): it would have to come back`);
    else if (zone.recalculated) caution('zone_recalculated', `price is slightly past the planned zone, so the zone was recalculated around ${f2(price)} instead of abandoning the setup`);
    if (best && !best.trigger?.length) veto('no_why_now', 'no trigger at all (not even several weaker confirmations) for acting at this price right now', false);
  }
  if (long && isDown(m15) && !m15.trend.bullBreak && !m15.sweep.bullish && m15.flow.shift !== 'demand_takeover') caution('m15_down', `15m is in a ${stateName[m15.trend.state]}: acceptable only if it is a pullback / reversal, so timing is reduced`);
  if (!long && isUp(m15) && !m15.trend.bearBreak && !m15.sweep.bearish && m15.flow.shift !== 'supply_takeover') caution('m15_up', `15m is in a ${stateName[m15.trend.state]}: timing is reduced`);

  /* ---- 5. scores */
  // DIRECTION: independent evidence FAMILIES. RSI / MACD / ROC / EMA describe the same thing, so they enter as ONE momentum family and never count as confirmation.
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
  const ctxFam = clamp(sgn * (reg.score ?? 0) * 0.6 + sgn * (inp.news?.effect ?? 0) * 0.4, -1, 1);
  const dirW = { structure: 0.32, flow: 0.25, relStrength: 0.15, momentum: 0.10, context: 0.18 };
  const smart = inp.smart ? (long ? (inp.smart.net > 0 ? 0.5 : inp.smart.net < 0 ? -1 : 0) : (inp.smart.net < 0 ? 0.5 : inp.smart.net > 0 ? -1 : 0)) : 0;
  const dirRaw = dirW.structure * fam.structure + dirW.flow * fam.flow + dirW.relStrength * fam.relStrength + dirW.momentum * fam.momentum + dirW.context * ctxFam + 0.01 * smart;
  const agree = [['structure', fam.structure > 0.25], ['flow', fam.flow > 0.2], ['relative strength', fam.relStrength > 0.15], ['context (regime/news)', ctxFam > 0.1]].filter(([, ok]) => ok).map(([k]) => k);
  // One family can be enough ONLY when this exact setup has measured, meaningfully positive expectancy; otherwise it costs direction.
  const strongSingle = !!best && (emp?.n ?? 0) >= B.dataMinN && ev != null && ev >= B.minEV * 2 && evLB > 0;
  if (best && agree.length < 2) {
    if (strongSingle) caution('single_family_allowed', `only ${agree.length} independent evidence family agrees (${agree.join(', ') || 'none'}), allowed because this setup has measured positive expectancy (n=${emp.n}, EV ${ev}R)`);
    else pen('single_family', 8, `only ${agree.length} independent evidence family agrees (${agree.join(', ') || 'none'}): RSI/MACD/momentum/EMAs describe one condition and do not count as confirmation`);
  }
  const adjDir = clamp((inp.adj ?? []).filter((a) => !/^(chase|timing)/.test(a.key)).reduce((s, a) => s + a.delta, 0), -B.learnBound, B.learnBound);
  const adjTim = clamp((inp.adj ?? []).filter((a) => /^(chase|timing)/.test(a.key)).reduce((s, a) => s + a.delta, 0), -B.learnBound, B.learnBound);
  const direction = +clamp(50 + 50 * dirRaw - pens.reduce((s, p) => s + p.pts, 0) + adjDir, 0, 100).toFixed(1);
  const tPen = cautions.some((c) => c.code === 'm15_down' || c.code === 'm15_up') ? 10 : 0;
  const timingScore = timing ? +clamp(timing.score - tPen + adjTim, 0, 100).toFixed(1) : 0;
  let geometry = 0;
  if (shaped) {
    const rrF = clamp((rrNet - 1.0) / 2.5, 0, 1), evF = clamp((ev + 0.1) / 0.8, 0, 1), roomF = clamp((room ?? 0) / 4, 0, 1), stopF = shaped.stopDist <= R.stopAbsMaxPct ? 1 : 0;
    geometry = +(100 * (0.35 * rrF + 0.35 * evF + 0.2 * roomF + 0.1 * stopF)).toFixed(1);
  }
  const scores = { direction, timing: timingScore, geometry };
  const C = B.composite, mean = C.wDirection * direction + C.wTiming * timingScore + C.wGeometry * geometry, weakest = Math.min(direction, timingScore, geometry);
  const composite = +clamp(mean - Math.max(0, C.weakBelow - weakest) * C.weakPenalty - (chase ? C.chasePenalty * Math.max(0, chase.score - C.chasePenaltyFrom) : 0), 0, 100).toFixed(1);
  const floor = +(B.minComposite + (reg.score <= -0.5 ? 8 : reg.score <= -0.25 ? 4 : reg.score >= 0.5 ? -3 : 0) - (exceptionalRS ? 4 : 0)).toFixed(1);   // more selective in a weak BTC, relaxed for exceptional relative strength / a strong BTC
  const score = composite;

  if (best && composite < floor) veto('low_composite', `composite ${composite} < ${floor} (direction ${direction}, timing ${timingScore}, geometry ${geometry}${weakest < C.weakBelow ? `; the weakest part (${weakest}) pulls it down` : ''})`, false);
  if (best && ev != null && !(ev >= B.minEV && evLB > 0)) veto('low_ev', `expected value ${ev}R is not meaningfully positive after fees, spread and slippage (needs >= ${B.minEV}R and still > 0 after allowing for estimate uncertainty: lower bound ${evLB}R; ${emp.source})`, false);

  /* ---- 6. verdict */
  const hard = vetoes.filter((v) => v.hard);
  let action = 'IGNORE', cls = 'NEUTRAL';
  if (!vetoes.length) { action = long ? 'BUY' : 'SHORT'; cls = long ? 'HOT' : 'SHORT'; }
  else if (!hard.length && (best || direction >= B.watchScore)) { action = 'WATCH'; cls = direction >= 68 && chase.verdict !== 'chasing' ? 'HOT' : 'WATCH'; }
  else if (long && hard.some((v) => ['downtrend_h4_extreme', 'downtrend_h1_extreme', 'catastrophic_news'].includes(v.code))) { action = 'IGNORE'; cls = 'AVOID'; }
  else if (!long && hard.some((v) => ['uptrend', 'uptrend_h4', 'demand_control', 'strong_rs', 'squeeze_news'].includes(v.code))) { action = 'IGNORE'; cls = 'NEUTRAL'; }
  else if (hard.some((v) => ['illiquid_book', 'screened_out', 'no_data', 'dead_market'].includes(v.code))) { action = 'IGNORE'; cls = 'IGNORE'; }
  else if (hard.some((v) => v.code === 'severe_regime' || v.code === 'no_valid_stop')) { action = 'WATCH'; cls = best ? 'WATCH' : 'NEUTRAL'; }
  if (long && action !== 'BUY' && direction < 40 && isDown(h1) && !reversalEvidence) { action = 'IGNORE'; cls = 'AVOID'; }
  const verdict = action === 'BUY' ? 'LONG' : action === 'SHORT' ? 'SHORT' : action === 'WATCH' ? 'WAIT' : 'IGNORE';

  /* ---- 7. reasons and the "Why NOW?" answer, all from the numbers above */
  const reasons = [];
  if (best) reasons.push(`${best.label}: ${best.why.join('; ')}`);
  reasons.push(`Trend: 1d ${stateName[d1?.trend.state] ?? 'n/a'}, 4h ${stateName[h4.trend.state]}, 1h ${stateName[h1.trend.state]}, 15m ${stateName[m15.trend.state]}`);
  reasons.push(`Supply/demand: 1h ${h1.flow.control.replace('_', ' ')} (pressure ${h1.flow.recent}${h1.flow.shift !== 'none' ? `, ${h1.flow.shift.replace('_', ' ')}` : ''}${h1.flow.absorption ? `, ${h1.flow.absorption.replace(/_/g, ' ')}` : ''}), 15m ${m15.flow.control.replace('_', ' ')}`);
  const pats = [...m15.candles.patterns, ...h1.candles.patterns].filter((p) => p.bias !== 0).map((p) => p.name);
  if (pats.length) reasons.push(`Candles: ${[...new Set(pats)].join(', ')}${m15.candles.atSupport || h1.candles.atSupport ? ' at support' : ''}${m15.candles.atResistance || h1.candles.atResistance ? ' at resistance' : ''}`);
  reasons.push(`Relative strength: ${pc(rel.vs1h)} vs the market (1h), ${pc(rel.vsBTC24)} vs BTC and ${pc(rel.vsETH24)} vs ETH (24h)${exceptionalRS ? ' (exceptional: the regime penalty is reduced)' : ''}`);
  reasons.push(`Volume ${(m15.volume.rvol ?? 0).toFixed(1)}x (15m) / ${(h1.volume.rvol ?? 0).toFixed(1)}x (1h); momentum 1h RSI ${h1.momentum.rsi}, MACD ${h1.momentum.macdRising ? 'rising' : 'falling'} (one family, not counted as confirmation)`);
  if (h1.levels.support || h1.levels.resistance) reasons.push(`Levels: support ${f2(h1.levels.support?.price)}, resistance ${f2(h1.levels.resistance?.price)}${h1.box ? `; 1h range ${f2(h1.box.lo)}-${f2(h1.box.hi)} (${h1.box.state.replace(/_/g, ' ')})` : ''}`);
  if (inp.news?.events?.length) reasons.push(`News: ${inp.news.events.slice(0, 2).map((e) => `${e.label} (${e.direction}, ${e.pricedIn === 'unknown' ? 'priced-in unknown' : e.pricedIn === 'no' ? 'not priced in' : `priced in: ${e.pricedIn}`})`).join('; ')}`);
  reasons.push(`Market: ${reg.label.replace(/_/g, ' ')} (${(reg.score ?? 0).toFixed(2)}): a ${((long ? reg.probShiftLong : reg.probShiftShort) * 100 || 0).toFixed(1)}pt probability shift, ${reg.riskMult ?? 1}x size and a composite floor of ${floor}, not a switch`);
  for (const a of inp.adj ?? []) if (a.delta) reasons.push(`Learned rule: ${a.why} (${a.delta > 0 ? '+' : ''}${a.delta} pts)`);
  if (inp.smart && inp.smart.net !== 0) reasons.push(`Tracked traders net ${inp.smart.net > 0 ? 'long' : 'short'} (data point only, 1% weight)`);

  const why = {
    coin: [...(inp.selected ?? []).filter((r) => (long ? !/weak|short/i.test(r) : /weak|short/i.test(r))), `${rel.vsBTC24 >= 0 ? '+' : ''}${(rel.vsBTC24 * 100).toFixed(1)}% vs BTC / ${(rel.vsETH24 * 100).toFixed(1)}% vs ETH / ${(rel.vsMkt24 * 100).toFixed(1)}% vs market (24h); ${(rel.vs1h * 100).toFixed(1)}% vs market this hour`].filter(Boolean),
    direction: [`${long ? 'LONG' : 'SHORT'} bias: direction score ${direction} from ${agree.length} independent families (${agree.join(', ') || 'none'})`, ...(best ? best.why.slice(0, 2) : ['no defined setup is offering an entry'])],
    price: [shaped ? `price ${f2(price)} is ${chase.distLevelAtr} ATR ${chase.distLevelAtr >= 0 ? 'beyond' : 'before'} the entry level ${f2(anchor.level)} (zone ${f2(zone.lo)}-${f2(zone.hi)}); stop ${f2(shaped.stop)}, target ${f2(shaped.target)}, net R:R ${rrNet.toFixed(2)} (after fees, spread and slippage)` : `price ${f2(price)} is ${chase.distLevelAtr} ATR ${chase.distLevelAtr >= 0 ? 'beyond' : 'before'} the reference level ${f2(anchor.level)} (a good entry would be in ${f2(zone.lo)}-${f2(zone.hi)})`, `${(chase.expectedMoveUsed * 100).toFixed(0)}% of the move to the target is already behind us; ${chase.moveAtr} ATR moved in the last 12 bars`],
    now: best && timing.trigger.length && timing.insideZone && chase.verdict !== 'chasing' ? [...timing.trigger, `price is ${timing.recalculated ? 'close to (zone recalculated)' : 'inside'} the planned zone${chase.verdict === 'late' ? ' but the move is somewhat late (penalised)' : ' and the move is fresh'} (chase score ${chase.score})`, ...(timing.flowNow >= 0.3 ? [`${long ? '15m demand' : '15m supply'} agrees right now`] : [])] : [],
    confirms: best ? [`the 1m candle must close in or just past the zone ${f2(zone.lo)}-${f2(zone.hi)}, hold the level ${f2(anchor.level)}, on reasonable volume and without violating the stop; it only has to confirm the thesis, not be a perfect candle`] : [],
    invalidates: shaped ? [`price trades through the stop ${f2(shaped.stop)}`, long ? `a 1h close back below the level ${f2(anchor.level)} / a 1h structure break` : `a 1h close back above the level ${f2(anchor.level)} / a 1h structure break up`] : [],
    failure: [
      ...(room != null && room < 3 ? [`only ${room.toFixed(1)}R of room to the next ${long ? 'resistance' : 'support'}`] : []),
      ...(emp ? [`${emp.source}: P(target before stop) ${(pUp * 100).toFixed(0)}%${confidence < 1 ? ` (data confidence ${(confidence * 100).toFixed(0)}%)` : ''}`] : []),
      ...cautions.slice(0, 3).map((c) => c.text), ...pens.slice(0, 2).map((p) => p.text),
    ].slice(0, 6),
  };
  if (!why.now.length && action === 'BUY') action = 'WATCH';       // safety net: never trade without a "why now"

  // EXPLORATION: eligible only when the protected 2.5R requirement is the SOLE thing in the way (no real veto, composite floor met, a why-now exists) and the net R:R is at least the sanity floor.
  // The EV test is waived: it is computed at the lower R:R, so it is the same shortfall seen from the other side (and a model that says "negative" is exactly what the experiment must be able to test).
  // Risk is tiny (0.10% - 0.25% of equity), larger for a higher composite. Paper only; the normal rules are untouched.
  const X = B.explore;
  let exploration = null;
  if (long && X.enabled && action === 'WATCH' && best && shaped && vetoes.some((v) => v.code === 'poor_rr') && vetoes.every((v) => v.code === 'poor_rr' || v.code === 'low_ev') && rrNet >= X.minRR && why.now.length) {
    const t = clamp((composite - floor) / 20, 0, 1);
    exploration = { eligible: true, riskPct: +(X.riskMin + (X.riskMax - X.riskMin) * t).toFixed(5), rr: +rrNet.toFixed(2), reason: `fails only the protected ${R.minRR}R requirement (net R:R ${rrNet.toFixed(2)}${ev != null && ev < B.minEV ? `; its modelled EV is ${ev}R, which the experiment exists to test` : ''}); every other gate passed` };
  }

  const waitingFor = [];
  if (action !== 'BUY' && action !== 'SHORT') {
    const codes = new Set([...vetoes, ...cautions].map((v) => v.code));
    if (codes.has('chasing') || codes.has('late_entry') || codes.has('outside_zone')) waitingFor.push(`a pullback / retest into the entry zone ${f2(zone.lo)}-${f2(zone.hi)} around ${f2(anchor.level)} (price is ${chase.distLevelAtr} ATR ${chase.distLevelAtr >= 0 ? 'beyond' : 'before'} it): ${(best?.label ?? 'a continuation').toLowerCase()} is better entered at the level than after the move`);
    if (long && (codes.has('downtrend_h4_extreme') || codes.has('downtrend_h1_extreme'))) waitingFor.push(`reversal evidence: a close above the 1h lower-high ${f2(h1.trend.lastHigh)}, a higher low above ${f2(h1.swing.lastLow)}, or buyers taking control on rising volume`);
    if (!long && codes.has('uptrend')) waitingFor.push(`a confirmed breakdown: a 1h close below the last higher-low ${f2(h1.trend.lastLow)} with sellers taking control`);
    if (codes.has('poor_rr') && h1.levels.support && long) waitingFor.push(`a better entry nearer support ${f2(h1.levels.support.price)}, or a break above resistance ${f2(h1.levels.resistance?.price)} that opens room (the protected minimum is ${R.minRR} net R:R)`);
    if (codes.has('unrealistic_target')) waitingFor.push(`a target the setup has historically reached (needs ${rTarget?.toFixed(1)}R, history supports ~${realisticR}R)`);
    if (codes.has('no_why_now')) waitingFor.push('some trigger at the planned level: a rejection candle, a supply/demand shift, a held retest, or several weaker confirmations together');
    if (codes.has('low_composite')) waitingFor.push(`a better combined score (needs ${floor}; direction ${direction}, timing ${timingScore}, geometry ${geometry})`);
    if (codes.has('low_ev') || codes.has('thin_history')) waitingFor.push('a setup whose measured history shows meaningfully positive expectancy after costs (confidence rises as more of its outcomes are measured)');
    if (codes.has('no_setup') && !waitingFor.length) waitingFor.push('a defined setup at a level');
    if (codes.has('severe_regime')) waitingFor.push('the severe market conditions (BTC crash / strong downtrend) to ease');
  }

  return {
    symbol: inp.symbol, at: Date.now(), action, verdict, direction: action === 'IGNORE' && !best ? 'NONE' : long ? 'LONG' : 'SHORT', side, cls,
    score, mean: +mean.toFixed(1), floor, scores, pUp: pUp ?? 0, pUpSource: emp ? emp.source : 'no setup', pSample: emp?.n ?? 0, confidence, ev, evLB, evSE, setup: best ? { name: best.name, label: best.label, quality: +best.quality.toFixed(2), reversal: !!best.reversal, discovered: !!best.discovered } : null,
    entry: shaped ? price : null, stop: shaped?.stop ?? null, target: shaped?.target ?? null, rr: rrNet != null ? +rrNet.toFixed(2) : null, stopDist: shaped?.stopDist ?? null, holdHours,
    entryZone: zone ? { lo: zone.lo, hi: zone.hi, level: zone.level, planned: zone.planned, atr: zone.atr, recalculated: !!zone.recalculated } : null, maxEntry: zone ? (long ? zone.hi : zone.lo) : null,
    chase, timing, why, realisticR, targetR: rTarget != null ? +rTarget.toFixed(2) : null, riskMult: reg.riskMult ?? 1, setupsFound: setups.map((x) => x.name), exploration,
    reasons, vetoes, cautions, penalties: pens, waitingFor, blocked: vetoes.map((v) => v.text), adjustments: inp.adj ?? [],
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
 *  vol24, smart ({net}|null), adj (learning adjustments), empirical (empirical.buildModel), selected (why this coin was picked), warnings [text], discovered [rules], shape(entry, stop, target), rejected ({text}|null)
 * A coin that is missing the 4h or 5m history (a new listing) is still analysed: the nearest available timeframe stands in and a penalty says so.
 */
export function decide(inp) {
  const { symbol } = inp;
  let T = inp.ta;
  const base = { symbol, at: Date.now(), action: 'IGNORE', verdict: 'IGNORE', direction: 'NONE', cls: 'IGNORE', score: 0, scores: { direction: 0, timing: 0, geometry: 0 }, pUp: 0, ev: null, setup: null, reasons: [], vetoes: [], cautions: [], waitingFor: [], evidence: {}, entry: null, stop: null, target: null, rr: null, holdHours: null, factors: {}, why: null };
  if (inp.rejected) return { ...base, vetoes: [{ code: 'screened_out', hard: true, text: inp.rejected.text }], reasons: [inp.rejected.text] };
  if (!T?.['1h'] || !T['15m']) return { ...base, vetoes: [{ code: 'no_data', hard: true, text: 'not enough completed 1h / 15m candles to calculate the structure indicators' }], reasons: ['not enough completed 1h / 15m candles to calculate the structure indicators'] };
  const subs = [];
  if (!T['4h']) { T = { ...T, '4h': T['1h'] }; subs.push('4h history is not available yet: the 1h stands in for it'); }
  if (!T['5m']) { T = { ...T, '5m': T['15m'] }; subs.push('5m history is not available: the 15m stands in for it'); }
  const L = evaluate('long', subs.length ? { ...inp, warnings: [...(inp.warnings ?? []), ...subs] } : inp, T);
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
  const h1 = ta?.['1h'], h4 = ta?.['4h'] ?? ta?.['1h'];
  if (!h1 || !h4) return { action: 'HOLD', reasons: ['no fresh structure read: the stop and trailing stop keep protecting the position'], sell: false };
  const reasons = [], broke = h1.trend.bearBreak && (h1.flow.control === 'supply_control' || h1.flow.shift === 'supply_takeover') && h1.momentum.score < 0;
  const dead = isDown(h4) && isDown(h1) && price < h1.ema50;
  if (broke) reasons.push(`1h structure broke: lost the higher low ${f2(h1.trend.lastLow)} with sellers in control (pressure ${h1.flow.recent})`);
  if (dead) reasons.push(`both 4h and 1h are now in downtrends and price is below the 1h EMA50 ${f2(h1.ema50)}`);
  if (reasons.length) return { action: 'SELL', reasons, sell: true, invalidation: h1.trend.lastLow };
  return { action: 'HOLD', reasons: [`structure intact: 1h ${stateName[h1.trend.state]}, 4h ${stateName[h4.trend.state]}${h1.trend.lastLow ? `, higher low ${f2(h1.trend.lastLow)} holds` : ''}`], sell: false, invalidation: h1.trend.lastLow };
}
