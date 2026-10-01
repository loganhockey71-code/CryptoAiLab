// Copy engine: watches the live fills of tracked Hyperliquid traders and mirrors them on the PAPER book.
// Only fills from traders with a verified win rate >= 75% can open a position. Nothing here can place a real order.
import { config, log, warn } from './config.js';
import * as engine from './engine.js';
import { hl, isPerp, fetchFills, getState } from './hyperliquid.js';
import { traders, startTraders } from './traders.js';
import { db } from './db.js';
import * as onchain from './onchain.js';

const C = config.copy, R = config.risk;
const seen = new Set();          // fill ids already handled
const lastSeen = new Map();      // address -> newest fill time processed
const building = new Map();      // "address|coin" -> { side, since }: a leader still scaling into a fresh entry
const equityCache = new Map();   // address -> { at, accountValue }
const noted = new Map();         // dedupe identical skip messages
const chains = new Map();        // per-address serial queue so fills are processed in order

const findPos = (address, coin) => [...engine.state.positions.values()].find((p) => p.venue === 'hl' && p.coin === coin && p.copy?.trader === address);

function note(key, reason) {
  const last = noted.get(key);
  if (last?.reason === reason && Date.now() - last.at < 10 * 60_000) return false;
  noted.set(key, { reason, at: Date.now() });
  return true;
}

function skip(address, coin, reason, o = {}) {
  if (!note(`${address}|${coin}`, reason)) return;
  engine.logDecision('skipped', coin, `copy ${address.slice(0, 8)}: ${reason}`);
  db.insertSignal({
    symbol: coin, direction: o.side ?? null, confidence: o.winRate != null ? o.winRate * 100 : null, reference_price: hl.mid(coin), status: 'skipped',
    skip_reason: `copy of ${address.slice(0, 10)}: ${reason}`, evidence_summary: reason, evidence: { source: 'copy_hyperliquid', trader: address, leaderPx: o.leaderPx ?? null },
    btc_regime: engine.state.btc.regime,
  });
}

async function freshMid(coin) {
  if (hl.midAgeMs() > R.staleMs) { try { await hl.refreshMidsRest(); } catch (e) { warn('Hyperliquid mids refresh failed:', e.message); } }
  return hl.midAgeMs() <= R.staleMs ? hl.mid(coin) : null;
}

async function leaderEquity(address) {
  const c = equityCache.get(address);
  if (c && Date.now() - c.at < 60_000) return c.accountValue;
  let av = 0;
  try { av = (await getState(address, { live: true })).accountValue; } catch (e) { warn('leader state', e.message); }
  av = av || Number(traders.map.get(address)?.account_value) || 0;
  equityCache.set(address, { at: Date.now(), accountValue: av });
  return av;
}

