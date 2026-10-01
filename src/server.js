import express from 'express';
import path from 'node:path';
import { config, log, warn } from './config.js';
import { db } from './db.js';
import { feed } from './exchange.js';
import { universe } from './universe.js';
import * as engine from './engine.js';
import * as copy from './copy.js';
import { hl, livePost } from './hyperliquid.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.static(path.join(config.root, 'public')));
app.get('/vendor/lightweight-charts.js', (req, res) =>
  res.sendFile(path.join(config.root, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js')));

const fullSnapshot = () => ({ ...engine.snapshotForUi(), copy: copy.snapshot() });
app.get('/api/state', (req, res) => (engine.isReady() ? res.json(fullSnapshot()) : res.status(503).json({ error: 'starting' })));

// Server-sent events: one full snapshot per second.
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = () => { if (!engine.isReady()) return; try { res.write(`data: ${JSON.stringify(fullSnapshot())}\n\n`); } catch { /* client gone */ } };
  send();
  const t = setInterval(send, 1000);
  req.on('close', () => clearInterval(t));
});

let tradeCache = { at: 0, rows: [] };
async function recentTrades() {
  if (Date.now() - tradeCache.at > 5000) tradeCache = { at: Date.now(), rows: (await db.recentTrades(200)) ?? [] };
  return tradeCache.rows;
}

app.get('/api/candles/:symbol', async (req, res) => {
  const raw = String(req.params.symbol).replace(/[^A-Za-z0-9]/g, '');
  const symbol = raw.toUpperCase();
  const coin = [...universe.coins.values()].find((c) => c.symbol === symbol);
  let candles = [];
  if (coin?.product) {
    if (feed.closed1m(coin.product).length < 60) await feed.backfill1m(coin.product);
    candles = [...feed.closed1m(coin.product)];
    const forming = feed.forming1m(coin.product);
    if (forming) candles.push(forming);
  } else if (hl.mid(raw) != null) {
    // Copied Hyperliquid coins that Coinbase doesn't list: use Hyperliquid's own 1m candles.
    try {
      const rows = await livePost({ type: 'candleSnapshot', req: { coin: raw, interval: '1m', startTime: Date.now() - 4 * 3600_000, endTime: Date.now() } });
      candles = rows.map((c) => ({ t: Math.floor(c.t / 1000), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) }));
    } catch (e) { return res.status(502).json({ error: 'Hyperliquid candles unavailable' }); }
  } else return res.status(404).json({ error: 'symbol not tradable / not in the universe' });
  const first = candles[0]?.t ?? 0;
  const markers = [];
  for (const t of await recentTrades()) {
    if (t.symbol !== symbol && t.symbol !== raw) continue;
    const entryT = Math.floor(new Date(t.entry_time).getTime() / 60000) * 60;
    if (entryT >= first) markers.push({ time: entryT, position: 'belowBar', color: '#26a69a', shape: t.side === 'short' ? 'arrowDown' : 'arrowUp', text: `${t.side === 'short' ? 'SHORT' : 'BUY'} ${Number(t.entry_price).toPrecision(5)}` });
    if (t.exit_time) {
      const exitT = Math.floor(new Date(t.exit_time).getTime() / 60000) * 60;
      if (exitT >= first) markers.push({ time: exitT, position: 'aboveBar', color: Number(t.final_pnl) >= 0 ? '#26a69a' : '#ef5350', shape: 'arrowDown', text: `SELL ${t.exit_reason} ${Number(t.final_pnl) >= 0 ? '+' : ''}${Number(t.final_pnl).toFixed(2)}` });
    }
  }
  markers.sort((a, b) => a.time - b.time);
  res.json({ symbol, candles: candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })), markers });
});

// Human-only action. The custom header blocks cross-site form posts (the server is also bound to localhost only).
app.post('/api/manual-review/clear', (req, res) => {
  if (req.get('x-requested-with') !== 'dashboard') return res.status(400).json({ error: 'bad request' });
  engine.clearManualReview();
  res.json({ ok: true });
});

const server = app.listen(config.port, '127.0.0.1', () => {
  log(`Dashboard: http://localhost:${config.port}  (PAPER_TRADING=true, paper capital $${config.risk.startingCapital})`);
  engine.start().then(() => copy.start()).catch((e) => { warn('engine failed to start:', e); });
});
server.on('error', (e) => { console.error('Server error:', e.message); process.exit(1); });

process.on('unhandledRejection', (e) => warn('unhandledRejection:', e?.message ?? e));
process.on('uncaughtException', (e) => warn('uncaughtException:', e?.message ?? e));
