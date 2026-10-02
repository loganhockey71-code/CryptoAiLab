// Loss-side early exit: cut a LOSING long that is in a confirmed, continuing downtrend instead of waiting for the stop to be hit. Pure functions, no I/O.
// This only ever exits EARLIER than the stop (at a smaller loss), so it can never increase the risk taken: the 1% risk, the <= 4% stop, the guardrails and the
// circuit breakers are untouched. It is deterministic and local on purpose: the AI never controls execution.
import { config } from './config.js';
import { aggregate, ema, rsi } from './indicators.js';

const D = config.exits.downtrend;

/**
 * Should this losing position be closed now because the market keeps falling with no sign of recovering?
 * All of these must hold (and then hold again on `confirmChecks` consecutive 1m closes, tracked by the caller):
 *  - it is a long that is underwater by at least `minLossR` of its initial stop distance, but has not reached the stop (>= 1R: the stop itself handles that)
 *  - it has been open at least `minHoldMs` (an entry that dips right away is not a verdict)
 *  - 5m structure: `lowerBars` consecutive completed 5m bars each with a lower high AND a lower low, the last close below the 5m EMA21, 5m RSI < `rsiMax` and
 *    still falling, and the latest bar closed below the previous close (no bounce yet)
 *  - a swing hold (planned > 6h) additionally needs the 1h trend to be broken, in line with its "ignore 1-minute noise" rule
 * `closed1m` = completed 1m candles, oldest first ({ t (seconds), o, h, l, c, v }).
 */
export function downtrendSignal({ pos, price, closed1m, riskDist, swing, snap1h, now = Date.now() }) {
  const no = (why) => ({ fire: false, why });
  if (pos.side === 'short' || pos.venue) return no('not a spot long of ours');
  const lossR = (pos.entry - price) / riskDist;
  if (!(lossR >= D.minLossR)) return no(`loss ${lossR.toFixed(2)}R < ${D.minLossR}R`);
  if (lossR >= 1) return no('at the stop');
  if (now - pos.openedAt < D.minHoldMs) return no('held too briefly');
  if (closed1m.length < 130) return no('not enough 1m history');

  let m5 = aggregate(closed1m, 300);
  const lastT = closed1m[closed1m.length - 1].t;
  if (m5.length && m5[m5.length - 1].t + 300 > lastT + 60) m5 = m5.slice(0, -1);       // drop a still-forming 5m bucket
  if (m5.length < 25) return no('not enough 5m bars');

  const closes = m5.map((c) => c.c);
  const e21 = ema(closes, 21), r = rsi(closes), rPrev = rsi(closes.slice(0, -2));
  if (!e21.length || r == null || rPrev == null) return no('indicators unavailable');
  const bars = m5.slice(-(D.lowerBars + 1));
  for (let i = 1; i < bars.length; i++) if (!(bars[i].h < bars[i - 1].h && bars[i].l < bars[i - 1].l)) return no('no unbroken run of lower highs and lower lows');
  if (!(closes[closes.length - 1] < e21[e21.length - 1])) return no('5m close not below the 21 EMA');
  if (!(r < D.rsiMax)) return no(`5m RSI ${r.toFixed(0)} not below ${D.rsiMax}`);
  if (!(r <= rPrev)) return no('5m RSI is recovering');
  if (!(closes[closes.length - 1] < closes[closes.length - 2])) return no('latest 5m bar closed higher: a bounce');
  if (swing && snap1h && snap1h.trendUp) return no('swing hold and the 1h trend is still up');

  return {
    fire: true, lossR,
    detail: `down ${(lossR * 100).toFixed(0)}% of the way to the stop; ${D.lowerBars} straight 5m bars with lower highs and lower lows, below the 5m 21 EMA, RSI ${r.toFixed(0)} and falling${swing ? ', 1h trend broken' : ''}`,
  };
}
