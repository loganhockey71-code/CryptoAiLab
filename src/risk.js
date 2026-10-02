// Deterministic risk layer. Pure functions only: no I/O, no LLM, and nothing here is ever modified by self-learning.
import { config } from './config.js';

const R = config.risk;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const ROUND_TRIP_COST_PCT = 2 * (R.feePct + R.slippagePct);

/** BTC/USD 1h regime from the 20/50 EMA snapshot. */
export function btcRegime(snap1h) {
  if (!snap1h) return { regime: 'unknown', bullish: false };
  const bullish = snap1h.ema20 > snap1h.ema50 && snap1h.price > snap1h.ema50;
  return { regime: bullish ? 'bullish' : 'bearish', bullish, ema20: snap1h.ema20, ema50: snap1h.ema50, price: snap1h.price };
}

/** Stop band [min, max] for a coin: BTC 1.5-2%, ETH 2-2.5%, Top 20 2.5-3%, Top 21-50 3-4%, Top 51-100 and memes 4%. Never wider than the 4% hard cap. */
export function stopBand(symbol, rank) {
  const B = R.stopBands;
  const tier = R.memeSymbols.includes(symbol) ? 'meme' : symbol === 'BTC' ? 'btc' : symbol === 'ETH' ? 'eth' : rank <= 20 ? 'top20' : rank <= 50 ? 'mid' : 'small';
  return { tier, min: Math.min(B[tier][0], R.stopAbsMaxPct), max: Math.min(B[tier][1], R.stopAbsMaxPct), absMax: R.stopAbsMaxPct };
}

/** Normalise the stop into the coin's band (never wider than 4%), then compute net R:R after fees + slippage. */
export function shapeTrade(entry, llmStop, llmTarget, { symbol, rank } = {}) {
  const band = stopBand(symbol, rank);
  const rawDist = llmStop != null && llmStop < entry ? (entry - llmStop) / entry : band.max;
  const stopDist = clamp(rawDist, band.min, band.max);
  const stop = entry * (1 - stopDist);
  // The target is only the partial-profit level: cap it at the tier's top (memes: 50%) but never stretch a modest target upward to pass R:R.
  const tb = R.targetBands[band.tier];
  const tDist = llmTarget > entry ? (llmTarget - entry) / entry : 0;
  const target = entry * (1 + Math.min(tDist, band.tier === 'meme' ? R.memeTargetCap : tb[1]));
  const reward = target - entry - ROUND_TRIP_COST_PCT * entry;
  const risk = entry - stop + ROUND_TRIP_COST_PCT * entry;
  return { stop, target, stopDist, band, targetBand: tb, rr: reward > 0 ? reward / risk : 0, grossRr: (target - entry) / (entry - stop) };
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
