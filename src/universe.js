// Dynamic tradable universe (every Coinbase USD market CoinGecko can identify): CoinGecko is the ranking source, CoinMarketCap validates the top 300.
import { config, log, warn } from './config.js';
import { db } from './db.js';

const { coingecko, coinmarketcap } = config.keys;
const Z = config.radar;
let cgMode = coingecko ? 'demo' : 'public'; // remembered after the first successful call

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CoinGecko client: ONE serial lane with a minimum gap between calls, a high-priority queue (hot refresh, trending) that jumps ahead of the
// low-priority full sweep, and a global pause on HTTP 429 (Retry-After when sent, else exponential backoff) so a rate limit never turns into a retry storm.
const cg = { hi: [], lo: [], busy: false, nextAt: 0, pausedUntil: 0, slow: 1, okStreak: 0, calls: [], rateLimited: 0, lastError: null };
const cgGap = () => (coingecko ? Z.gapMs.keyed : Z.gapMs.public) * cg.slow;

/** Request counters for the UI / reporting. `callsLast24h` counts every HTTP request made to CoinGecko, including retries. */
export function cgStats() {
  const cutoff = Date.now() - 86_400_000;
  while (cg.calls.length && cg.calls[0] < cutoff) cg.calls.shift();
  return { callsLast24h: cg.calls.length, rateLimited: cg.rateLimited, pausedUntil: cg.pausedUntil > Date.now() ? cg.pausedUntil : null, slowFactor: cg.slow, queued: cg.hi.length + cg.lo.length, plan: cgMode, lastError: cg.lastError };
}

async function cgRequest(path) {
  let lastErr;
  for (let attempt = 0; attempt <= Z.maxRetries; attempt++) {
    const modes = coingecko ? [cgMode, ...['demo', 'pro'].filter((m) => m !== cgMode)] : ['public'];
    let limited = null;
    for (const mode of modes) {
      const host = mode === 'pro' ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
      const headers = { accept: 'application/json' };
      if (mode === 'demo') headers['x-cg-demo-api-key'] = coingecko;
      if (mode === 'pro') headers['x-cg-pro-api-key'] = coingecko;
      try {
        cg.calls.push(Date.now());
        const res = await fetch(host + path, { headers, signal: AbortSignal.timeout(20_000) });
        if (res.ok) {
          cgMode = mode; cg.lastError = null;
          if (++cg.okStreak >= 25 && cg.slow > 1) { cg.slow = Math.max(1, cg.slow / 1.5); cg.okStreak = 0; }   // recover the normal pace after a quiet stretch
          return res.json();
        }
        lastErr = new Error(`coingecko ${mode} -> ${res.status}`);
        if (res.status === 429) { limited = res; break; }                 // the key is fine, we are just going too fast: do not try other plans
      } catch (e) { lastErr = e; }
    }
    cg.lastError = lastErr.message;
    if (limited) {
      const hdr = Number(limited.headers.get('retry-after'));
      const wait = Math.min(Z.backoffMaxMs, hdr > 0 ? hdr * 1000 : Z.backoffBaseMs * 2 ** attempt);
      cg.rateLimited++; cg.okStreak = 0; cg.slow = Math.min(4, cg.slow * 1.5);   // slow the whole lane down, not just this call
      cg.pausedUntil = Math.max(cg.pausedUntil, Date.now() + wait);
      warn(`CoinGecko rate limit (429): pausing all calls ${Math.round(wait / 1000)}s, then retrying (attempt ${attempt + 1}/${Z.maxRetries + 1})`);
      if (attempt === Z.maxRetries) break;
      await sleep(wait);
    } else {
      if (attempt >= 1) break;                                            // one quick retry for a network blip / 5xx, then give up
      await sleep(5_000);
    }
  }
  throw lastErr;
}

async function cgPump() {
  if (cg.busy) return;
  cg.busy = true;
  try {
    for (let job; (job = cg.hi.shift() ?? cg.lo.shift());) {
      const wait = Math.max(cg.nextAt, cg.pausedUntil) - Date.now();
      if (wait > 0) await sleep(wait);
      try { job.resolve(await cgRequest(job.path)); } catch (e) { job.reject(e); }
      cg.nextAt = Date.now() + cgGap();
    }
  } finally { cg.busy = false; }
}

/** priority 'hi' = hot refresh / trending, 'lo' = the full discovery sweep. */
function cgFetch(path, priority = 'hi') {
  return new Promise((resolve, reject) => { (priority === 'lo' ? cg.lo : cg.hi).push({ path, resolve, reject }); cgPump(); });
}

