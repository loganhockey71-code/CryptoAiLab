// Immutable risk verification layer. Every entry (own strategy AND copy trades) must pass through finalizeEntry(), and every stop change
// through keepStopTight(). Strategy code can propose stops and sizes but can never exceed what is computed here: the limits are deep-frozen
// copies taken at load, the exported object is frozen, and nothing here reads from or writes to self-learning state.
import { config } from './config.js';
import { tradingGate } from './risk.js';

const R = config.risk;
const HARD = Object.freeze({
  riskPerTradePct: R.riskPerTradePct,                 // max equity lost if the stop is hit, INCLUDING fees and slippage
  stopAbsMaxPct: R.stopAbsMaxPct,                     // widest stop allowed anywhere
  maxPositionPct: R.maxPositionPct,                   // global per-position cap
  costPct: 2 * (R.feePct + R.slippagePct),            // estimated round-trip swap fee + slippage, added to the stop distance when sizing
});

/** position_size_usd = (equity * risk%) / (stop% + estimated fees+slippage%), never above the global position cap. No minimum size exists. */
function riskSizeUsd(equity, stopPct) {
  const bySize = (equity * HARD.riskPerTradePct) / (stopPct + HARD.costPct);
  return Math.max(0, Math.min(bySize, HARD.maxPositionPct * equity));
}

/**
 * Final say on a new position. Returns the stop (tightened to the 4% cap if it was wider) and the notional (cut to the 1% risk size,
 * the global cap and available cash), or { ok: false } with every violation reason.
 */
function finalizeEntry({ side = 'long', equity, cash, entry, stop, wanted = Infinity, feePct = R.feePct }) {
  const reasons = [];
  const dir = side === 'short' ? -1 : 1;
  if (!(entry > 0) || !(equity > 0)) return { ok: false, reasons: ['invalid entry price or equity'] };
  let dist = dir * (entry - stop) / entry;
  if (!(dist > 0)) return { ok: false, reasons: ['stop is not on the protective side of entry'] };
  if (dist > HARD.stopAbsMaxPct) { dist = HARD.stopAbsMaxPct; stop = entry * (1 - dir * dist); reasons.push(`stop tightened to the ${HARD.stopAbsMaxPct * 100}% hard cap`); }
  let notional = Math.min(wanted, riskSizeUsd(equity, dist));
  if (notional * (1 + feePct) > cash) notional = cash / (1 + feePct);
  return { ok: notional > 0, notional, stop, stopPct: dist, riskUsd: notional * (dist + HARD.costPct), reasons };
}

/** A stop may only move toward price (tighter). Returns the stop to use. */
const keepStopTight = (side, oldStop, newStop) => (oldStop == null ? newStop : side === 'short' ? Math.min(oldStop, newStop) : Math.max(oldStop, newStop));

/** Largest total notional a position with this stop may hold (used when a copied leader adds to a position). */
const maxNotionalFor = (equity, stopPct) => riskSizeUsd(equity, stopPct);

export const guard = Object.freeze({ HARD, finalizeEntry, keepStopTight, maxNotionalFor, tradingGate });