async function onFill(address, fill) {
  if (seen.has(fill.tid)) return;
  seen.add(fill.tid);
  if (seen.size > 5000) { const it = seen.values(); for (let i = 0; i < 1000; i++) seen.delete(it.next().value); }
  lastSeen.set(address, Math.max(lastSeen.get(address) ?? 0, fill.time));
  const coin = fill.coin;
  if (!isPerp(coin)) return;

  const sz = Number(fill.sz), signed = fill.side === 'B' ? sz : -sz;
  const start = Number(fill.startPosition), end = start + signed;
  const eps = Math.max(1e-9, sz * 1e-6);
  const endSide = end > eps ? 'long' : end < -eps ? 'short' : null;
  const fillPx = Number(fill.px);
  const ageMs = Date.now() - fill.time;
  const trader = traders.map.get(address);
  let pos = findPos(address, coin);
  let flipped = false;

  // --- We already hold a mirror of this leader's position: follow every change they make (exits are never delayed by age).
  if (pos) {
    const mid = await freshMid(coin);
    if (mid == null) { warn(`no fresh Hyperliquid price to mirror ${coin} exit/adjustment`); return; }
    if (!endSide) { await engine.closePosition(pos, mid, 'leader_exit'); building.delete(`${address}|${coin}`); return; }
    if (endSide !== pos.side) { await engine.closePosition(pos, mid, 'leader_flip'); pos = null; flipped = true; }
    else {
      pos.leaderSize = Math.abs(end);
      const equity = engine.markEquity();
      const target = Math.min(pos.copy.k * Math.abs(end) * mid, R.maxPositionPct * equity);
      const cur = pos.qty * mid;
      if (Math.abs(end) > Math.abs(start) && target - cur >= C.minNotional) {
        if (ageMs > C.maxFillAgeMs) return skip(address, coin, `leader added but the fill is ${(ageMs / 1000).toFixed(0)}s old: not chasing`, { side: pos.side });
        const chase = pos.side === 'long' ? mid > fillPx * (1 + C.maxChasePct) : mid < fillPx * (1 - C.maxChasePct);
        if (chase) return skip(address, coin, 'leader added but price already moved more than 1%: not chasing', { side: pos.side });
        const r = await engine.addToCopyPosition(pos, target - cur, mid);
        if (!r.ok) skip(address, coin, r.reason, { side: pos.side });
      } else if (Math.abs(end) < Math.abs(start) && cur - target >= C.minNotional) {
        await engine.reducePosition(pos, (cur - target) / cur, mid, 'leader_reduce');
      }
      return;
    }
  }

  // --- No position: can this fill open one?
  if (!endSide) return;
  const increasing = Math.abs(end) > Math.abs(start) + eps && Math.sign(signed) === (endSide === 'long' ? 1 : -1);
  if (!increasing) return;
  if (!trader?.tracking) return;                                  // only currently-qualified tracked traders can open anything
  const key = `${address}|${coin}`;
  const fresh = Math.abs(start) <= eps || flipped;                 // an entry from flat (or the new side of a flip)
  const b = building.get(key);
  if (fresh) building.set(key, { side: endSide, since: Date.now() });
  else if (!b || b.side !== endSide || Date.now() - b.since > 10 * 60_000) return;   // never join a position they've held for a while

  const o = { side: endSide, winRate: trader.win_rate, leaderPx: fillPx };
  if (ageMs > C.maxFillAgeMs) return skip(address, coin, `fill detected ${(ageMs / 1000).toFixed(0)}s late (limit ${C.maxFillAgeMs / 1000}s)`, o);
  const mid = await freshMid(coin);
  if (mid == null) return skip(address, coin, 'Hyperliquid price not verified fresh', o);
  const ourPx = endSide === 'long' ? mid * (1 + R.slippagePct) : mid * (1 - R.slippagePct);
  const chased = endSide === 'long' ? ourPx > fillPx * (1 + C.maxChasePct) : ourPx < fillPx * (1 - C.maxChasePct);
  if (chased) return skip(address, coin, `missed the move: our price ${ourPx.toPrecision(6)} is >${C.maxChasePct * 100}% worse than their fill ${fillPx}`, o);

  const av = await leaderEquity(address);
  if (!av) return skip(address, coin, "could not read the trader's account value", o);
  const equity = engine.markEquity();
  const k = equity / av;                                          // mirror at account scale: same % of equity they deploy
  const target = Math.min(k * Math.abs(end) * mid, R.maxPositionPct * equity);
  if (target < C.minNotional) return;                             // dust so far: keep watching while they build the position

  const res = await engine.openCopyPosition({ coin, side: endSide, price: mid, notional: target, trader: address, winRate: trader.win_rate, tier: trader.tier, leaderPx: fillPx, leaderTime: fill.time, leaderSize: Math.abs(end), k });
  if (!res.ok) return skip(address, coin, res.reason, o);
  db.insertSignal({
    symbol: coin, direction: endSide, confidence: trader.win_rate * 100, reference_price: mid, status: 'entered', trade_id: res.pos.id.startsWith('mem-') ? null : res.pos.id,
    evidence_summary: res.pos.rationale, evidence: { source: 'copy_hyperliquid', trader: address, winRate: trader.win_rate, tier: trader.tier, leaderPx: fillPx, latencyMs: Date.now() - fill.time },
    btc_regime: engine.state.btc.regime,
  });
}

