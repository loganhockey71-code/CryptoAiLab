// Pure indicator math. Candles are { t (unix s), o, h, l, c, v } ordered oldest -> newest.

export function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
const last = (a) => (a.length ? a[a.length - 1] : null);

export function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

export function macdHist(closes) {
  const fast = ema(closes, 12), slow = ema(closes, 26);
  if (!slow.length) return null;
  const offset = fast.length - slow.length;
  const macd = slow.map((s, i) => fast[i + offset] - s);
  const signal = ema(macd, 9);
  if (!signal.length) return null;
  return { hist: last(macd) - last(signal), prevHist: macd.length > signal.length ? macd[macd.length - 2] - signal[signal.length - 2] : null };
}

export function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const { h, l } = candles[i], pc = candles[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

// Relative volume: last COMPLETED candle's volume vs the average of the prior `lookback` candles.
export function rvol(candles, lookback = 20) {
  if (candles.length < lookback + 2) return null;
  const done = candles.slice(0, -1); // drop the still-forming candle
  const cur = done[done.length - 1].v;
  const prior = done.slice(-lookback - 1, -1);
  const avg = prior.reduce((a, c) => a + c.v, 0) / prior.length;
  return avg > 0 ? cur / avg : null;
}

// Per-timeframe trend/momentum snapshot.
export function snapshot(candles) {
  if (!candles || candles.length < 55) return null;
  const closes = candles.map((c) => c.c);
  const e20 = last(ema(closes, 20)), e50 = last(ema(closes, 50));
  const m = macdHist(closes);
  const r = rsi(closes);
  const price = last(closes);
  return {
    price, ema20: e20, ema50: e50, rsi: r,
    macdHist: m?.hist ?? null,
    macdRising: m && m.prevHist != null ? m.hist > m.prevHist : null,
    trendUp: e20 > e50 && price > e50,
    aboveEma20: price > e20,
  };
}

// Aggregate candles into larger buckets (e.g. 1h -> 4h). Buckets aligned to epoch.
export function aggregate(candles, bucketSec) {
  const out = [];
  for (const c of candles) {
    const b = Math.floor(c.t / bucketSec) * bucketSec;
    const cur = out[out.length - 1];
    if (cur && cur.t === b) {
      cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v;
    } else out.push({ t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  }
  return out;
}

// Short human-readable description of the latest candle(s), stored with trades for post-mortems.
export function candlePattern(candles) {
  if (!candles || candles.length < 3) return 'insufficient data';
  const [a, b, c] = candles.slice(-3);
  const body = (x) => Math.abs(x.c - x.o), range = (x) => Math.max(x.h - x.l, 1e-12);
  const up = (x) => x.c > x.o;
  const parts = [];
  if (up(a) && up(b) && up(c)) parts.push('three consecutive green candles');
  else if (!up(a) && !up(b) && !up(c)) parts.push('three consecutive red candles');
  if (body(c) / range(c) > 0.7) parts.push(up(c) ? 'strong bullish body' : 'strong bearish body');
  const lower = Math.min(c.o, c.c) - c.l, upper = c.h - Math.max(c.o, c.c);
  if (lower > 2 * body(c) && lower > upper) parts.push('long lower wick (rejection of lows)');
  if (upper > 2 * body(c) && upper > lower) parts.push('long upper wick (rejection of highs)');
  return parts.length ? parts.join('; ') : (up(c) ? 'mild green candle' : 'mild red candle');
}
