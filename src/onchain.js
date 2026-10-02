// On-chain copy trading via Zerion. Same hard rule as Hyperliquid: only wallets with a verified win rate >= 75% are ever tracked.
// Discovery: GeckoTerminal (active pools -> wallets that trade them). Scoring + live detection: Zerion. Prices/liquidity: DexScreener.
// PAPER ONLY: nothing here can sign or send a transaction.
import { config, log, warn } from './config.js';
import * as engine from './engine.js';
import { db } from './db.js';
import { fetchTrades, getPortfolioValue, getPositions, parseTrade, scoreTrades, summarize, zerionEnabled } from './zerion.js';
import { onchainPx } from './onchainprices.js';

const C = config.copy, Z = config.zerion, R = config.risk;
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const wallets = {
  map: new Map(),   // address -> record (tracked_traders column names)
  discovery: { phase: 'idle', total: 0, evaluated: 0, qualified: 0, startedAt: null, finishedAt: null, error: null },
  status: zerionEnabled ? 'ok' : 'ZERION_API_KEY is not set in .env: on-chain copy trading is idle',
};
const norm = (a) => (a.startsWith('0x') ? a.toLowerCase() : a);   // EVM addresses are case-insensitive, Solana ones are not

/* --------------------------------------------------------------- discovery */

let gtChain = Promise.resolve();
function gt(path) {
  const p = gtChain.then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://api.geckoterminal.com/api/v2${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`geckoterminal ${path.split('?')[0]} -> ${res.status}`);
      return res.json();
    }
    throw new Error('geckoterminal rate limited');
  });
  gtChain = p.then(() => sleep(2300), () => sleep(2300));   // free tier is ~30 calls/min
  return p;
}

// Solana base/quote mints: a "token" that is really SOL or a stablecoin has no useful top-trader list.
const SOL_BASE_MINTS = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const birdeye = { at: 0, day: '', callsToday: 0, lastFound: 0, status: config.keys.birdeye ? 'on' : 'off (no BIRDEYE_API_KEY)' };