function enqueue(address, fn) {
  const next = (chains.get(address) ?? Promise.resolve()).then(fn).catch((e) => warn('copy fill error:', e.message));
  chains.set(address, next);
  return next;
}

/** Addresses that must stay subscribed: every tracked trader plus anyone we currently hold a copied position from. */
function subscriptions() {
  const set = new Set([...traders.map.values()].filter((t) => t.tracking).map((t) => t.address));
  for (const p of engine.state.positions.values()) if (p.venue === 'hl' && p.copy?.trader) set.add(p.copy.trader);
  return set;
}
const syncSubscriptions = () => hl.trackUsers(subscriptions());

async function catchUp() {
  for (const address of subscriptions()) {
    try {
      const since = (lastSeen.get(address) ?? Date.now() - 2 * 60_000) + 1;
      const fills = (await fetchFills(address, since, { live: true, maxPages: 1 })).sort((a, b) => a.time - b.time);
      for (const f of fills) enqueue(address, () => onFill(address, f));
    } catch (e) { warn('catch-up failed', address.slice(0, 8), e.message); }
  }
}

/** After a restart: if a leader already left a position we still hold, leave too. */
async function resyncOpenPositions() {
  for (const pos of [...engine.state.positions.values()].filter((p) => p.venue === 'hl')) {
    try {
      const st = await getState(pos.copy.trader, { live: true });
      const theirs = st.positions.find((p) => p.coin === pos.coin);
      const side = theirs && theirs.szi > 0 ? 'long' : theirs && theirs.szi < 0 ? 'short' : null;
      const mid = await freshMid(pos.coin);
      if (mid == null) continue;
      if (side !== pos.side) await engine.closePosition(pos, mid, 'leader_exit_while_offline');
      else pos.leaderSize = Math.abs(theirs.szi);
    } catch (e) { warn('resync failed', pos.coin, e.message); }
  }
}

export async function start() {
  hl.on('fill', ({ address, fill, snapshot }) => {
    if (snapshot) { lastSeen.set(address, Math.max(lastSeen.get(address) ?? 0, fill.time)); return; }   // history replayed on subscribe: never traded on
    enqueue(address, () => onFill(address, fill));
  });
  hl.on('mids', () => {
    for (const pos of engine.state.positions.values()) {
      if (pos.venue !== 'hl') continue;
      const px = hl.mid(pos.coin);
      if (px != null) engine.onHlPrice(pos, px);
    }
  });
  hl.on('open', (isReconnect) => { syncSubscriptions(); if (isReconnect) catchUp(); });
  traders.onTrackedChange = syncSubscriptions;
  engine.setSmartMoneyProvider(smartMoneyFor);
  hl.start();
  await new Promise((r) => setTimeout(r, 1500));
  await resyncOpenPositions();
  await startTraders();
  setInterval(syncSubscriptions, 30_000);
  setInterval(() => refreshSmartMoney().catch((e) => warn('smart money', e.message)), 60_000);
  setTimeout(() => refreshSmartMoney().catch(() => {}), 20_000);
  setInterval(async () => { if (hl.midAgeMs() > R.staleMs) { try { await hl.refreshMidsRest(); } catch { /* retried next tick */ } } }, 5000);
  log('Copy engine running (paper): mirrors only traders with a verified win rate >= 75%');
}

