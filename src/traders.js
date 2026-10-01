// Finds and scores Hyperliquid traders. Only traders with a verified win rate >= 75% (preferring >= 80%) are ever tracked.
import { config, log, warn } from './config.js';
import { db } from './db.js';
import { fetchLeaderboard, fetchFills, getState, isPerp } from './hyperliquid.js';

const C = config.copy;
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const traders = {
  map: new Map(),        // address -> record (DB column names)
  discovery: { phase: 'idle', total: 0, evaluated: 0, qualified: 0, startedAt: null, finishedAt: null, error: null, leaderboardAt: 0 },
  onTrackedChange: () => {},
};

/**
 * A "trade" is one CLOSING ORDER: the fills that closed (part of) a position, grouped by order id (or TWAP id, so a sliced
 * order is one trade, not hundreds). Its result is sum(closedPnl - fee) over those fills.
 * Win rate = share of closing orders with a net profit. Because scaling out can flatter this number, qualification ALSO
 * requires a high profit factor, positive net P&L, and no large losers still sitting open (see evaluate()).
 */
export function closingOrders(fills) {
  const groups = new Map();
  for (const f of fills) {
    if (!isPerp(f.coin)) continue;
    const closing = Number(f.closedPnl) !== 0 || /close|liquidat| > /i.test(f.dir ?? '');
    if (!closing) continue;
    const key = `${f.coin}|${f.twapId ?? f.oid}`;
    const g = groups.get(key) ?? { coin: f.coin, time: f.time, net: 0 };
    g.net += Number(f.closedPnl) - Number(f.fee);
    g.time = Math.max(g.time, f.time);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

export function summarize(orders, firstFillAt, now = Date.now()) {
  const n = orders.length;
  const wins = orders.filter((t) => t.net > 0).length;
  const grossWin = orders.filter((t) => t.net > 0).reduce((a, t) => a + t.net, 0);
  const grossLoss = -orders.filter((t) => t.net <= 0).reduce((a, t) => a + t.net, 0);
  const lastAt = n ? orders[n - 1].time : null;
  const spanDays = lastAt ? Math.max(1, (lastAt - (firstFillAt ?? orders[0].time)) / DAY) : 0;
  return {
    trades: n, wins, winRate: n ? wins / n : 0,
    netPnl: orders.reduce((a, t) => a + t.net, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0),
    spanDays, tradesPerDay: spanDays ? n / spanDays : 0,
    activeDays: new Set(orders.map((t) => new Date(t.time).toISOString().slice(0, 10))).size,
    maxLoss: n ? Math.min(0, ...orders.map((t) => t.net)) : 0,
    lastCloseAt: lastAt,
  };
}

export async function evaluate(address, meta) {
  const now = Date.now();
  const fills = await fetchFills(address, now - C.windowDays * DAY);
  const st = summarize(closingOrders(fills), fills[0]?.time, now);
  const rec = {
    address, source: 'hyperliquid', display_name: meta.displayName ?? null, status: 'rejected', tier: null, reject_reason: null,
    win_rate: st.winRate, trades: st.trades, wins: st.wins, net_pnl: st.netPnl, profit_factor: st.profitFactor,
    avg_hold_minutes: null, trades_per_day: st.tradesPerDay, max_loss: st.maxLoss, window_days: Math.round(st.spanDays),
    lb_month_pnl: meta.monthPnl ?? null, account_value: meta.accountValue ?? null,
    last_fill_at: fills.length ? new Date(fills[fills.length - 1].time).toISOString() : null,
    evaluated_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
  };
  const why = [];
  if (st.trades < C.minTrades) why.push(`only ${st.trades} closed trades (need ${C.minTrades})`);
  if (st.winRate < C.minWinRate) why.push(`win rate ${(st.winRate * 100).toFixed(0)}% < ${C.minWinRate * 100}%`);
  if (st.trades && st.spanDays < C.minSpanDays) why.push(`only ${st.spanDays.toFixed(0)} days of history (need ${C.minSpanDays})`);
  if (st.trades && st.activeDays < C.minActiveDays) why.push(`traded on only ${st.activeDays} days (need ${C.minActiveDays})`);
  if (!st.lastCloseAt || now - st.lastCloseAt > C.maxLastFillDays * DAY) why.push(`inactive (no closed trade in ${C.maxLastFillDays}d)`);
  if (st.tradesPerDay > C.maxTradesPerDay) why.push(`${st.tradesPerDay.toFixed(0)} closes/day (bot-like, can't be copied)`);
  if (st.profitFactor < C.minProfitFactor) why.push(`profit factor ${st.profitFactor.toFixed(2)} < ${C.minProfitFactor}`);
  if (st.netPnl <= 0) why.push('net P&L not positive');
  if (!why.length) {
    // Realized win rate can hide losers that are still open, so check the live book too.
    const state = await getState(address);
    const unreal = state.positions.reduce((a, p) => a + p.unrealizedPnl, 0);
    rec.unrealized_pnl = unreal; rec.account_value = state.accountValue || rec.account_value;
    if ((rec.account_value ?? 0) < C.minAccountValue) why.push(`account $${Math.round(rec.account_value ?? 0)} < $${C.minAccountValue}`);
    else if (unreal < 0 && -unreal / rec.account_value > C.maxUnrealizedLossPct) why.push(`open positions underwater ${((-unreal / rec.account_value) * 100).toFixed(0)}% of account`);
  }
  if (why.length) rec.reject_reason = why.join('; ');
  else { rec.status = 'qualified'; rec.tier = st.winRate >= C.preferredWinRate ? 'preferred' : 'minimum'; }
  return rec;
}

/** Best qualified traders become the live-tracked set (preferred >= 80% first, then win rate, then profit factor). */
export function select() {
  const q = [...traders.map.values()].filter((t) => t.status === 'qualified' && Number(t.win_rate) >= C.minWinRate)
    .sort((a, b) => (b.tier === 'preferred') - (a.tier === 'preferred') || b.win_rate - a.win_rate || b.profit_factor - a.profit_factor)
    .slice(0, C.maxTracked);
  const chosen = new Set(q.map((t) => t.address));
  const changed = [];
  for (const t of traders.map.values()) {
    const want = chosen.has(t.address);
    if (!!t.tracking !== want) { t.tracking = want; changed.push({ address: t.address, tracking: want, status: t.status, source: 'hyperliquid' }); }
  }
  traders.discovery.qualified = [...traders.map.values()].filter((t) => t.status === 'qualified').length;
  if (changed.length) {
    db.upsertTraders(changed);
    log(`Tracking ${chosen.size} trader(s): ${q.map((t) => `${t.address.slice(0, 8)} ${(t.win_rate * 100).toFixed(0)}% (${t.trades} trades)`).join(', ') || 'none qualify'}`);
  }
  traders.onTrackedChange([...chosen]);
}

export function candidates(rows) {
  const w = (r) => Object.fromEntries(r.windowPerformances);
  const ok = rows.map((r) => ({ r, m: w(r) })).filter(({ r, m }) =>
    Number(r.accountValue) >= C.minAccountValue && Number(r.accountValue) <= C.maxCandidateAccount &&
    Number(m.month.pnl) > 0 && Number(m.allTime.pnl) > 0 &&
    Number(m.month.vlm) >= 100_000 && Number(m.month.vlm) / Number(r.accountValue) <= 400);   // volume/equity cap screens out HFT bots
  const half = C.candidatePool / 2;
  const byMonth = ok.filter(({ m }) => Number(m.month.pnl) >= 2000).sort((a, b) => Number(b.m.month.roi) - Number(a.m.month.roi)).slice(0, half);
  const byAll = ok.filter(({ m }) => Number(m.allTime.pnl) >= 10_000).sort((a, b) => Number(b.m.allTime.roi) - Number(a.m.allTime.roi)).slice(0, half);
  const seen = new Set();
  return [...byMonth, ...byAll].filter(({ r }) => !seen.has(r.ethAddress) && seen.add(r.ethAddress))
    .map(({ r, m }) => ({ address: r.ethAddress.toLowerCase(), displayName: r.displayName, accountValue: Number(r.accountValue), monthPnl: Number(m.month.pnl) }));
}

let cache = { at: 0, list: [] };
async function cycle() {
  const d = traders.discovery;
  d.error = null;
  try {
    if (Date.now() - cache.at > 6 * 3600_000) {
      d.phase = 'downloading leaderboard';
      cache = { at: Date.now(), list: candidates(await fetchLeaderboard()) };
      d.leaderboardAt = cache.at;
    }
    const staleMs = C.reevalHours * 3600_000;
    const stale = (a) => { const t = traders.map.get(a); return !t?.evaluated_at || Date.now() - new Date(t.evaluated_at).getTime() > staleMs; };
    const queue = [
      ...[...traders.map.values()].filter((t) => t.tracking && stale(t.address)).map((t) => ({ address: t.address, displayName: t.display_name, accountValue: t.account_value, monthPnl: t.lb_month_pnl })),
      ...cache.list.filter((c) => stale(c.address)),
    ];
    d.phase = 'evaluating traders'; d.total = queue.length; d.evaluated = 0; d.startedAt = Date.now();
    for (const cand of queue) {
      try {
        const rec = await evaluate(cand.address, cand);
        const prev = traders.map.get(cand.address);
        rec.tracking = prev?.tracking ?? false;
        traders.map.set(cand.address, rec);
        await db.upsertTraders([rec]);
      } catch (e) { warn('trader evaluation', cand.address.slice(0, 8), e.message); await sleep(3000); }
      d.evaluated++;
      if (d.evaluated % 5 === 0) select();
    }
    select();
    d.phase = 'idle'; d.finishedAt = Date.now();
  } catch (e) {
    d.error = e.message; d.phase = 'idle';
    warn('trader discovery failed:', e.message);
  }
}

export async function startTraders() {
  for (const r of ((await db.loadTraders()) ?? []).filter((x) => x.source === 'hyperliquid')) traders.map.set(r.address, { ...r, win_rate: Number(r.win_rate), profit_factor: Number(r.profit_factor) });
  if (traders.map.size) log(`Restored ${traders.map.size} previously evaluated traders from Supabase`);
  select(); // resume tracking known-good traders immediately, before any new evaluation finishes
  (async () => { for (;;) { await cycle(); await sleep(30 * 60_000); } })();
}

export const isTracked = (address) => !!traders.map.get(address.toLowerCase())?.tracking;