/** Wallets with the most REALIZED profit on trending Solana tokens, minus Birdeye-tagged bots/snipers/devs. They still must pass the win-rate scoring. */
async function birdeyeSmartWallets(tokens) {
  const key = config.keys.birdeye;
  if (!key || !tokens.length || Date.now() - birdeye.at < Z.birdeyeEveryH * 3600_000) return [];
  const day = new Date().toISOString().slice(0, 10);
  if (birdeye.day !== day) { birdeye.day = day; birdeye.callsToday = 0; }
  const found = new Map();
  for (const token of [...new Set(tokens)].slice(0, Z.birdeyeTokens)) {
    if (birdeye.callsToday >= Z.birdeyePerDayCap) { birdeye.status = 'daily call cap reached'; break; }
    birdeye.callsToday++;
    try {
      const res = await fetch(`https://public-api.birdeye.so/defi/v2/tokens/top_traders?address=${token}&time_frame=7d&sort_type=desc&sort_by=realized_pnl&offset=0&limit=10`,
        { headers: { 'X-API-KEY': key, 'x-chain': 'solana', accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 401 || res.status === 403) { birdeye.status = `key rejected (HTTP ${res.status}) or endpoint not on your plan`; warn('Birdeye:', birdeye.status); break; }
      if (!res.ok) { warn('Birdeye top_traders', res.status); continue; }
      for (const t of (await res.json()).data?.items ?? []) {
        if ((t.tags ?? []).some((x) => /bundler|sniper|dev|bot|mev/i.test(x))) continue;
        if (!(t.realizedPnl >= Z.birdeyeMinRealizedUsd) || !(t.trade >= Z.birdeyeMinTrades)) continue;
        found.set(t.owner, (found.get(t.owner) ?? 0) + t.realizedPnl);
      }
    } catch (e) { warn('Birdeye', e.message); }
    finally { await sleep(1300); }   // free plan: 1 request per second, even after a failed call
  }
  birdeye.at = Date.now(); birdeye.lastFound = found.size;
  if (birdeye.status === 'on' || /cap/.test(birdeye.status)) birdeye.status = 'on';
  log(`Birdeye: ${found.size} profitable non-bot Solana wallets from ${Math.min(tokens.length, Z.birdeyeTokens)} trending tokens (${birdeye.callsToday}/${Z.birdeyePerDayCap} calls today)`);
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
}

const STABLE_PAIR = /\b(USDC|USDT|DAI|USDS|USDE)\b\s*\/\s*\b(USDC|USDT|DAI|USDS|USDE)\b/i;
async function discoverCandidates() {
  const seen = new Map();   // address -> { pools:Set, vol, n }
  const bots = new Set();
  const solTokens = [];
  for (const net of Z.networks) {
    try {
      const tp = await gt(`/networks/${net}/trending_pools?page=1`);
      // Mid-liquidity pools with real volume: the largest majors are dominated by bots and routers.
      const pools = (tp.data ?? []).filter((p) => {
        const a = p.attributes, liq = Number(a.reserve_in_usd), vol = Number(a.volume_usd?.h24);
        return !STABLE_PAIR.test(a.name) && liq >= Z.poolLiquidityMin && liq <= Z.poolLiquidityMax && vol >= Z.poolVolume24hMin;
      }).slice(0, Z.poolsPerNetwork);
      if (net === 'solana') for (const p of pools) { const mint = String(p.relationships?.base_token?.data?.id ?? '').replace(/^solana_/, ''); if (mint && !SOL_BASE_MINTS.has(mint)) solTokens.push(mint); }
      for (const p of pools) {
        try {
          const tr = await gt(`/networks/${net}/pools/${p.attributes.address}/trades?trade_volume_in_usd_greater_than=${Z.minDiscoveryTradeUsd}`);
          const inPool = new Map();
          for (const t of tr.data ?? []) {
            const a = t.attributes, addr = a.tx_from_address && norm(a.tx_from_address), usd = Number(a.volume_in_usd) || 0;
            if (!addr || usd > Z.maxDiscoveryTradeUsd) continue;
            const c = inPool.get(addr) ?? { n: 0, vol: 0 };
            c.n++; c.vol += usd; inPool.set(addr, c);
          }
          for (const [addr, c] of inPool) {
            if (c.n > Z.botSamplePerPool) { bots.add(addr); continue; }   // many swaps in one pool sample: a bot, not a discretionary trader
            const g = seen.get(addr) ?? { pools: new Set(), vol: 0, n: 0 };
            g.pools.add(p.id); g.vol += c.vol; g.n += c.n;
            seen.set(addr, g);
          }
        } catch (e) { warn('pool trades', e.message); }
      }
    } catch (e) { warn('trending pools', net, e.message); }
  }
  const found = [...seen.entries()].filter(([a]) => !bots.has(a)).sort((a, b) => b[1].pools.size - a[1].pools.size || b[1].vol - a[1].vol).slice(0, Z.candidatePool).map(([a]) => a);
  log(`Zerion discovery: ${found.length} candidate wallets (${bots.size} bot-like addresses excluded)`);
  const watch = config.keys.watchWallets.map(norm);
  const smart = await birdeyeSmartWallets(solTokens);
  return [...new Set([...watch, ...smart, ...found])];
}

/* -------------------------------------------------------------- evaluation */

export async function evaluate(address) {
  const now = Date.now();
  const raw = await fetchTrades(address, now - C.windowDays * DAY, { maxPages: Z.maxPages });
  const trades = raw.map(parseTrade).filter(Boolean);
  const { closings, book } = scoreTrades(trades);
  const firstAt = trades.length ? Math.min(...trades.map((t) => t.at)) : now;
  const st = summarize(closings, firstAt, now);
  const chainsSeen = [...new Set(trades.map((t) => t.chain))];
  const rec = {
    address, source: 'zerion', display_name: null, status: 'rejected', tier: null, reject_reason: null,
    win_rate: st.winRate, trades: st.trades, wins: st.wins, net_pnl: st.netPnl, profit_factor: st.profitFactor, avg_hold_minutes: null,
    trades_per_day: st.tradesPerDay, max_loss: st.maxLoss, window_days: Math.round(st.spanDays), chains: chainsSeen,
    last_fill_at: st.lastCloseAt ? new Date(st.lastCloseAt).toISOString() : null, evaluated_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
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
    const [value, positions] = [await getPortfolioValue(address), await getPositions(address)];
    rec.account_value = rec.portfolio_value = value;
    // Tokens still held that were bought in the window: compare current value to remaining cost basis.
    const heldValue = new Map();
    for (const p of positions) heldValue.set(p.fungibleId, (heldValue.get(p.fungibleId) ?? 0) + p.value);
    let unreal = 0;
    for (const b of book.values()) if (b.qty > 0 && b.cost > 0) unreal += (heldValue.get(b.fungibleId) ?? 0) - b.cost;
    rec.unrealized_pnl = unreal;
    if (value < C.minAccountValue) why.push(`portfolio $${Math.round(value)} < $${C.minAccountValue}`);
    else if (unreal < 0 && -unreal / value > C.maxUnrealizedLossPct) why.push(`open positions underwater ${((-unreal / value) * 100).toFixed(0)}% of portfolio`);
  }
  if (why.length) rec.reject_reason = why.join('; ');
  else { rec.status = 'qualified'; rec.tier = st.winRate >= C.preferredWinRate ? 'preferred' : 'minimum'; }
  return rec;
}

export function select() {
  const q = [...wallets.map.values()].filter((t) => t.status === 'qualified' && Number(t.win_rate) >= C.minWinRate && !engine.traderStatus(t.address).excluded)
    .sort((a, b) => (b.tier === 'preferred') - (a.tier === 'preferred') || b.win_rate - a.win_rate || b.profit_factor - a.profit_factor)
    .slice(0, C.maxTracked);
  const chosen = new Set(q.map((t) => t.address));
  const changed = [];
  for (const t of wallets.map.values()) {
    const want = chosen.has(t.address);
    if (!!t.tracking !== want) { t.tracking = want; changed.push({ address: t.address, source: 'zerion', tracking: want, status: t.status }); }
  }
  wallets.discovery.qualified = [...wallets.map.values()].filter((t) => t.status === 'qualified').length;
  if (changed.length) {
    db.upsertTraders(changed);
    log(`Zerion: tracking ${chosen.size} wallet(s): ${q.map((t) => `${t.address.slice(0, 8)} ${(t.win_rate * 100).toFixed(0)}% (${t.trades} trades)`).join(', ') || 'none qualify'}`);
  }
}

async function cycle() {
  const d = wallets.discovery;
  d.error = null;
  try {
    d.phase = 'discovering wallets';
    const candidates = await discoverCandidates();
    const staleMs = C.reevalHours * 3600_000;
    const stale = (a) => { const t = wallets.map.get(a); return engine.state.rescore.has(a) || !t?.evaluated_at || Date.now() - new Date(t.evaluated_at).getTime() > staleMs; };
    const queue = [...[...wallets.map.values()].filter((t) => t.tracking && stale(t.address)).map((t) => t.address), ...candidates.filter(stale)];
    d.phase = 'evaluating wallets'; d.total = queue.length; d.evaluated = 0; d.scorable = 0; d.startedAt = Date.now();
    for (const address of queue) {
      try {
        const rec = await evaluate(address);
        if (rec.trades >= C.minTrades) d.scorable = (d.scorable ?? 0) + 1;
        rec.tracking = wallets.map.get(address)?.tracking ?? false;
        wallets.map.set(address, rec);
        engine.state.rescore.delete(address);
        await db.upsertTraders([rec]);
      } catch (e) {
        warn('wallet evaluation', address.slice(0, 8), e.message);
        if (/rejected the API key/.test(e.message)) { wallets.status = e.message; d.error = e.message; break; }
        await sleep(3000);
      }
      d.evaluated++;
      if (d.evaluated % 5 === 0) select();
    }
    select();
    d.phase = 'idle'; d.finishedAt = Date.now();
  } catch (e) { d.error = e.message; d.phase = 'idle'; warn('on-chain discovery failed:', e.message); }
}

/* ------------------------------------------------------------------ prices */

const DEX_CHAIN = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', 'binance-smart-chain': 'bsc', solana: 'solana', polygon: 'polygon', optimism: 'optimism', avalanche: 'avalanche' };
async function dexToken(chain, address) {
  const id = DEX_CHAIN[chain];
  if (!id || !address) return null;
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/${id}/${address}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const pairs = await res.json();
  const p = (Array.isArray(pairs) ? pairs : []).filter((x) => Number(x.priceUsd) > 0).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!p) return null;
  return {
    px: Number(p.priceUsd), liq: p.liquidity?.usd ?? 0, vol24: p.volume?.h24 ?? 0, symbol: p.baseToken?.symbol,
    ageDays: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / DAY : null, at: Date.now(),
  };
}

async function pricePoll() {
  for (const pos of [...engine.state.positions.values()].filter((p) => p.venue === 'onchain')) {
    try {
      const q = await dexToken(pos.extra.chain, pos.extra.tokenAddress);
      if (q) { onchainPx.set(pos.coin, { px: q.px, at: q.at }); engine.onHlPrice(pos, q.px); }
      else if (Date.now() - (onchainPx.get(pos.coin)?.at ?? 0) > 60_000 && Date.now() - (pos.lastStaleWarn ?? 0) > 60_000) {
        pos.lastStaleWarn = Date.now();
        engine.logDecision('info', pos.symbol, 'on-chain price unavailable for over a minute: position cannot be verified right now');
      }
    } catch (e) { warn('price poll', pos.symbol, e.message); }
  }
}

/* ------------------------------------------------------------------- live */

const findPos = (address, key) => [...engine.state.positions.values()].find((p) => p.venue === 'onchain' && p.coin === key && p.copy?.trader === address);
const noted = new Map();
function skip(address, symbol, reason, o = {}) {
  const k = `${address}|${symbol}`;
  if (noted.get(k)?.reason === reason && Date.now() - noted.get(k).at < 10 * 60_000) return;
  noted.set(k, { reason, at: Date.now() });
  engine.logDecision('skipped', symbol, `copy ${address.slice(0, 8)} (on-chain): ${reason}`);
  db.insertSignal({
    symbol, direction: 'long', confidence: o.winRate != null ? o.winRate * 100 : null, reference_price: o.price ?? null, status: 'skipped',
    skip_reason: `on-chain copy of ${address.slice(0, 10)}: ${reason}`, evidence_summary: reason, evidence: { source: 'copy_zerion', trader: address }, btc_regime: engine.state.btc.regime,
  });
}

const valueCache = new Map();
async function walletValue(address) {
  const c = valueCache.get(address);
  if (c && Date.now() - c.at < 5 * 60_000) return c.value;
  let value = 0;
  try { value = await getPortfolioValue(address, { live: true }); } catch (e) { warn('portfolio value', e.message); }
  value = value || Number(wallets.map.get(address)?.portfolio_value) || 0;
  valueCache.set(address, { at: Date.now(), value });
  return value;
}

async function handleTrade(address, tr) {
  const w = wallets.map.get(address);
  const ageMs = Date.now() - tr.at;

  // Exits first and never skipped for age: if we hold what they sold, follow them out.
  for (const out of tr.outs.filter((o) => !o.base)) {
    const pos = findPos(address, out.key);
    if (!pos) continue;
    let after = null;
    try { after = (await getPositions(address, { live: true })).filter((p) => p.fungibleId === out.fungibleId).reduce((a, p) => a + p.qty, 0); } catch (e) { warn('positions', e.message); }
    const frac = after == null ? Math.min(1, out.qty / (pos.leaderSize || out.qty)) : out.qty / (out.qty + after);
    const q = await dexToken(pos.extra.chain, pos.extra.tokenAddress);
    if (!q) { warn(`no fresh price to mirror the ${pos.symbol} exit`); continue; }
    onchainPx.set(pos.coin, { px: q.px, at: q.at });
    if (frac >= 0.95 || (after != null && after * q.px < 1)) await engine.closePosition(pos, q.px, 'leader_exit');
    else { pos.leaderSize = after ?? pos.leaderSize * (1 - frac); await engine.reducePosition(pos, frac, q.px, 'leader_reduce'); }
  }

  // Entries / adds: only wallets that are currently tracked (i.e. qualified).
  if (!w?.tracking) return;
  if (!C.mirror) return;                                           // copy entries are OFF: tracked wallets are a data input only, they never open or add to a position
  for (const inn of tr.ins.filter((i) => !i.base && i.address)) {
    const o = { winRate: w.win_rate, price: inn.px };
    if (ageMs > Z.maxFillAgeMs) { skip(address, inn.symbol, `swap detected ${(ageMs / 1000).toFixed(0)}s late (limit ${Z.maxFillAgeMs / 1000}s)`, o); continue; }
    const q = await dexToken(inn.chain, inn.address);
    if (!q) { skip(address, inn.symbol, `no DEX price/liquidity data on ${inn.chain}`, o); continue; }
    if (q.liq < Z.minLiquidityUsd) { skip(address, inn.symbol, `liquidity $${Math.round(q.liq)} < $${Z.minLiquidityUsd}: could not exit realistically`, o); continue; }
    if (q.vol24 < Z.minVolume24hUsd) { skip(address, inn.symbol, `24h volume $${Math.round(q.vol24)} < $${Z.minVolume24hUsd}`, o); continue; }
    if (q.ageDays != null && q.ageDays < Z.minPairAgeDays) { skip(address, inn.symbol, `pair only ${q.ageDays.toFixed(1)} days old`, o); continue; }
    onchainPx.set(inn.key, { px: q.px, at: q.at });
    const ourPx = q.px * (1 + R.slippagePct);
    if (ourPx > inn.px * (1 + C.maxChasePct)) { skip(address, inn.symbol, `missed the move: our price ${ourPx.toPrecision(5)} is >${C.maxChasePct * 100}% above their ${inn.px.toPrecision(5)}`, o); continue; }

    const value = await walletValue(address);
    if (!value) { skip(address, inn.symbol, "could not read the wallet's portfolio value", o); continue; }
    const equity = engine.markEquity();
    const k = equity / value;
    const target = Math.min(k * inn.usd, R.maxPositionPct * equity);
    if (target < C.minNotional) continue;                          // too small to mirror

    const existing = findPos(address, inn.key);
    if (existing) {
      existing.leaderSize = (existing.leaderSize || 0) + inn.qty;
      const r = await engine.addToCopyPosition(existing, target, q.px, 0);
      if (!r.ok) skip(address, inn.symbol, r.reason, o);
      continue;
    }
    const res = await engine.openCopyPosition({
      venue: 'onchain', source: 'copy_zerion', coin: inn.key, symbol: inn.symbol, side: 'long', price: q.px, priceAgeMs: 0, notional: target,
      trader: address, winRate: w.win_rate, tier: w.tier, leaderPx: inn.px, leaderTime: tr.at, leaderSize: inn.qty, k,
      extra: { chain: inn.chain, tokenAddress: inn.address, assetKey: inn.key, fungibleId: inn.fungibleId },
    });
    if (!res.ok) { skip(address, inn.symbol, res.reason, o); continue; }
    db.insertSignal({
      symbol: inn.symbol, direction: 'long', confidence: w.win_rate * 100, reference_price: q.px, status: 'entered', trade_id: res.pos.id.startsWith('mem-') ? null : res.pos.id,
      evidence_summary: res.pos.rationale, evidence: { source: 'copy_zerion', trader: address, winRate: w.win_rate, tier: w.tier, chain: inn.chain, token: inn.address, latencyMs: ageMs }, btc_regime: engine.state.btc.regime,
    });
  }
}

const seenTx = new Set();
const lastPoll = new Map();
const watched = () => {
  const set = new Set([...wallets.map.values()].filter((t) => t.tracking).map((t) => t.address));
  for (const p of engine.state.positions.values()) if (p.venue === 'onchain' && p.copy?.trader) set.add(p.copy.trader);
  return set;
};
let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    for (const address of watched()) {
      const first = !lastPoll.has(address);
      const started = Date.now();
      let raw;
      try { raw = await fetchTrades(address, (lastPoll.get(address) ?? started) - 5 * 60_000, { live: true, maxPages: 1 }); }
      catch (e) { warn('wallet poll', address.slice(0, 8), e.message); continue; }
      lastPoll.set(address, started);
      for (const tr of raw.map(parseTrade).filter(Boolean).sort((a, b) => a.at - b.at)) {
        if (seenTx.has(tr.id)) continue;
        seenTx.add(tr.id);
        if (seenTx.size > 5000) { const it = seenTx.values(); for (let i = 0; i < 1000; i++) seenTx.delete(it.next().value); }
        if (first) continue;                                       // the first poll only primes history: never trade on it
        try { await handleTrade(address, tr); } catch (e) { warn('copy trade error:', e.message); }
      }
    }
  } finally { polling = false; }
}

