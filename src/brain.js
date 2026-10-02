// THE BRAIN: the AI's own decision for ONE coin from structure, supply/demand, candles, volume, momentum, regime, news and risk/reward.
//   decide() -> { action: BUY | WATCH | IGNORE (flat) / HOLD | SELL (open position), cls: HOT | WATCH | NEUTRAL | AVOID | IGNORE, score, pUp, ev, setup, entry/stop/target/rr, holdHours, reasons, vetoes, waitingFor, evidence }
// Pure functions: no I/O, no LLM, no randomness. Every reason in the output is generated from the numbers that fed the decision (not written afterwards).
// Other traders are at most a 1%-weight input and can never create a BUY or lift a veto. Nothing here can touch the risk limits (guardrails.js still has the last word).
import { config } from './config.js';

const B = config.brain, W = B.weights;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f2 = (x) => (x == null || !Number.isFinite(x) ? '?' : Math.abs(x) >= 100 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(3) : x.toPrecision(4));
const pc = (x) => `${(x * 100).toFixed(1)}%`;
const lo = (x, k) => (x == null ? null : x - k);   // null-safe "level minus buffer"
const tfs = (T) => ({ d1: T['1d'], h4: T['4h'], h1: T['1h'], m15: T['15m'], m5: T['5m'] });
const isUp = (t) => !!t && t.trend.score >= 0.25;
const isDown = (t) => !!t && t.trend.score <= -0.25;
const stateName = { strong_up: 'strong uptrend', up: 'uptrend', range: 'sideways', down: 'downtrend', strong_down: 'strong downtrend' };
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Score -> estimated probability that the target is hit before the stop (a heuristic map, calibrated by the backtest, then by the live record). */
export function probability(score, calib = B.calib) {
  return +clamp(calib.floor + (calib.ceil - calib.floor) * sigmoid((score - calib.mid) / calib.width), calib.floor, calib.ceil).toFixed(3);
}

/** Market regime from BTC (and ETH) structure plus breadth (share of analysed coins in a 1h uptrend). score -1..1. */
export function marketRegime({ btc, eth, breadth, btcGate }) {
  const t = (x) => (x ? x.trend.score : 0);
  const b1 = btc?.['1h'], b4 = btc?.['4h'], bd = btc?.['1d'];
  if (!b1 || !b4) return { label: 'unknown', score: 0, allowLongs: false, notes: ['BTC structure not available yet'], breadth: breadth ?? null };
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
  const notes = [`BTC 1d ${stateName[bd?.trend.state] ?? 'n/a'}, 4h ${stateName[b4.trend.state]}, 1h ${stateName[b1.trend.state]}`];
  if (eth?.['1h']) notes.push(`ETH 1h ${stateName[eth['1h'].trend.state]}`);
  if (breadth != null) notes.push(`${(breadth * 100).toFixed(0)}% of analysed coins in a 1h uptrend`);
  if (btcGate === false) notes.push('BTC 1h EMA gate is closed: long entries are suspended by the risk rules');
  return { label, score: +s.toFixed(2), allowLongs: label !== 'risk_off_downtrend' && btcGate !== false, notes, breadth: breadth ?? null };
}

const flowScore = (t) => (t ? clamp(t.flow.recent * 1.6, -1, 1) + (t.flow.shift === 'demand_takeover' ? 0.25 : t.flow.shift === 'supply_takeover' ? -0.25 : 0) + (t.flow.absorption === 'demand_absorbing_at_support' ? 0.2 : t.flow.absorption === 'supply_absorbing_at_resistance' ? -0.2 : 0) : 0);
const wavg = (pairs) => { let s = 0, w = 0; for (const [v, k] of pairs) if (v != null) { s += v * k; w += k; } return w ? s / w : 0; };

/** Structural stop candidates -> the nearest valid one: at least `minDist` below price. */
function pickStop(price, refs, minDist) {
  const ok = refs.filter((x) => x != null && Number.isFinite(x) && price - x >= minDist).sort((a, b) => b - a);
  return ok[0] ?? null;
}