let cmcCache = { at: 0, map: null };
async function cmcTop100() {
  if (!coinmarketcap) return null;
  if (cmcCache.map && Date.now() - cmcCache.at < Z.cmcEveryMs) return cmcCache.map;   // ranks barely move: validate hourly, not every scan
  try {
    const res = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=300&convert=USD', {
      headers: { 'X-CMC_PRO_API_KEY': coinmarketcap, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`coinmarketcap -> ${res.status}`);
    const j = await res.json();
    const m = new Map();
    for (const c of j.data) m.set(c.symbol.toUpperCase(), c.cmc_rank);
    cmcCache = { at: Date.now(), map: m };
    return m;
  } catch (e) {
    warn('CoinMarketCap validation unavailable:', e.message);
    return cmcCache.map;                                                  // a stale ranking beats none
  }
}

const WRAPPED_RE = /wrapped|staked|bridged|lido|restaked|liquid staking/i;
const STABLE_RE = /usd|dollar|tether|stable|dai\b|eur\b/i;
function nonTradableReason(c) {
  if (c.current_price && Math.abs(c.current_price - 1) < 0.03 && (STABLE_RE.test(c.name) || STABLE_RE.test(c.symbol))) return 'stablecoin';
  if (WRAPPED_RE.test(c.name)) return 'wrapped/staked derivative';
  return null;
}

/** CoinGecko's trending list (top searched coins), as a set of CoinGecko ids. Cached; a failure returns the last good list. */
let trendingCache = { at: 0, set: new Set() };
export async function cgTrending() {
  if (trendingCache.at && Date.now() - trendingCache.at < Z.trendingEveryMs) return trendingCache.set;
  try { const j = await cgFetch('/search/trending', 'hi'); trendingCache = { at: Date.now(), set: new Set((j.coins ?? []).map((c) => c.item?.id).filter(Boolean)) }; }
  catch (e) { warn('CoinGecko trending unavailable:', e.message); trendingCache.at = Date.now() - Z.trendingEveryMs + 60_000; }   // retry in a minute, keep serving the old list
  return trendingCache.set;
}

export const universe = { coins: new Map(), updatedAt: 0, cmcAvailable: false, lastError: null, coinbaseMarkets: 0 };

const frac = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x) / 100);   // CoinGecko sends percentages

/** Stage 0 of the funnel: cheap data for EVERY coin CoinGecko lists (~8,500). Price, market cap, volume, 1h/24h/7d change.
 *  `at` = last full-sweep progress, `hotAt` / `tailAt` = last cheap refresh of the tradable coins (these run far more often than the sweep). */
export const radar = { rows: new Map(), at: 0, running: false, pages: 0, partial: false, nextPage: null, error: null, hotAt: 0, tailAt: 0, hotError: null };

const MARKETS = 'vs_currency=usd&order=market_cap_desc&per_page=250&sparkline=false&price_change_percentage=1h,24h,7d';

function rowFrom(c, prev, page, now) {
  return {
    id: c.id, symbol: String(c.symbol).toUpperCase(), name: c.name, cgRank: c.market_cap_rank, mcap: c.market_cap, price: c.current_price, vol24: c.total_volume,
    chg1h: frac(c.price_change_percentage_1h_in_currency), chg24h: frac(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h), chg7d: frac(c.price_change_percentage_7d_in_currency),
    prev: prev ? { price: prev.price, vol24: prev.vol24, at: prev.at } : null, at: now, _page: page, tradable: prev?.tradable ?? false,
  };
}

/** Full discovery sweep, 250 coins per page, low priority behind the cheap refreshes. Resumes from `from` after a rate limit instead of starting over. */
async function sweepRadar(from = 1, limit = Z.maxPages) {
  if (radar.running) return;
  radar.running = true;
  const next = new Map();
  let pages = 0, failedAt = null, lastErr = null;
  try {
    for (let n = from; n <= limit; n++) {
      let got;
      try { got = await cgFetch(`/coins/markets?${MARKETS}&page=${n}`, 'lo'); }   // the client already paces calls and backs off / retries on 429
      catch (e) { lastErr = e.message; failedAt = n; break; }
      if (!got.length) break;                                   // past the end of CoinGecko's list
      pages++;
      const now = Date.now();
      for (const c of got) next.set(c.id, rowFrom(c, radar.rows.get(c.id), n, now));
    }
    // Keep what we already knew about pages this run did not cover (earlier pages when resuming, or pages after a rate limit / short first sweep).
    const reached = failedAt ? failedAt - 1 : limit;
    for (const [id, row] of radar.rows) if (!next.has(id) && (row._page < from || row._page > reached)) next.set(id, row);
    if (next.size) {
      radar.rows = next; radar.at = Date.now(); radar.pages = from - 1 + pages;
      radar.nextPage = failedAt ?? (limit < Z.maxPages ? limit + 1 : null);
      radar.partial = radar.nextPage != null;
      radar.error = failedAt ? `rate limited at page ${failedAt} (${lastErr}): resuming there` : null;
    } else radar.error = lastErr ?? 'empty sweep';
  } finally { radar.running = false; }
  if (radar.error) warn('CoinGecko radar sweep:', radar.error);
  else log(`Radar sweep: ${radar.rows.size} coins monitored (${radar.pages} pages)`);
}