/** After a restart: leave any position whose leader no longer holds the token. */
async function resyncOpenPositions() {
  for (const pos of [...engine.state.positions.values()].filter((p) => p.venue === 'onchain')) {
    try {
      const held = (await getPositions(pos.copy.trader, { live: true })).filter((p) => p.fungibleId === pos.extra.fungibleId).reduce((a, p) => a + p.qty, 0);
      const q = await dexToken(pos.extra.chain, pos.extra.tokenAddress);
      if (!q) continue;
      if (held <= 0) await engine.closePosition(pos, q.px, 'leader_exit_while_offline');
    } catch (e) { warn('on-chain resync failed', pos.symbol, e.message); }
  }
}

export async function start() {
  if (!zerionEnabled) { log('Zerion: ZERION_API_KEY not set, on-chain copy trading idle'); return; }
  for (const r of ((await db.loadTraders()) ?? []).filter((x) => x.source === 'zerion')) wallets.map.set(r.address, { ...r, win_rate: Number(r.win_rate), profit_factor: Number(r.profit_factor), portfolio_value: Number(r.portfolio_value) });
  if (wallets.map.size) log(`Zerion: restored ${wallets.map.size} previously evaluated wallets`);
  select();
  await resyncOpenPositions();
  setInterval(() => pollOnce().catch((e) => warn('poll', e.message)), Z.pollMs);
  setInterval(() => pricePoll().catch((e) => warn('price poll', e.message)), Z.pricePollMs);
  (async () => { for (;;) { await cycle(); await sleep(30 * 60_000); } })();
  log('On-chain copy engine running (paper): mirrors only wallets with a verified win rate >= 75%');
}