/** All setups the market currently offers this coin. Each: { name, label, quality 0..1, stopRefs[], targetRefs[], why[] }. */
function detectSetups(T, ctx) {
  const { d1, h4, h1, m15, m5 } = tfs(T), price = h1.price, out = [];
  const a1 = h1.atr, a15 = m15.atr;
  const demandNow = (t) => t && (t.flow.shift === 'demand_takeover' || t.flow.control === 'demand_control' || t.flow.absorption === 'demand_absorbing_at_support');
  const bullCandle = (t) => t && t.candles.score >= 0.3;
  const m15Turn = m15.trend.bullBreak || m15.trend.score > -0.25 || !!m15.sweep.bullish || demandNow(m15);

  // A. Pullback inside an uptrend: buy support / the 1h EMA20 after the dip, not the middle of the move.
  if (h1.trend.score >= 0.25 && h4.trend.score >= 0) {
    const nearEma = price <= h1.ema20 + 0.3 * a1 && price >= h1.ema50 - 0.3 * a1;
    const sup = h1.levels.support, nearSup = sup && price - sup.price <= 1.0 * a1;
    const rsiOk = h1.momentum.rsi != null && h1.momentum.rsi >= 35 && h1.momentum.rsi <= 62;
    const trigger = bullCandle(m15) || bullCandle(h1) || !!m15.sweep.bullish || m15.trend.bullBreak || m15.flow.shift === 'demand_takeover';
    if ((nearEma || nearSup) && rsiOk && trigger && m15Turn) {
      let q = 0.5; const why = [`1h ${stateName[h1.trend.state]} pulled back to ${nearSup ? `support ${f2(sup.price)}` : `its EMA20 ${f2(h1.ema20)}`} (RSI ${h1.momentum.rsi})`];
      if (h4.trend.score >= 0.25) { q += 0.1; why.push('4h trend up as well'); }
      if (bullCandle(m15) || bullCandle(h1)) { q += 0.1; why.push(`bullish candle evidence: ${[...m15.candles.patterns, ...h1.candles.patterns].filter((p) => p.bias > 0).map((p) => p.name).join(', ') || 'rejection'}`); }
      if (m15.flow.shift === 'demand_takeover' || h1.flow.shift === 'demand_takeover') { q += 0.1; why.push('buyers taking control from sellers (supply -> demand shift)'); }
      if (sup && sup.touches >= 2) { q += 0.1; why.push(`support tested ${sup.touches}x`); }
      if (h1.volume.trend != null && h1.volume.trend < 1) { q += 0.05; why.push('selling volume drying up on the dip'); }
      out.push({ name: 'trend_pullback', label: 'Pullback in an uptrend', quality: clamp(q, 0.3, 1), why, stopRefs: [lo(m15.sweep.bullish?.wickLow, 0.25 * a15), lo(m15.swing.lastLow, 0.25 * a15), sup ? sup.price - 0.3 * a1 : null, lo(h1.swing.lastLow, 0.25 * a1)], targetRefs: [h1.levels.resistance?.price, h1.levels.resistance2?.price, h1.swing.lastHigh] });
    }
  }

  // B. Breakout of a box / range that has been retested and held (the safer entry), on 1h or 15m.
  for (const t of [h1, m15]) {
    const bx = t.box;
    if (bx && bx.brokeUp && bx.retest && bx.extensionAtr <= 2.2 && !isDown(h4) && t.flow.recent > -0.1) {
      const q = 0.55 + (t.volume.rvol3 >= 1.2 ? 0.1 : 0) + (demandNow(t) ? 0.1 : 0) + (bx.heightAtr >= 3 ? 0.05 : 0) + (isUp(h1) ? 0.1 : 0);
      out.push({ name: 'breakout_retest', label: 'Range breakout + retest', quality: clamp(q, 0.3, 1), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} broken up ${bx.barsSinceBreak} bars ago, retested ${f2(bx.hi)} and held`, ...(demandNow(t) ? ['demand in control after the break'] : [])], stopRefs: [lo(bx.hi, 0.6 * t.atr), bx.mid, lo(t.swing.lastLow, 0.25 * t.atr)], targetRefs: [bx.hi + bx.height, h1.levels.resistance?.price, h1.levels.resistance2?.price] });
      break;
    }
  }

  // C. Fresh range breakout with volume (earlier, riskier than B): only while it is not already extended.
  for (const t of [h1, m15]) {
    const bx = t.box, rv = Math.max(t.volume.rvol ?? 0, t.volume.rvol3 ?? 0);
    if (bx && bx.brokeUp && !bx.retest && bx.barsSinceBreak <= 4 && bx.extensionAtr <= 1.3 && rv >= 1.5 && !isDown(h4) && (demandNow(t) || t.flow.recent > 0.1) && !h1.momentum.overextended) {
      const q = 0.5 + (rv >= 2.5 ? 0.15 : 0.05) + (isUp(h1) ? 0.1 : 0) + (isUp(h4) ? 0.1 : 0);
      out.push({ name: 'range_breakout', label: 'Range breakout with volume', quality: clamp(q, 0.3, 1), why: [`${t.tf} range ${f2(bx.lo)}-${f2(bx.hi)} just broken up on ${rv.toFixed(1)}x volume (${bx.extensionAtr} ATR beyond the edge)`], stopRefs: [lo(bx.hi, 0.6 * t.atr), bx.mid], targetRefs: [bx.hi + bx.height, h1.levels.resistance?.price, h1.levels.resistance2?.price] });
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
      out.push({ name: 'trend_reversal', label: 'Early trend reversal', quality: clamp(q, 0.3, 1), reversal: true, why: [`${t.tf} downtrend broke its last lower-high ${f2(broken)} (structure shift), made a higher low ${f2(t.swing.lastLow)} and buyers took control (${t.flow.shift === 'demand_takeover' ? 'supply -> demand shift' : 'demand in control'})`], stopRefs: [lo(t.swing.lastLow, 0.25 * t.atr), lo(m15.swing.lastLow, 0.25 * a15)], targetRefs: [h1.levels.resistance?.price, h1.levels.resistance2?.price, t.swing.prevHigh] });
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
        out.push({ name: 'liquidity_sweep', label: 'Liquidity sweep reclaim', quality: clamp(q, 0.3, 1), why: [`${t.tf} price swept below ${f2(lvl)} (stops taken) and closed back above it: sellers failed${t.flow.shift === 'demand_takeover' ? ', buyers now taking control' : ''}`], stopRefs: [lo(wick, 0.25 * t.atr), lo(m15.swing.lastLow, 0.25 * a15)], targetRefs: [bx ? bx.mid : null, bx ? bx.hi : null, h1.levels.resistance?.price, h1.levels.resistance2?.price] });
        break;
      }
    }
  }

  // F. Momentum continuation: a coin already moving hard in a healthy trend that still has room, entered near its short-term mean, never at a vertical extreme.
  const strongMove = h1.momentum.roc6 >= 0.025 || h4.momentum.roc6 >= 0.03 || (ctx.chg24h ?? 0) >= 0.07;
  const rv15 = Math.max(m15.volume.rvol ?? 0, m15.volume.rvol3 ?? 0), rv1 = Math.max(h1.volume.rvol ?? 0, h1.volume.rvol3 ?? 0);
  if (strongMove && h1.trend.score >= 0.4 && h4.trend.score >= 0.25 && (h1.flow.control === 'demand_control' || m15.flow.control === 'demand_control') && Math.max(rv15, rv1) >= 1.3
    && !h1.momentum.overextended && !m15.momentum.overextended && m15.momentum.extensionAtr <= 2.2 && (h1.momentum.rsi ?? 50) <= 78) {
    const q = 0.5 + (Math.max(rv15, rv1) >= 2 ? 0.1 : 0) + (isUp(d1) ? 0.1 : 0) + (m15.trend.score >= 0.25 ? 0.1 : 0) + ((ctx.rs ?? 0) > 0.03 ? 0.1 : 0);
    out.push({ name: 'momentum_continuation', label: 'Momentum continuation', quality: clamp(q, 0.3, 1), why: [`strong mover (1h ${pc(h1.momentum.roc6)} / 6 bars, 24h ${pc(ctx.chg24h ?? 0)}) in a ${stateName[h1.trend.state]} with demand in control on ${Math.max(rv15, rv1).toFixed(1)}x volume; only ${m15.momentum.extensionAtr} ATR above the 15m mean (not vertical)`], stopRefs: [m15.ema20 - a15, lo(m15.swing.lastLow, 0.25 * a15), h1.ema20 - 0.5 * a1], targetRefs: [h1.levels.resistance?.price, h1.levels.resistance2?.price, price + 3 * a1] });
  }
  return out.sort((x, y) => y.quality - x.quality);
}

/** What would have to happen for this coin to become a BUY (shown for WATCH coins: the AI is willing to wait). */
function waitingFor(T, vetoes, ctx) {
  const { h4, h1, m15 } = tfs(T), w = [];
  const codes = new Set(vetoes.map((v) => v.code));
  if (codes.has('downtrend_h1') || codes.has('downtrend_h4') || codes.has('downtrend_d1')) {
    const t = isDown(h1) ? h1 : h4;
    w.push(`a confirmed reversal: close above the ${t.tf} lower-high ${f2(t.trend.lastHigh)}, hold a higher low above ${f2(t.swing.lastLow)}, with buyers taking control on rising volume`);
  }
  if (codes.has('wait_15m_turn')) w.push(`the 15m to stop making lower lows (turn: close above ${f2(m15.trend.lastHigh)} or a bullish rejection at ${f2(m15.levels.support?.price)})`);
  if (codes.has('overextended')) w.push(`a pullback toward the 1h EMA20 ${f2(h1.ema20)}${h1.levels.support ? ` or support ${f2(h1.levels.support.price)}` : ''} instead of chasing`);
  if (codes.has('poor_rr') && h1.levels.support) w.push(`a better entry nearer support ${f2(h1.levels.support.price)}, or a break above resistance ${f2(h1.levels.resistance?.price)} that opens room`);
  if (codes.has('mid_range') && h1.box) w.push(`price to reach the range edge (${f2(h1.box.lo)} bounce with rejection) or break and retest ${f2(h1.box.hi)}`);
  if (codes.has('no_setup') && !w.length) w.push(`a defined setup: pullback to support ${f2(h1.levels.support?.price)}, a break and retest above ${f2(h1.levels.resistance?.price)}, or a liquidity sweep reclaim`);
  if (codes.has('supply_control')) w.push('sellers to lose control (buying pressure back above zero on 1h)');
  if (codes.has('low_score') || codes.has('low_probability')) w.push('more confirming evidence (volume, momentum and structure agreeing)');
  return w;
}

/**
 * The decision for ONE coin. input:
 *  symbol, name, ta {1d,4h,1h,15m,5m} (structure.analyzeAll), regime (marketRegime), news (newsimpact.coinImpact), market (marketImpact), book (order book or null),
 *  chg24h, btcChg24h, vol24, smart ({net}|null), adj (learning adjustments [{key,delta,why}]), shape(entry, stop, target) -> { stop, target, rr, stopDist, band }, hasPosition, rejected ({text}|null)
 */
export function decide(inp) {
  const { symbol, ta: T } = inp;
  const base = { symbol, at: Date.now(), action: 'IGNORE', cls: 'IGNORE', score: 0, pUp: 0, ev: null, setup: null, reasons: [], vetoes: [], waitingFor: [], evidence: {}, entry: null, stop: null, target: null, rr: null, holdHours: null, factors: {} };
  if (inp.rejected) return { ...base, vetoes: [{ code: 'screened_out', hard: true, text: inp.rejected.text }], reasons: [inp.rejected.text] };
  if (!T?.['1h'] || !T['15m'] || !T['4h'] || !T['5m']) return { ...base, vetoes: [{ code: 'no_data', hard: true, text: 'not enough completed candles to analyse structure' }], reasons: ['not enough completed candles to analyse structure'] };
  const { d1, h4, h1, m15, m5 } = tfs(T), price = h1.price;
  const vetoes = [], veto = (code, text, hard = true) => vetoes.push({ code, text, hard });
  const reg = inp.regime ?? { label: 'unknown', score: 0, allowLongs: false };

  // ---- 1. Vetoes that hold regardless of any setup: this is what stops a buy in the middle of a downtrend.
  const revH1 = h1.trend.bullBreak && h1.swing.lastLow > (h1.swing.prevLow ?? Infinity) && (h1.flow.shift === 'demand_takeover' || h1.flow.control === 'demand_control');
  if (h4.trend.state === 'strong_down' || (isDown(h4) && !h4.trend.bullBreak && !revH1)) veto('downtrend_h4', `4h is in a ${stateName[h4.trend.state]} (${h4.trend.lh ? 'lower highs' : ''}${h4.trend.ll ? ' + lower lows' : ''}); no confirmed reversal yet`);
  if (isDown(h1) && !revH1) veto('downtrend_h1', `1h is in a ${stateName[h1.trend.state]} (lower highs/lows, below its EMAs); no confirmed structure break up`);
  if (d1 && d1.trend.state === 'strong_down' && !isUp(h4)) veto('downtrend_d1', 'daily trend is a strong downtrend and the 4h has not turned up');
  if (h1.flow.control === 'supply_control' && h1.flow.shift !== 'demand_takeover' && !revH1) veto('supply_control', `sellers are in control on the 1h (volume-weighted pressure ${h1.flow.recent}, ${h1.flow.shift === 'supply_takeover' ? 'a demand -> supply shift' : 'persistent'})`);
  const bearish = [isDown(h1), isDown(h4), h1.flow.control === 'supply_control', m15.candles.score <= -0.4, h1.candles.score <= -0.4, h1.momentum.score <= -0.3, !h1.aboveEma50, h1.sweep.bearish != null || h1.box?.fakeUp].filter(Boolean).length;
  if (bearish >= 4) veto('major_conflict', `${bearish} of 8 major bearish signals are active (trend, flow, candles, momentum, EMA, trap)`);
  if (inp.news?.dangerous) veto('bad_news', `dangerous news: ${inp.news.danger}`);
  if (inp.book) {
    if (inp.book.spreadPct > B.maxSpreadPct) veto('illiquid_book', `order-book spread ${inp.book.spreadPct.toFixed(2)}% > ${B.maxSpreadPct}%`);
    else if (Math.min(inp.book.depthUsd.pct1.bid, inp.book.depthUsd.pct1.ask) < B.minDepthUsd) veto('illiquid_book', `thin book: under $${B.minDepthUsd.toLocaleString('en-US')} resting within 1% on one side`);
  }
  if (!reg.allowLongs) veto('regime', `market regime is ${reg.label.replace(/_/g, ' ')}: ${(reg.notes ?? []).join('; ')}`);
  if (h1.momentum.overextended || m15.momentum.overextended) veto('overextended', `extended: ${h1.momentum.overextended ? `1h ${h1.momentum.extensionAtr} ATR above EMA20, RSI ${h1.momentum.rsi}` : `15m ${m15.momentum.extensionAtr} ATR above EMA20`}: chasing a vertical move has no edge`, false);
  if (isDown(m15) && !m15.trend.bullBreak && !m15.sweep.bullish && m15.flow.shift !== 'demand_takeover') veto('wait_15m_turn', `15m is still in a ${stateName[m15.trend.state]}: waiting for the short-term turn`, false);
  if (h1.box && h1.box.state === 'inside' && h1.box.pos > 0.35 && h1.box.pos < 0.65) veto('mid_range', `price is in the middle of the 1h range ${f2(h1.box.lo)}-${f2(h1.box.hi)} (${(h1.box.pos * 100).toFixed(0)}%): no edge from the middle`, false);

  // ---- 2. Setup
  const ctx = { chg24h: inp.chg24h, rs: (inp.chg24h ?? 0) - (inp.btcChg24h ?? 0) };
  const setups = detectSetups(T, ctx);
  const best = setups[0] ?? null;
  if (!best) veto('no_setup', 'no defined setup (pullback to support, breakout + retest, reversal, liquidity sweep or momentum continuation) is present', false);

  // ---- 3. Entry / stop / target / risk-reward, from structure
  let shaped = null, entry = price, stopRef = null, targetRef = null, holdHours = null, room = null;
  if (best) {
    const minDist = Math.max(0.5 * m15.atr, price * 0.004);
    stopRef = pickStop(price, best.stopRefs, minDist) ?? price - 1.5 * h1.atr;
    const tr = best.targetRefs.filter((x) => x != null && Number.isFinite(x) && x > price * 1.004).sort((a, b) => a - b);
    const risk = price - stopRef;
    // first meaningful level that already pays at least 2.5R, else the nearest one (poor R:R is then reported honestly)
    targetRef = tr.find((x) => (x - price) >= 2.5 * risk) ?? tr[0] ?? price + 2.5 * risk;
    room = tr[0] != null ? (tr[0] - price) / risk : null;
    shaped = inp.shape(entry, stopRef, targetRef);
    if (shaped.stopDist > config.risk.stopAbsMaxPct + 1e-9) veto('no_valid_stop', `the structural stop (${pc(shaped.stopDist)}) is wider than the ${config.risk.stopAbsMaxPct * 100}% hard cap`);
    if (shaped.rr < config.risk.minRR) veto('poor_rr', `net R:R ${shaped.rr.toFixed(2)} < ${config.risk.minRR} (stop ${f2(shaped.stop)}, target ${f2(shaped.target)}${room != null ? `, nearest resistance only ${room.toFixed(1)}R away` : ''})`, false);
    holdHours = Math.round(clamp(((shaped.target - entry) / h1.atr) * 1.3, 2, 72));
    if (best.name === 'momentum_continuation') holdHours = Math.min(holdHours, 24);
  }

  // ---- 4. Evidence factors (each -1..1) and the score
  const dirVol = m15.momentum.roc3 >= 0 ? 1 : -1;
  const rvAvg = (((m15.volume.rvol ?? 1) + (h1.volume.rvol ?? 1)) / 2);
  const nearRes = h1.levels.resistance && (h1.levels.resistance.price - price) <= 0.5 * h1.atr;
  const location = (m15.candles.atSupport || h1.candles.atSupport ? 0.6 : 0) - (nearRes ? 0.6 : 0);
  const f = {
    trend: clamp(wavg([[d1?.trend.score, 0.15], [h4.trend.score, 0.30], [h1.trend.score, 0.35], [m15.trend.score, 0.20]]) + (isUp(h4) && isUp(h1) && isUp(m15) ? 0.1 : 0), -1, 1),
    flow: clamp(wavg([[flowScore(h1), 0.4], [flowScore(m15), 0.35], [flowScore(h4), 0.25]]), -1, 1),
    candles: clamp(wavg([[m15.candles.score, 0.45], [h1.candles.score, 0.4], [m5.candles.score, 0.15]]), -1, 1),
    volume: clamp(clamp((rvAvg - 1) / 1.5, -0.3, 1) * dirVol * 0.7 + (h1.flow.upVolRatio - 0.5) * 0.6, -1, 1),
    momentum: clamp(wavg([[h1.momentum.score, 0.5], [m15.momentum.score, 0.3], [h4.momentum.score, 0.2]]) - (h1.momentum.overextended || m15.momentum.overextended ? 0.5 : 0) - (h1.momentum.extensionAtr > 2 ? 0.3 : 0), -1, 1),   // measured: stretched short-term strength mean-reverts, so it is penalised
    structure: clamp((shaped ? clamp((shaped.rr - 1.5) / 2.5, -1, 1) * 0.6 : -0.3) + location * 0.4, -1, 1),
    regime: reg.score ?? 0,
    relStrength: clamp(((inp.chg24h ?? 0) - (inp.btcChg24h ?? 0)) / 0.06, -1, 1),
    news: clamp((inp.news?.effect ?? 0) + (inp.market?.effect ?? 0) * 0.4, -1, 1),
    setup: best ? best.quality * 2 - 1 : -0.6,
    smart: inp.smart ? (inp.smart.net > 0 ? 0.5 : inp.smart.net < 0 ? -1 : 0) : 0,
  };
  let raw = 0;
  for (const k of Object.keys(W)) raw += W[k] * f[k];
  const adjDelta = clamp((inp.adj ?? []).reduce((s, a) => s + a.delta, 0), -B.learnBound, B.learnBound);
  const score = +clamp(50 + B.scoreScale * raw + adjDelta, 0, 100).toFixed(1);
  const pUp = inp.pUpFn ? inp.pUpFn(score) : probability(score, inp.calib ?? B.calib);
  const ev = shaped ? +(pUp * shaped.rr - (1 - pUp)).toFixed(2) : null;
  if (best && score < B.minScore) veto('low_score', `edge score ${score} < ${B.minScore}`, false);
  if (best && shaped && pUp < B.minPUp) veto('low_probability', `estimated chance of reaching the target before the stop ${(pUp * 100).toFixed(0)}% < ${(B.minPUp * 100).toFixed(0)}%`, false);
  if (best && ev != null && ev < B.minEV) veto('low_ev', `expected value ${ev}R < ${B.minEV}R after costs`, false);

  // ---- 5. Verdict
  const hard = vetoes.filter((v) => v.hard), wait = vetoes.filter((v) => !v.hard);
  let action = 'IGNORE', cls = 'NEUTRAL';
  if (!vetoes.length) { action = 'BUY'; cls = 'HOT'; }
  else if (!hard.length && (score >= B.watchScore || best)) { action = 'WATCH'; cls = score >= 68 && f.trend > 0.2 && f.momentum > 0 ? 'HOT' : 'WATCH'; }
  else if (hard.some((v) => ['downtrend_h1', 'downtrend_h4', 'downtrend_d1', 'supply_control', 'major_conflict', 'bad_news'].includes(v.code))) { action = 'IGNORE'; cls = 'AVOID'; }
  else if (hard.some((v) => ['illiquid_book', 'screened_out', 'no_data'].includes(v.code))) { action = 'IGNORE'; cls = 'IGNORE'; }
  else if (hard.some((v) => v.code === 'regime' || v.code === 'no_valid_stop')) { action = 'WATCH'; cls = best ? 'WATCH' : 'NEUTRAL'; }
  // A reversal that is forming inside a downtrend is something to WATCH (the AI waits for confirmation), not something to buy and not something to ignore.
  if (cls === 'AVOID' && (h1.trend.bullBreak || h1.sweep.bullish || h1.flow.shift === 'demand_takeover' || m15.trend.bullBreak) && !isDown(h4)) { action = 'WATCH'; cls = 'WATCH'; }

  // ---- 6. Reasons (generated from the same numbers used above)
  const reasons = [];
  if (best) reasons.push(`${best.label}: ${best.why.join('; ')}`);
  reasons.push(`Trend: 1d ${stateName[d1?.trend.state] ?? 'n/a'}, 4h ${stateName[h4.trend.state]}, 1h ${stateName[h1.trend.state]}, 15m ${stateName[m15.trend.state]}`);
  reasons.push(`Supply/demand: 1h ${h1.flow.control.replace('_', ' ')} (pressure ${h1.flow.recent}${h1.flow.shift !== 'none' ? `, ${h1.flow.shift.replace('_', ' ')}` : ''}${h1.flow.absorption ? `, ${h1.flow.absorption.replace(/_/g, ' ')}` : ''}), 15m ${m15.flow.control.replace('_', ' ')}`);
  const pats = [...m15.candles.patterns, ...h1.candles.patterns].filter((p) => p.bias !== 0).map((p) => p.name);
  if (pats.length) reasons.push(`Candles: ${[...new Set(pats)].join(', ')}${m15.candles.atSupport || h1.candles.atSupport ? ' at support' : ''}${m15.candles.atResistance || h1.candles.atResistance ? ' at resistance' : ''}`);
  reasons.push(`Volume ${(m15.volume.rvol ?? 0).toFixed(1)}x (15m) / ${(h1.volume.rvol ?? 0).toFixed(1)}x (1h); momentum 1h RSI ${h1.momentum.rsi}, MACD ${h1.momentum.macdRising ? 'rising' : 'falling'}`);
  if (h1.levels.support || h1.levels.resistance) reasons.push(`Levels: support ${f2(h1.levels.support?.price)}, resistance ${f2(h1.levels.resistance?.price)}${h1.box ? `; 1h range ${f2(h1.box.lo)}-${f2(h1.box.hi)} (${h1.box.state.replace(/_/g, ' ')})` : ''}`);
  if (inp.news?.events?.length) reasons.push(`News: ${inp.news.events.slice(0, 2).map((e) => `${e.label} (${e.direction}, ${e.pricedIn === 'unknown' ? 'priced-in unknown' : e.pricedIn === 'no' ? 'not priced in' : `priced in: ${e.pricedIn}`})`).join('; ')}`);
  reasons.push(`Market: ${reg.label.replace(/_/g, ' ')} (${(reg.score ?? 0).toFixed(2)})`);
  for (const a of inp.adj ?? []) if (a.delta) reasons.push(`Learned rule: ${a.why} (${a.delta > 0 ? '+' : ''}${a.delta} pts)`);
  if (inp.smart && inp.smart.net !== 0) reasons.push(`Tracked traders net ${inp.smart.net > 0 ? 'long' : 'short'} (data point only, 1% weight)`);

  const gates = vetoes.map((v) => v.text);
  const out = {
    ...base, action, cls, score, pUp, pUpSource: inp.pUpFn ? 'learned from measured outcomes' : 'prior (not yet validated by outcomes)', ev, setup: best ? { name: best.name, label: best.label, quality: +best.quality.toFixed(2), reversal: !!best.reversal } : null,
    entry: shaped ? entry : null, stop: shaped?.stop ?? null, target: shaped?.target ?? null, rr: shaped ? +shaped.rr.toFixed(2) : null, stopDist: shaped?.stopDist ?? null, holdHours,
    reasons, vetoes, waitingFor: action === 'BUY' ? [] : waitingFor(T, vetoes, ctx), blocked: gates,
    factors: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, +v.toFixed(2)])), adjustments: inp.adj ?? [],
    evidence: {
      trend: { '1d': d1?.trend.state, '4h': h4.trend.state, '1h': h1.trend.state, '15m': m15.trend.state },
      flow: { h1: h1.flow.control, h1shift: h1.flow.shift, m15: m15.flow.control, m15shift: m15.flow.shift, absorption: h1.flow.absorption ?? m15.flow.absorption },
      candles: [...new Set(pats)], volume: { rvol15: m15.volume.rvol, rvol1h: h1.volume.rvol },
      momentum: { rsi1h: h1.momentum.rsi, roc6: h1.momentum.roc6, ext1h: h1.momentum.extensionAtr, overextended: h1.momentum.overextended },
      levels: { support: h1.levels.support?.price ?? null, resistance: h1.levels.resistance?.price ?? null }, box: h1.box ? { state: h1.box.state, lo: h1.box.lo, hi: h1.box.hi, pos: h1.box.pos } : null,
      news: inp.news ? { effect: inp.news.effect, events: inp.news.events } : null, regime: reg.label, regimeScore: reg.score, price, atr1h: h1.atr, atr15: m15.atr, room,
    },
  };
  return out;
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
