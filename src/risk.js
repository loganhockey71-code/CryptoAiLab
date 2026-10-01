// Deterministic risk layer. Pure functions only: no I/O, no LLM, and nothing here is ever modified by self-learning.
import { config } from './config.js';

const R = config.risk;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const TF_WEIGHTS = { '1d': 0.15, '4h': 0.20, '1h': 0.25, '15m': 0.20, '5m': 0.20 };
export const ROUND_TRIP_COST_PCT = 2 * (R.feePct + R.slippagePct);

/** BTC/USD 1h regime from the 20/50 EMA snapshot. */
export function btcRegime(snap1h) {
  if (!snap1h) return { regime: 'unknown', bullish: false };
  const bullish = snap1h.ema20 > snap1h.ema50 && snap1h.price > snap1h.ema50;
  return { regime: bullish ? 'bullish' : 'bearish', bullish, ema20: snap1h.ema20, ema50: snap1h.ema50, price: snap1h.price };
}

function tfPoints(s) {
  if (!s) return 0;
  let p = 0;
  if (s.trendUp) p += 0.4;
  if (s.rsi != null) p += s.rsi >= 50 && s.rsi <= 75 ? 0.2 : s.rsi > 75 && s.rsi <= 85 ? 0.1 : 0;
  if (s.macdHist != null && s.macdHist > 0) p += 0.2;
  if (s.macdRising) p += 0.1;
  if (s.aboveEma20) p += 0.1;
  return p;
}

export function technicalScore(snaps) {
  let total = 0;
  const missing = [];
  for (const [tf, w] of Object.entries(TF_WEIGHTS)) {
    if (!snaps[tf]) missing.push(tf);
    total += w * tfPoints(snaps[tf]);
  }
  return { score: 25 * total, missing };
}

export function rvolScore(rvol) {
  if (rvol == null) return { score: 0, note: 'RVOL unavailable' };
  // Reaching the RVOL > 1.5 threshold is required for the bulk of the credit.
  if (rvol > 1.5) return { score: 15 + Math.min(10, ((rvol - 1.5) / 1.5) * 10), note: `RVOL ${rvol.toFixed(2)} > 1.5` };
  return { score: Math.max(0, (rvol / 1.5) * 12), note: `RVOL ${rvol.toFixed(2)} <= 1.5` };
}

export function derivativesScore(d, priceUp) {
  if (!d?.ok) return { score: 0, note: `derivatives unavailable (${d?.error ?? 'no data'})`, available: false };
  const { fundingRatePct: f, oiChange1hPct: oi } = d.data;
  let s = 10, notes = [];
  if (f == null) { notes.push('funding n/a'); }
  else if (f > 0.05) { notes.push(`funding ${f.toFixed(4)}% crowded long`); }
  else if (f > 0.03) { s += 3; notes.push(`funding ${f.toFixed(4)}% elevated`); }
  else { s += 7; notes.push(`funding ${f.toFixed(4)}% benign`); }
  if (oi == null) { s += 2; notes.push('OI change n/a'); }
  else if (oi > 0 && priceUp) { s += 8; notes.push(`OI +${oi.toFixed(2)}% with rising price`); }
  else if (oi <= -2) { notes.push(`OI ${oi.toFixed(2)}% deleveraging`); }
  else { s += 4; notes.push(`OI ${oi.toFixed(2)}%`); }
  return { score: clamp(s, 0, 25), note: notes.join('; '), available: true };
}

export function researchScore(sig) {
  if (!sig || sig.direction !== 'bullish') return { score: 0, note: sig ? `research bias ${sig.direction}` : 'no research signal' };
  const independence = Math.min(1, sig.supporting.length / 3);   // needs ~3 independent supporting source classes for full credit
  const conflictPenalty = Math.pow(0.7, sig.conflicting.length);
  return {
    score: 25 * (sig.confidence / 100) * independence * conflictPenalty,
    note: `confidence ${sig.confidence}% x independence ${independence.toFixed(2)} x conflict ${conflictPenalty.toFixed(2)}`,
  };
}

/** Tracked smart-money traders (win rate >= 75%) currently positioned in this coin. Shorts by trusted traders count against a long. */
export function smartMoneyBonus(sm) {
  if (!sm || !(sm.longs + sm.shorts)) return { bonus: 0, note: 'no tracked trader holds this coin' };
  if (sm.net < 0) return { bonus: -10, note: `tracked traders net SHORT (${sm.shorts} short vs ${sm.longs} long)` };
  if (sm.longs >= 2 || sm.preferredLongs >= 1) return { bonus: 8, note: `${sm.longs} tracked trader(s) long${sm.preferredLongs ? ` (${sm.preferredLongs} at >=80% win rate)` : ''}` };
  if (sm.longs >= 1) return { bonus: 4, note: '1 tracked trader long' };
  return { bonus: 0, note: 'tracked traders flat/mixed' };
}

