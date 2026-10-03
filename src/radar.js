// Market radar: cheap, pure scoring used to decide WHICH coins deserve expensive work (candles, then AI research). No I/O here.
// A high priority only means "look at this coin sooner". It never lowers a requirement: confluence, candle confirmation, BTC regime,
// sizing, stops, R:R and the circuit breakers still apply in full before any paper trade.
import { config } from './config.js';

const Z = config.radar, U = config.universe;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Rejects only coins that cannot be traded: no usable price/volume, genuinely illiquid (< $1M 24h volume) or tiny (< $5M cap). Wash-trading ratios and thin-volume spikes are WARNINGS (screenWarnings).
 * `c` is a tradable-coin record (price, mcap, vol24, chg1h, chg24h). Returns null when acceptable.
 */
export function rejectReason(c) {
  if (!c || !(c.price > 0)) return { code: 'insufficient_data', text: 'insufficient data: no usable price' };
  if (c.vol24 == null) return { code: 'insufficient_data', text: 'insufficient data: 24h volume unknown' };
  if (c.mcap == null && c.vol24 < 5_000_000) return { code: 'insufficient_data', text: 'market cap unknown and 24h volume under $5M: not enough liquidity data to compensate' };   // a missing market cap is fine when the volume is clearly sufficient
  if (c.vol24 < U.minVolume24hUsd) return { code: 'illiquid', text: `illiquid: 24h volume $${Math.round(c.vol24).toLocaleString('en-US')} < $${U.minVolume24hUsd.toLocaleString('en-US')}` };
  if (c.mcap > 0 && c.mcap < Z.minMcapUsd) return { code: 'tiny_cap', text: `market cap $${Math.round(c.mcap).toLocaleString('en-US')} < $${Z.minMcapUsd.toLocaleString('en-US')}: too easy to manipulate` };
  return null;
}

/**
 * Conditions that deserve a second look but do NOT reject a coin (they cost it score, and the order-book / structure checks decide the rest):
 * extreme volume vs market cap (possible wash trading), a 20%+ hour on thin volume, a missing market cap.
 */
export function screenWarnings(c) {
  const w = [];
  if (!c) return w;
  const ratio = c.mcap > 0 ? c.vol24 / c.mcap : 0;
  if (ratio > Z.maxVolMcap && c.mcap < Z.washCapCeiling) w.push(`24h volume is ${ratio.toFixed(1)}x market cap: possible wash trading (flagged for review, not rejected)`);
  if (Math.abs(c.chg1h ?? 0) >= Z.thinSpikePct && (c.vol24 ?? 0) < Z.thinSpikeVol) w.push(`${((c.chg1h ?? 0) * 100).toFixed(0)}% 1h move on only ${Math.round(c.vol24).toLocaleString('en-US')} volume: major warning (liquidity and structure decide)`);
  if (c.mcap == null) w.push('market cap unknown (liquidity data is sufficient, so the coin is still considered)');
  return w;
}

/** Cheap priority 0-100 for the research queue, with human-readable reasons. */
export function radarPriority(c, x = {}) {
  const reasons = [];
  let s = 0;
  const add = (pts, why) => { if (pts > 0.5) { s += pts; if (why) reasons.push(why); } };
  const up1 = Math.max(0, c.chg1h ?? 0), up24 = Math.max(0, c.chg24h ?? 0);
  // Relative strength vs the market, BTC and ETH: the goal is coins that are STARTING strong, not the ones already up the most.
  const m = x.mkt;
  if (m) {
    const rs1 = (c.chg1h ?? 0) - m.chg1h, rs24 = (c.chg24h ?? 0) - m.chg24h, vsBtc1 = (c.chg1h ?? 0) - (m.btc1h ?? m.chg1h), vsEth1 = (c.chg1h ?? 0) - (m.eth1h ?? m.chg1h);
    add(clamp01(rs1 / 0.03) * 12, rs1 >= 0.01 ? `+${(rs1 * 100).toFixed(1)}% stronger than the market this hour` : null);
    add(clamp01(Math.min(vsBtc1, vsEth1) / 0.02) * 6, Math.min(vsBtc1, vsEth1) >= 0.01 ? 'beating both BTC and ETH' : null);
    if (rs1 > 0.005 && (c.chg24h ?? 0) < 0.12) add(6, 'starting strong, not extended');
    s -= clamp01(((c.chg24h ?? 0) - 0.2) / 0.3) * 15;                              // already up 20%+ today: late, deprioritised (it can return after a retest)
    if (rs1 < -0.01 && rs24 < -0.02) add(clamp01(-rs1 / 0.03) * 6, 'weak vs the market (short candidate)');
  }
  add(clamp01(up1 / 0.05) * 20, up1 >= 0.02 ? `1h +${(up1 * 100).toFixed(1)}%` : null);
  add(clamp01(up24 / 0.15) * 10, up24 >= 0.05 ? `24h +${(up24 * 100).toFixed(1)}%` : null);
  // Volume anomaly: candle-based RVOL when we have it, otherwise how much the 24h volume grew since the last sweep.
  const jump = c.prev?.vol24 > 0 ? c.vol24 / c.prev.vol24 - 1 : 0;
  const rvolPts = x.rvol != null ? clamp01((x.rvol - 1) / 2) * 15 : 0, jumpPts = clamp01(jump / 0.3) * 10;
  const vp = Math.max(rvolPts, jumpPts);
  add(vp, vp >= 5 ? (rvolPts >= jumpPts ? `volume ${x.rvol.toFixed(1)}x normal` : `24h volume +${(jump * 100).toFixed(0)}% since last sweep`) : null);
  const ratio = c.mcap > 0 ? c.vol24 / c.mcap : 0;
  add(ratio >= 0.05 && ratio <= Z.maxVolMcap ? 5 : 0, null);
  add(clamp01(Math.log10(Math.max(c.vol24 ?? 1, 1) / 1e6) / 2) * 10, null);          // liquidity: $1M -> 0 pts, $100M -> 10 pts
  if (x.smartMoney && x.smartMoney.net > 0) add(2, `${x.smartMoney.longs} tracked trader(s) long`);   // a small data point only: other traders never drive what gets looked at or traded
  if (x.sentiment && x.sentiment.count >= 1 && x.sentiment.score > 0.3) add(10, 'positive headline');
  if (x.partial != null) add((x.partial / 50) * 15, null);
  if ((x.partialDelta ?? 0) >= 4) add(5, 'setup quality improving');
  if (x.brainCls === 'HOT') add(20, 'strong setup (brain)');
  else if (x.brainCls === 'WATCH') add(10, 'setup forming (brain)');
  else if (x.brainCls === 'AVOID') s = Math.max(0, s - 15);                  // downtrend / sellers in control: low priority, but never zero (a reversal must still be noticed)
  return { score: Math.min(100, s), reasons };
}