/* ------------------------------------------------------------ smart-money view */
// What the tracked (>=75% win rate) Hyperliquid traders hold right now, by base symbol. The LLM strategy uses this as its "smart money" evidence.
let smartMap = new Map();
async function refreshSmartMoney() {
  const next = new Map();
  for (const t of [...traders.map.values()].filter((x) => x.tracking)) {
    try {
      const st = await getState(t.address, { live: true });
      for (const p of st.positions) {
        if (!isPerp(p.coin) || !p.szi) continue;
        const sym = p.coin.replace(/^k(?=[A-Z])/, '');          // kPEPE -> PEPE
        const e = next.get(sym) ?? { longs: 0, shorts: 0, preferredLongs: 0, traders: [] };
        const side = p.szi > 0 ? 'long' : 'short';
        if (side === 'long') { e.longs++; if (t.tier === 'preferred') e.preferredLongs++; } else e.shorts++;
        e.traders.push({ address: t.address, side, notional: p.positionValue, winRate: Number(t.win_rate) });
        next.set(sym, e);
      }
    } catch (e) { warn('smart-money refresh', t.address.slice(0, 8), e.message); }
  }
  smartMap = next;
}
export function smartMoneyFor(symbol) {
  const e = smartMap.get(symbol);
  return e ? { ...e, net: e.longs - e.shorts } : null;
}

/** Dashboard data: Hyperliquid traders and Zerion on-chain wallets together. */
export function snapshot() {
  const all = [...traders.map.values()];
  const row = (t) => ({
    source: 'hyperliquid', address: t.address, name: t.display_name, status: t.status, tier: t.tier, tracking: !!t.tracking, winRate: Number(t.win_rate), trades: t.trades,
    profitFactor: Number(t.profit_factor), netPnl: Number(t.net_pnl), perDay: Number(t.trades_per_day), days: t.window_days, accountValue: Number(t.account_value),
    unrealized: t.unrealized_pnl != null ? Number(t.unrealized_pnl) : null, lastFillAt: t.last_fill_at, reason: t.reject_reason, chains: ['hyperliquid'],
    holding: [...engine.state.positions.values()].filter((p) => p.venue === 'hl' && p.copy?.trader === t.address).map((p) => `${p.side} ${p.coin}`),
  });
  const byWin = (a, b) => b.winRate - a.winRate;
  const hlTracked = all.filter((t) => t.tracking).sort((a, b) => b.win_rate - a.win_rate).map(row);
  const hlBench = all.filter((t) => t.status === 'qualified' && !t.tracking).sort((a, b) => b.win_rate - a.win_rate).map(row);
  const hlNear = all.filter((t) => t.status === 'rejected' && t.trades >= 10).sort((a, b) => b.win_rate - a.win_rate).slice(0, 12).map(row);
  const hlCounts = { evaluated: all.length, qualified: all.filter((t) => t.status === 'qualified').length, preferred: all.filter((t) => t.status === 'qualified' && t.tier === 'preferred').length, tracking: hlTracked.length };
  const oc = onchain.snapshot();
  const sum = (k) => hlCounts[k] + oc.counts[k];
  return {
    counts: { evaluated: sum('evaluated'), qualified: sum('qualified'), preferred: sum('preferred'), tracking: sum('tracking') },
    traders: [...hlTracked, ...oc.tracked].sort(byWin).concat([...hlBench, ...oc.bench].sort(byWin), [...hlNear, ...oc.near].sort(byWin).slice(0, 14)),
    sources: {
      hyperliquid: { counts: hlCounts, discovery: traders.discovery, connected: hl.connected, midAgeMs: Number.isFinite(hl.midAgeMs()) ? hl.midAgeMs() : null },
      zerion: { enabled: oc.enabled, status: oc.status, counts: oc.counts, discovery: oc.discovery, birdeye: oc.birdeye },
    },
    rules: { minWinRate: C.minWinRate, preferredWinRate: C.preferredWinRate, minTrades: C.minTrades, windowDays: C.windowDays, stopPct: C.stopPct, maxChasePct: C.maxChasePct },
  };
}

export const __test = { onFill };