export function confluence({ snaps, rvol, signal, derivatives, priceUp, smartMoney }) {
  const t = technicalScore(snaps), v = rvolScore(rvol), r = researchScore(signal), d = derivativesScore(derivatives, priceUp);
  const sm = smartMoneyBonus(smartMoney);
  const smartTotal = clamp(d.score + sm.bonus, 0, 25);    // 4th component = smart money: derivatives positioning + tracked-trader alignment
  const total = t.score + v.score + r.score + smartTotal;
  return {
    total: Math.round(total * 10) / 10,
    technical: Math.round(t.score * 10) / 10, rvol: Math.round(v.score * 10) / 10,
    research: Math.round(r.score * 10) / 10, derivatives: Math.round(smartTotal * 10) / 10,
    notes: { technical: t.missing.length ? `missing timeframes: ${t.missing.join(',')}` : 'all timeframes present', rvol: v.note, research: r.note, derivatives: `${d.note}; ${sm.note}` },
  };
}

/**
 * Every requirement must pass INDEPENDENTLY (not just the sum): technical, volume, smart money, research.
 * (Candle confirmation, the 80/100 total and every risk filter are enforced separately.) Returns { fails: [...] }.
 */
export function requirements(c, smartMoney) {
  const F = R.minComponent, fails = [];
  if (c.technical < F) fails.push(`technical ${c.technical}/25 < ${F}`);
  if (c.rvol < F) fails.push(`volume (RVOL) ${c.rvol}/25 < ${F}`);
  if (c.derivatives < F) fails.push(`smart money ${c.derivatives}/25 < ${F}`);
  if (smartMoney && smartMoney.net < 0) fails.push('tracked smart-money traders are net short');
  if (c.research < F) fails.push(`research ${c.research}/25 < ${F}`);
  return { fails, floor: F };
}

/** Normalise stop into the mandatory 2.5-4% band, then compute net R:R after fees + slippage. */
export function shapeTrade(entry, llmStop, llmTarget) {
  const rawDist = llmStop != null && llmStop < entry ? (entry - llmStop) / entry : R.stopMaxPct;
  const stopDist = clamp(rawDist, R.stopMinPct, R.stopMaxPct);
  const stop = entry * (1 - stopDist);
  const target = llmTarget;
  const reward = target - entry - ROUND_TRIP_COST_PCT * entry;
  const risk = entry - stop + ROUND_TRIP_COST_PCT * entry;
  return { stop, target, stopDist, rr: reward > 0 ? reward / risk : 0, grossRr: (target - entry) / (entry - stop) };
}

export function positionSize({ equity, cash, score }) {
  const pct = R.minPositionPct + (R.maxPositionPct - R.minPositionPct) * clamp((score - R.minConfluence) / (100 - R.minConfluence), 0, 1);
  let notional = equity * pct;
  if (notional * (1 + R.feePct) > cash) notional = cash / (1 + R.feePct);
  return { pct, notional };
}

/** Is trading globally allowed right now? (circuit breakers) */
export function tradingGate(p, now = Date.now()) {
  if (p.manual_review_required) return { allowed: false, reason: `${R.maxConsecutiveLossDays} consecutive -5% days: trading suspended until manual re-evaluation` };
  if (p.halted_for_day) return { allowed: false, reason: 'daily -5% loss cap hit: frozen until next UTC day' };
  const fu = p.freeze_until ? new Date(p.freeze_until).getTime() : 0;
  if (fu > now) return { allowed: false, reason: `${p.freeze_reason || 'freeze'} (until ${new Date(fu).toISOString()})` };
  return { allowed: true };
}

/** All hard filters for a confirmed candidate. Returns every failing reason (for the decision log). */
export function entryFilters({ signal, entry, shaped, score, btc, portfolio, openCount, cooldownUntil, dataFresh, now = Date.now() }) {
  const reasons = [];
  const gate = tradingGate(portfolio, now);
  if (!gate.allowed) reasons.push(`circuit breaker: ${gate.reason}`);
  if (!dataFresh) reasons.push('price data not verified fresh (<=10s)');
  if (!btc.bullish) reasons.push(`BTC 1h regime ${btc.regime}: long entries suspended`);
  if (signal.direction !== 'bullish') reasons.push(`research direction is ${signal.direction}`);
  if (score < R.minConfluence) reasons.push(`confluence ${score.toFixed(1)} < ${R.minConfluence}`);
  if (!(shaped.target > entry)) reasons.push('target is not above entry');
  else if (shaped.rr < R.minRR) reasons.push(`net R:R ${shaped.rr.toFixed(2)} < ${R.minRR}`);
  if (openCount >= R.maxOpenPositions) reasons.push(`already ${openCount} open positions (max ${R.maxOpenPositions})`);
  if (cooldownUntil && cooldownUntil > now) reasons.push(`asset cooldown after stop-loss until ${new Date(cooldownUntil).toISOString()}`);
  return reasons;
}

/** Costs for one execution side (entry or exit). */
export const entryFill = (px) => px * (1 + R.slippagePct);
export const exitFill = (px) => px * (1 - R.slippagePct);
export const feeOn = (notional) => notional * R.feePct;