export function snapshot() {
  const all = [...wallets.map.values()];
  const row = (t) => ({
    source: 'zerion', address: t.address, name: null, status: t.status, tier: t.tier, tracking: !!t.tracking, winRate: Number(t.win_rate), trades: t.trades,
    profitFactor: Number(t.profit_factor), netPnl: Number(t.net_pnl), perDay: Number(t.trades_per_day), days: t.window_days, accountValue: Number(t.portfolio_value ?? t.account_value),
    unrealized: t.unrealized_pnl != null ? Number(t.unrealized_pnl) : null, lastFillAt: t.last_fill_at, reason: t.reject_reason, chains: t.chains ?? [], streak: engine.traderStatus(t.address),
    holding: [...engine.state.positions.values()].filter((p) => p.venue === 'onchain' && p.copy?.trader === t.address).map((p) => `long ${p.symbol}`),
  });
  return {
    enabled: zerionEnabled, status: wallets.status, discovery: wallets.discovery,
    birdeye: { status: birdeye.status, callsToday: birdeye.callsToday, cap: Z.birdeyePerDayCap, lastFound: birdeye.lastFound, lastAt: birdeye.at || null },
    counts: { evaluated: all.length, qualified: all.filter((t) => t.status === 'qualified').length, preferred: all.filter((t) => t.status === 'qualified' && t.tier === 'preferred').length, tracking: all.filter((t) => t.tracking).length },
    tracked: all.filter((t) => t.tracking).sort((a, b) => b.win_rate - a.win_rate).map(row),
    bench: all.filter((t) => t.status === 'qualified' && !t.tracking).sort((a, b) => b.win_rate - a.win_rate).map(row),
    near: all.filter((t) => t.status === 'rejected' && t.trades >= 10).sort((a, b) => b.win_rate - a.win_rate).slice(0, 12).map(row),
  };
}
export const __test = { handleTrade, wallets, discoverCandidates, birdeyeSmartWallets, birdeye };
