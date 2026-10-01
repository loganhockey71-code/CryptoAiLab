// READ-ONLY Hyperliquid data (public info API + websocket). No exchange/signing endpoints are used anywhere.
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { log, warn } from './config.js';

const INFO = 'https://api.hyperliquid.xyz/info';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const LEADERBOARD = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawPost(body, attempt = 0) {
  const res = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (res.status === 429 && attempt < 4) { await sleep(3000 * (attempt + 1)); return rawPost(body, attempt + 1); }
  if (!res.ok) throw new Error(`hyperliquid ${body.type} -> ${res.status}`);
  return res.json();
}
// Live (latency-sensitive) calls go straight through; bulk history calls are serialised and spaced
// so evaluating hundreds of traders never exhausts the per-minute rate budget the live calls need.
let bulkChain = Promise.resolve();
export function bulkPost(body) {
  const p = bulkChain.then(() => rawPost(body));
  bulkChain = p.then(() => sleep(1500), () => sleep(1500));
  return p;
}
export const livePost = rawPost;

export async function fetchLeaderboard() {
  const res = await fetch(LEADERBOARD, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`leaderboard -> ${res.status}`);
  return (await res.json()).leaderboardRows;
}

/** All fills since `sinceMs`, oldest first. The API serves at most 2000 per call and only the 10000 most recent overall. */
export async function fetchFills(address, sinceMs, { live = false, maxPages = 5 } = {}) {
  const post = live ? livePost : bulkPost;
  const out = [];
  let start = sinceMs;
  for (let i = 0; i < maxPages; i++) {
    const rows = await post({ type: 'userFillsByTime', user: address, startTime: start, aggregateByTime: false });
    out.push(...rows);
    if (rows.length < 2000) break;
    start = rows[rows.length - 1].time + 1;
  }
  return out;
}

export async function getState(address, { live = false } = {}) {
  const s = await (live ? livePost : bulkPost)({ type: 'clearinghouseState', user: address });
  return {
    accountValue: Number(s.marginSummary?.accountValue ?? 0),
    positions: (s.assetPositions ?? []).map((a) => a.position).map((p) => ({
      coin: p.coin, szi: Number(p.szi), entryPx: Number(p.entryPx), unrealizedPnl: Number(p.unrealizedPnl), positionValue: Number(p.positionValue),
    })),
  };
}

// Perpetual markets only. Spot ("@107", "PURR/USDC") and builder-deployed markets ("xyz:AAPL") are ignored.
export const isPerp = (coin) => !!coin && !coin.startsWith('@') && !coin.includes('/') && !coin.includes(':');

class Hyperliquid extends EventEmitter {
  constructor() {
    super();
    this.mids = new Map();
    this.midsAt = 0;
    this.ws = null;
    this.users = new Set();
    this.retry = 0;
    this.opened = 0;
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  mid(coin) { return this.mids.get(coin) ?? null; }
  midAgeMs() { return this.midsAt ? Date.now() - this.midsAt : Infinity; }

  start() {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0; this.opened++;
      log('Hyperliquid WS connected');
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      for (const u of this.users) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'userFills', user: u } }));
      clearInterval(this.pinger);
      this.pinger = setInterval(() => { try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* closing */ } }, 30_000);
      this.emit('open', this.opened > 1);
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.channel === 'allMids') {
        for (const [coin, px] of Object.entries(m.data.mids)) this.mids.set(coin, Number(px));
        this.midsAt = Date.now();
        this.emit('mids');
      } else if (m.channel === 'userFills') {
        const user = String(m.data.user).toLowerCase();
        for (const fill of m.data.fills) this.emit('fill', { address: user, fill, snapshot: !!m.data.isSnapshot });
      } else if (m.channel === 'error') warn('Hyperliquid WS error:', JSON.stringify(m.data).slice(0, 200));
    });
    const reconnect = () => {
      if (this.ws !== ws) return;
      this.ws = null; clearInterval(this.pinger);
      const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
      warn(`Hyperliquid WS closed, reconnecting in ${wait}ms`);
      setTimeout(() => this.start(), wait);
    };
    ws.on('close', reconnect);
    ws.on('error', (e) => { warn('Hyperliquid WS:', e.message); try { ws.terminate(); } catch { /* ignore */ } });
  }

  /** Subscribe to live fills for exactly these addresses (Hyperliquid allows 10 users per connection). */
  trackUsers(addresses) {
    const next = new Set([...addresses].map((a) => a.toLowerCase()).slice(0, 10));
    for (const u of next) if (!this.users.has(u) && this.connected) this.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'userFills', user: u } }));
    for (const u of this.users) if (!next.has(u) && this.connected) this.ws.send(JSON.stringify({ method: 'unsubscribe', subscription: { type: 'userFills', user: u } }));
    this.users = next;
  }

  async refreshMidsRest() {
    const mids = await livePost({ type: 'allMids' });
    for (const [coin, px] of Object.entries(mids)) this.mids.set(coin, Number(px));
    this.midsAt = Date.now();
  }
}

export const hl = new Hyperliquid();
