// READ-ONLY market data from Coinbase Exchange's public endpoints (no credentials, no order endpoints).
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { log, warn } from './config.js';

const REST = 'https://api.exchange.coinbase.com';
const WS_URL = 'wss://ws-feed.exchange.coinbase.com';

// Simple serial throttle: ~6 requests/second to stay under the public rate limit.
let chain = Promise.resolve();
function throttled(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => new Promise((r) => setTimeout(r, 160)), () => new Promise((r) => setTimeout(r, 160)));
  return p;
}

async function get(path, attempt = 0) {
  return throttled(async () => {
    const res = await fetch(REST + path, { headers: { 'User-Agent': 'crypto-ai-lab/1.0' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return get(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`coinbase ${path} -> ${res.status}`);
    return res.json();
  });
}

export async function loadProducts() {
  const list = await get('/products');
  return new Set(list.filter((p) => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled).map((p) => p.id));
}

// Coinbase candle rows: [time, low, high, open, close, volume], newest first.
export async function fetchCandles(product, granularity) {
  const rows = await get(`/products/${product}/candles?granularity=${granularity}`);
  return rows.map(([t, l, h, o, c, v]) => ({ t, o, h, l, c, v })).sort((a, b) => a.t - b.t);
}

export async function fetchTicker(product) {
  const t = await get(`/products/${product}/ticker`);
  return { price: Number(t.price), time: new Date(t.time).getTime() };
}

class Feed extends EventEmitter {
  constructor() {
    super();
    this.live = new Map();      // product -> { price, tickTime, candle, closed: [] }
    this.products = new Set();
    this.lastMessageAt = 0;
    this.ws = null;
    this.retry = 0;
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  feedAgeMs() { return this.lastMessageAt ? Date.now() - this.lastMessageAt : Infinity; }

  setProducts(ids) {
    const next = new Set(ids);
    const added = [...next].filter((p) => !this.products.has(p));
    const removed = [...this.products].filter((p) => !next.has(p));
    this.products = next;
    if (this.connected) {
      if (added.length) this.ws.send(JSON.stringify({ type: 'subscribe', product_ids: added, channels: ['ticker'] }));
      if (removed.length) this.ws.send(JSON.stringify({ type: 'unsubscribe', product_ids: removed, channels: ['ticker'] }));
    }
    for (const p of removed) this.live.delete(p);
  }

  start() {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      log('Coinbase WS connected');
      const ids = [...this.products];
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ids.length ? ids : ['BTC-USD'], channels: ['ticker', 'heartbeat'] }));
    });
    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'ticker' && m.price) this.onTick(m);
    });
    const reconnect = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
      warn(`Coinbase WS closed, reconnecting in ${wait}ms`);
      setTimeout(() => this.start(), wait);
    };
    ws.on('close', reconnect);
    ws.on('error', (e) => { warn('Coinbase WS error:', e.message); try { ws.terminate(); } catch {} });
  }

  onTick(m) {
    const product = m.product_id, price = Number(m.price), size = Number(m.last_size) || 0;
    const time = m.time ? new Date(m.time).getTime() : Date.now();
    let s = this.live.get(product);
    if (!s) { s = { price, tickTime: time, candle: null, closed: [] }; this.live.set(product, s); }
    s.price = price; s.tickTime = time;
    const bucket = Math.floor(time / 60_000) * 60;
    if (!s.candle || s.candle.t !== bucket) {
      if (s.candle && bucket > s.candle.t) {
        s.closed.push(s.candle);
        if (s.closed.length > 300) s.closed.shift();
        this.emit('candle', product, s.candle);
      }
      s.candle = { t: bucket, o: price, h: price, l: price, c: price, v: size };
    } else {
      s.candle.h = Math.max(s.candle.h, price); s.candle.l = Math.min(s.candle.l, price);
      s.candle.c = price; s.candle.v += size;
    }
    this.emit('tick', product, price, time);
  }

  // Seed the closed-candle buffer from REST so indicators work immediately.
  async backfill1m(product) {
    try {
      const rows = await fetchCandles(product, 60);
      let s = this.live.get(product);
      if (!s) { const l = rows[rows.length - 1]; s = { price: l.c, tickTime: l.t * 1000, candle: null, closed: [] }; this.live.set(product, s); }
      const cutoff = s.closed.length ? s.closed[0].t : (s.candle?.t ?? Infinity);
      s.closed = rows.filter((c) => c.t < cutoff).concat(s.closed).slice(-300);
    } catch (e) { warn('backfill1m', product, e.message); }
  }

  price(product) { return this.live.get(product)?.price ?? null; }
  tickAgeMs(product) { const s = this.live.get(product); return s ? Date.now() - s.tickTime : Infinity; }
  closed1m(product) { return this.live.get(product)?.closed ?? []; }
  forming1m(product) { return this.live.get(product)?.candle ?? null; }

  // Returns a price only if verified fresh (<= staleMs); tries a REST ticker before giving up.
  async freshPrice(product, staleMs) {
    if (this.tickAgeMs(product) <= staleMs) return { price: this.price(product), ageMs: this.tickAgeMs(product), via: 'ws' };
    try {
      const t = await fetchTicker(product);
      const age = Date.now() - t.time;
      if (age <= staleMs) return { price: t.price, ageMs: age, via: 'rest' };
      return { price: null, ageMs: age, via: 'rest', stale: true };
    } catch (e) {
      return { price: null, ageMs: Infinity, via: 'none', error: e.message };
    }
  }
}

export const feed = new Feed();
