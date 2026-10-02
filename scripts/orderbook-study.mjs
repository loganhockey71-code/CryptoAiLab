// READ-ONLY study (no orders, no keys, not part of the trading app): can the Coinbase order book be a reliable fresh price for thinly traded coins?
// Streams the public ticker (trades) + level2_batch (book) feeds for ~40 thin-but-tradable USD markets and appends JSON lines to study-data/orderbook-study.jsonl:
//   trade  = every trade that arrives after a >= 30s quiet gap, with the book quote from just BEFORE it (so the trade's own fill cannot bias the comparison)
//   sample = once a minute per coin: last-trade age, last price, bid/ask, spread, depth within 0.5% / 1%, quote age
//   hold   = 10s after any sample whose last trade was >= 30s old: did the quote stay put (flicker / stub-order check)?
// Usage: node scripts/orderbook-study.mjs [--hours 24] [--coins 40]     Analyse with: node scripts/orderbook-study-report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const HOURS = Number(opt('--hours', 24)), NCOINS = Number(opt('--coins', 40));
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'study-data');
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, 'orderbook-study.jsonl');
const emit = (o) => fs.appendFileSync(OUT, JSON.stringify(o) + '\n');
const REST = 'https://api.exchange.coinbase.com', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { for (let i = 0; i < 4; i++) { const r = await fetch(REST + p, { headers: { 'User-Agent': 'crypto-ai-lab-study/1.0' } }); if (r.ok) return r.json(); if (r.status !== 429) throw new Error(`${p} -> ${r.status}`); await sleep(1500 * (i + 1)); } throw new Error(`${p} rate limited`); };

// ---- pick the coins: tradable USD markets with 1M-30M USD 24h volume (the ones that actually go "stale"), spread evenly across that range
async function pickCoins() {
  const prods = (await get('/products')).filter((p) => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled && !/^(USDT|USDC|DAI|PYUSD|EURC|GUSD|PAXG|XAUT|WBTC|CBETH|LSETH|WSTETH)$/.test(p.base_currency));
  const scored = [];
  for (const p of prods) { try { const s = await get(`/products/${p.id}/stats`); scored.push({ id: p.id, usd: Number(s.volume) * Number(s.last) }); } catch {} await sleep(170); }
  const pool = scored.filter((x) => x.usd >= 1e6 && x.usd <= 3e7).sort((a, b) => a.usd - b.usd);
  const step = Math.max(1, pool.length / NCOINS);
  return Array.from({ length: Math.min(NCOINS, pool.length) }, (_, i) => pool[Math.floor(i * step)]);
}

const coins = await pickCoins();
const ids = coins.map((c) => c.id);
console.log(new Date().toISOString(), `studying ${ids.length} coins for ${HOURS}h -> ${OUT}`);
emit({ k: 'start', at: Date.now(), hours: HOURS, coins });

// ---- live state
const S = {};     // product -> { bids, asks (Map price->size), bestBid, bestAsk, hist: [{t,bid,ask}], lastTrade:{t,px}|null, quoteAt, depthAt, depth, trades }
let lastMsg = Date.now();
let ws, retry = 0;
const stats = { msgs: 0, reconnects: 0, trades: 0, gapTrades: 0, samples: 0 };
const bestOf = (m, side) => { let b = null; for (const p of m.keys()) if (b === null || (side === 'bid' ? p > b : p < b)) b = p; return b; };
const depthOf = (s) => {                                    // resting USD within 0.5% / 1% of mid, cached for 1s (cheap enough to call per sample / trade)
  if (Date.now() - (s.depthAt ?? 0) < 1000 && s.depth) return s.depth;
  const mid = (s.bestBid + s.bestAsk) / 2, d = { b05: 0, a05: 0, b1: 0, a1: 0 };
  for (const [p, z] of s.bids) { const x = 1 - p / mid; if (x <= 0.01) { d.b1 += p * z; if (x <= 0.005) d.b05 += p * z; } }
  for (const [p, z] of s.asks) { const x = p / mid - 1; if (x <= 0.01) { d.a1 += p * z; if (x <= 0.005) d.a05 += p * z; } }
  s.depthAt = Date.now(); s.depth = { b05: Math.round(d.b05), a05: Math.round(d.a05), b1: Math.round(d.b1), a1: Math.round(d.a1) }; return s.depth;
};
const quoteBefore = (s, t) => { for (let i = s.hist.length - 1; i >= 0; i--) if (s.hist[i].t < t) return s.hist[i]; return null; };   // last book quote strictly before time t