/**
 * Cheap refresh of specific coins (batched ids, 250 per call): price, market cap, volume and 1h/24h/7d change. Updates the radar rows AND the live
 * tradable-universe records in place, so priorities, the shortlist and the screens stay current between the slow full sweeps.
 * Returns the tradable coins that look unusual right now (1h move, or 24h volume jumping since their previous refresh) for immediate promotion.
 */
export async function refreshMarkets(ids) {
  const out = { updated: 0, unusual: [], error: null };
  const list = [...new Set(ids)].filter((id) => radar.rows.has(id));
  for (let i = 0; i < list.length; i += Z.idsPerCall) {
    let got;
    try { got = await cgFetch(`/coins/markets?${MARKETS}&ids=${list.slice(i, i + Z.idsPerCall).join(',')}&page=1`, 'hi'); }
    catch (e) { out.error = e.message; continue; }
    const now = Date.now();
    for (const c of got) {
      const prev = radar.rows.get(c.id);
      if (!prev) continue;
      const row = rowFrom(c, prev, prev._page, now);
      radar.rows.set(c.id, row); out.updated++;
      const coin = universe.coins.get(c.id);
      if (coin) Object.assign(coin, { price: row.price, priceAt: now, marketCap: row.mcap, mcap: row.mcap, volume24h: row.vol24 ?? 0, vol24: row.vol24, chg1h: row.chg1h, chg24h: row.chg24h, chg7d: row.chg7d, prev: row.prev, cgRank: row.cgRank ?? coin.cgRank });
      if (!coin) continue;                                      // only tradable coins can be promoted
      const jump = prev.vol24 > 0 && row.vol24 > 0 && now - prev.at <= 45 * 60_000 ? row.vol24 / prev.vol24 - 1 : 0;
      const reasons = [];
      if ((row.chg1h ?? 0) >= Z.promote1h) reasons.push(`1h +${(row.chg1h * 100).toFixed(1)}%`);
      if (jump >= Z.promoteVolJump && (row.chg1h ?? 0) >= 0) reasons.push(`24h volume +${(jump * 100).toFixed(0)}% since last refresh`);
      if (reasons.length) out.unusual.push({ id: c.id, symbol: coin.symbol, h1: row.chg1h ?? 0, reasons });
    }
  }
  return out;
}

/** Hot refresh: the shortlist + open positions (<= one call). Tail refresh: every other tradable coin. */
export async function refreshHot(ids) {
  const r = await refreshMarkets(ids);
  if (r.updated) radar.hotAt = Date.now();
  radar.hotError = r.error;
  return r;
}
export async function refreshTail(hotIds) {
  const hot = new Set(hotIds);
  const r = await refreshMarkets([...universe.coins.keys()].filter((id) => !hot.has(id)));
  if (r.updated) radar.tailAt = Date.now();
  return r;
}

