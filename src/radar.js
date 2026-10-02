// Market radar: cheap, pure scoring used to decide WHICH coins deserve expensive work (candles, then AI research). No I/O here.
// A high priority only means "look at this coin sooner". It never lowers a requirement: confluence, candle confirmation, BTC regime,
// sizing, stops, R:R and the circuit breakers still apply in full before any paper trade.
import { config } from './config.js';

const Z = config.radar, U = config.universe;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Rejects coins that must never be entered: illiquid, tiny, wash-trading-looking, thin-volume spikes, or missing data.
 * `c` is a tradable-coin record (price, mcap, vol24, chg1h, chg24h). Returns null when acceptable.
 */
export function rejectReason(c) {
  if (!c || !(c.price > 0)) return { code: 'insufficient_data', text: 'insufficient data: no usable price' };
  if (c.vol24 == null || c.mcap == null) return { code: 'insufficient_data', text: 'insufficient data: volume or market cap unknown' };
  if (c.vol24 < U.minVolume24hUsd) return { code: 'illiquid', text: `illiquid: 24h volume $${Math.round(c.vol24).toLocaleString('en-US')} < $${U.minVolume24hUsd.toLocaleString('en-US')}` };
  if (c.mcap > 0 && c.mcap < Z.minMcapUsd) return { code: 'tiny_cap', text: `market cap $${Math.round(c.mcap).toLocaleString('en-US')} < $${Z.minMcapUsd.toLocaleString('en-US')}: too easy to manipulate` };
  const ratio = c.mcap > 0 ? c.vol24 / c.mcap : 0;
  if (ratio > Z.maxVolMcap && c.mcap < Z.washCapCeiling) return { code: 'wash_trading', text: `24h volume is ${ratio.toFixed(1)}x market cap: possible wash trading` };
  if (Math.abs(c.chg1h ?? 0) >= Z.thinSpikePct && c.vol24 < Z.thinSpikeVol) return { code: 'thin_spike', text: `${((c.chg1h ?? 0) * 100).toFixed(0)}% 1h move on only $${Math.round(c.vol24).toLocaleString('en-US')} volume: looks manipulated` };
  return null;
}

/** Cheap priority 0-100 for the research queue, with human-readable reasons. */
export function radarPriority(c, x = {}) {
  const reasons = [];
  let s = 0;
  const add = (pts, why) => { if (pts > 0.5) { s += pts; if (why) reasons.push(why); } };
  const up1 = Math.max(0, c.chg1h ?? 0), up24 = Math.max(0, c.chg24h ?? 0);
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