function onMessage(raw) {
  stats.msgs++;
  let m; try { m = JSON.parse(raw); } catch { return; }
  const p = m.product_id;
  if (m.type === 'snapshot') {
    const s = S[p] ??= { lastTrade: null, hist: [], trades: 0 };
    s.bids = new Map(m.bids.map(([a, b]) => [+a, +b])); s.asks = new Map(m.asks.map(([a, b]) => [+a, +b]));
    s.bestBid = bestOf(s.bids, 'bid'); s.bestAsk = bestOf(s.asks, 'ask'); s.quoteAt = Date.now(); s.hist = [];
  } else if (m.type === 'l2update' && S[p]?.bids) {
    const s = S[p]; let touched = false;
    for (const [side, px, sz] of m.changes) {
      const mp = side === 'buy' ? s.bids : s.asks, x = +px;
      if (+sz === 0) mp.delete(x); else mp.set(x, +sz);
      if (side === 'buy' ? x >= s.bestBid : x <= s.bestAsk) touched = true;
    }
    if (touched) {
      const bid = bestOf(s.bids, 'bid'), ask = bestOf(s.asks, 'ask');
      if (bid !== s.bestBid || ask !== s.bestAsk) { s.bestBid = bid; s.bestAsk = ask; s.quoteAt = Date.now(); s.hist.push({ t: Date.parse(m.time), bid, ask }); if (s.hist.length > 400) s.hist.shift(); }
    }
  } else if (m.type === 'ticker' && S[p]?.bids) {
    const s = S[p], t = Date.parse(m.time), px = +m.price;
    if (!s.lastTrade) { s.lastTrade = { t, px, snapshot: true }; return; }     // first message after (re)subscribe = the last trade before we started: gives the stale gap
    if (s.lastTrade.t === t && s.lastTrade.px === px) return;
    stats.trades++; s.trades++;
    const gapS = (t - s.lastTrade.t) / 1000;
    if (gapS >= 30) {
      stats.gapTrades++;
      const q = quoteBefore(s, t) ?? { bid: s.bestBid, ask: s.bestAsk, t: null };
      emit({ k: 'trade', at: Date.now(), feedLagS: +((Date.now() - lastMsg) / 1000).toFixed(1), p, t, gapS: +gapS.toFixed(1), px, prevPx: s.lastTrade.px, side: m.side, size: +m.last_size, bid: q.bid, ask: q.ask, quoteT: q.t, tickerBid: +m.best_bid, tickerAsk: +m.best_ask, depth: depthOf(s) });
    }
    s.lastTrade = { t, px };
  }
}

// ---- once-a-minute samples (+ 10s hold check when the last trade is stale)
setInterval(() => {
  const now = Date.now();
  for (const p of ids) {
    const s = S[p]; if (!s?.bids || !s.bestBid || !s.bestAsk) continue;
    const mid = (s.bestBid + s.bestAsk) / 2, ageS = s.lastTrade ? (now - s.lastTrade.t) / 1000 : null;
    stats.samples++;
    emit({ k: 'sample', at: now, p, tradeAgeS: ageS == null ? null : +ageS.toFixed(0), lastPx: s.lastTrade?.px ?? null, bid: s.bestBid, ask: s.bestAsk, spreadPct: +((s.bestAsk - s.bestBid) / mid * 100).toFixed(4), unchangedS: +((now - s.quoteAt) / 1000).toFixed(1), feedLagS: +((now - lastMsg) / 1000).toFixed(1), depth: depthOf(s), levels: [s.bids.size, s.asks.size] });
    if (ageS != null && ageS >= 30) setTimeout(() => { const x = S[p]; if (x?.bestBid) emit({ k: 'hold', at: Date.now(), p, base: { bid: s.bestBid, ask: s.bestAsk }, bid: x.bestBid, ask: x.bestAsk, afterS: 10 }); }, 10_000);
  }
}, 60_000);

setInterval(() => { emit({ k: 'status', at: Date.now(), ...stats }); console.log(new Date().toISOString(), JSON.stringify(stats)); }, 10 * 60_000);

// ---- connection with reconnect
function connect() {
  ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  ws.on('open', () => { retry = 0; for (const p of ids) if (S[p]) S[p].lastTrade = null; ws.send(JSON.stringify({ type: 'subscribe', product_ids: ids, channels: ['ticker', 'level2_batch', 'heartbeat'] })); });
  ws.on('message', (raw) => { lastMsg = Date.now(); onMessage(raw); });
  const again = () => { if (ws.__done) return; ws.__done = true; stats.reconnects++; emit({ k: 'reconnect', at: Date.now() }); setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++)); };
  ws.on('close', again); ws.on('error', () => { try { ws.terminate(); } catch {} });
}
connect();
setInterval(() => { if (Date.now() - lastMsg > 30_000) { try { ws.terminate(); } catch {} } }, 10_000);   // silent socket: force a reconnect

await sleep(HOURS * 3600_000);
emit({ k: 'end', at: Date.now(), ...stats });
console.log('study finished', JSON.stringify(stats));
process.exit(0);