/** Every online Coinbase USD market that CoinGecko can identify (and that is not a stablecoin / wrapped token), best market cap first. */
export async function refreshUniverse(productSet, gateMarkets = new Map()) {
  if (!radar.rows.size) {
    await sweepRadar(1, 3);                                      // the first 750 coins cover nearly every Coinbase market: start fast...
    if (radar.rows.size) sweepRadar(radar.nextPage ?? 4).catch((e) => warn('radar sweep', e.message));   // ...then finish the full sweep in the background (the scan never waits for it)
  } else if (!radar.running && Date.now() - radar.at > (radar.partial ? Z.retryMs : Z.everyMs)) sweepRadar(radar.partial ? (radar.nextPage ?? 1) : 1).catch((e) => warn('radar sweep', e.message));
  if (!radar.rows.size) { universe.lastError = radar.error; warn('CoinGecko universe refresh failed:', radar.error); return null; }   // keep the previous universe
  universe.lastError = null;
  const cmc = await cmcTop100();
  universe.cmcAvailable = !!cmc;

  const markets = [...radar.rows.values()].sort((a, b) => (a.cgRank ?? 1e9) - (b.cgRank ?? 1e9));
  const prevIds = new Set(universe.coins.keys());
  const next = new Map();
  const rows = [];
  const seenSymbols = new Set();
  let tradeRank = 0;
  for (const r of markets) r.tradable = false;
  for (const c of markets) {
    const symbol = c.symbol;
    // Coinbase USD first (WebSocket feed, deepest books); otherwise Gate.io USDT. A same-ticker coin priced very differently on Gate is a different asset: never mapped.
    const cb = `${symbol}-USD`, g = gateMarkets.get(String(symbol).toUpperCase());
    const gateOk = g && c.price > 0 && Math.abs(g.price / c.price - 1) <= 0.3;
    const product = productSet.has(cb) ? cb : gateOk ? g.product : null;
    const reason = nonTradableReason({ name: c.name, symbol, current_price: c.price }) || (product ? null : g ? 'ticker clash: Gate.io lists a differently priced coin under this symbol' : 'no Coinbase USD or Gate.io USDT market') || (seenSymbols.has(symbol) ? 'duplicate symbol' : null);
    if (reason) continue;                         // not tradable here: stays on the radar as watch-only
    seenSymbols.add(symbol); tradeRank++;
    c.tradable = true;
    const cmcRank = cmc?.get(symbol) ?? null;
    let discrepancy = false, note = null;
    if (cmc && c.cgRank != null && c.cgRank <= 300) {
      if (cmcRank == null) { discrepancy = true; note = `CoinGecko #${c.cgRank}, absent from CoinMarketCap top 300`; }
      else if (Math.abs(cmcRank - c.cgRank) > 5) { discrepancy = true; note = `CoinGecko #${c.cgRank} vs CoinMarketCap #${cmcRank}`; }
    }
    const prior = universe.coins.get(c.id);
    const coin = {
      id: c.id, symbol, name: c.name, rank: tradeRank, cgRank: c.cgRank, cmcRank, discrepancy, discrepancyNote: note,
      marketCap: c.mcap, mcap: c.mcap, price: c.price, priceAt: c.at, volume24h: c.vol24 ?? 0, vol24: c.vol24, chg1h: c.chg1h, chg24h: c.chg24h, chg7d: c.chg7d, prev: c.prev, product, venue: product.startsWith('GATE:') ? 'gate' : 'coinbase',
      tradable: true, excludedReason: null,
      cooldownUntil: prior?.cooldownUntil ?? null,
    };
    next.set(c.id, coin);
    rows.push({
      coingecko_id: c.id, symbol, name: c.name, cg_rank: c.cgRank, cmc_rank: cmcRank,
      rank_discrepancy: discrepancy, discrepancy_note: note, market_cap: c.mcap, price: c.price,
      coinbase_product: coin.product, tradable: coin.tradable, active: true, removed_at: null,
      last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }
  const added = [...next.keys()].filter((id) => !prevIds.has(id));
  const removed = [...prevIds].filter((id) => !next.has(id));
  universe.coins = next;
  universe.updatedAt = Date.now();
  universe.coinbaseMarkets = productSet.size; universe.gateMarkets = gateMarkets.size;
  if (!prevIds.size || added.length || removed.length || Date.now() - (universe.dbAt ?? 0) > 3600_000) { universe.dbAt = Date.now(); await db.upsertCoins(rows); await db.deactivateCoins(removed); }
  if (prevIds.size) { if (added.length || removed.length) log(`Universe refreshed: +${added.length} added, -${removed.length} removed (${next.size} tradable coins)`); }
  else log(`Universe loaded: ${next.size} tradable coins of ${radar.rows.size} monitored (${productSet.size} Coinbase USD markets, ${gateMarkets.size} Gate.io USDT markets)`);
  return { added: prevIds.size ? added : [], removed };
}

/** Biggest movers among coins that cannot be traded here: visible for context, never researched or entered. */
export function watchOnlyMovers(n = 12) {
  return [...radar.rows.values()].filter((r) => !r.tradable && (r.vol24 ?? 0) >= 1_000_000 && (r.mcap ?? 0) >= 5_000_000)
    .sort((a, b) => Math.max((b.chg1h ?? 0) * 3, b.chg24h ?? 0) - Math.max((a.chg1h ?? 0) * 3, a.chg24h ?? 0)).slice(0, n)
    .map((r) => ({ symbol: r.symbol, name: r.name, cgRank: r.cgRank, price: r.price, chg1h: r.chg1h, chg24h: r.chg24h, vol24: r.vol24 }));
}

// Restore stop-loss cooldowns persisted in Supabase after a restart.
export async function restoreCooldowns() {
  const rows = await db.loadCoins();
  for (const r of rows || []) {
    const c = universe.coins.get(r.coingecko_id);
    if (c && r.cooldown_until) c.cooldownUntil = new Date(r.cooldown_until).getTime();
  }
}
