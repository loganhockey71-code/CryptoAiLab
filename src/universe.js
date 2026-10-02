// Dynamic tradable universe (every Coinbase USD market CoinGecko can identify): CoinGecko is the ranking source, CoinMarketCap validates the top 300.
import { config, log, warn } from './config.js';
import { db } from './db.js';

const { coingecko, coinmarketcap } = config.keys;
let cgMode = coingecko ? 'demo' : 'public'; // remembered after the first successful call

async function cgFetch(path) {
  const modes = coingecko ? [cgMode, ...['demo', 'pro'].filter((m) => m !== cgMode)] : ['public'];
  let lastErr;
  for (const mode of modes) {
    const host = mode === 'pro' ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
    const headers = { accept: 'application/json' };
    if (mode === 'demo') headers['x-cg-demo-api-key'] = coingecko;
    if (mode === 'pro') headers['x-cg-pro-api-key'] = coingecko;
    try {
      const res = await fetch(host + path, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.ok) { cgMode = mode; return res.json(); }
      lastErr = new Error(`coingecko ${mode} -> ${res.status}`);
      if (res.status === 429) break;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function cmcTop100() {
  if (!coinmarketcap) return null;
  try {
    const res = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=300&convert=USD', {
      headers: { 'X-CMC_PRO_API_KEY': coinmarketcap, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`coinmarketcap -> ${res.status}`);
    const j = await res.json();
    const m = new Map();
    for (const c of j.data) m.set(c.symbol.toUpperCase(), c.cmc_rank);
    return m;
  } catch (e) {
    warn('CoinMarketCap validation unavailable:', e.message);
    return null;
  }
}

const WRAPPED_RE = /wrapped|staked|bridged|lido|restaked|liquid staking/i;
const STABLE_RE = /usd|dollar|tether|stable|dai\b|eur\b/i;
function nonTradableReason(c) {
  if (c.current_price && Math.abs(c.current_price - 1) < 0.03 && (STABLE_RE.test(c.name) || STABLE_RE.test(c.symbol))) return 'stablecoin';
  if (WRAPPED_RE.test(c.name)) return 'wrapped/staked derivative';
  return null;
}

const Z = config.radar;
/** CoinGecko's trending list (top searched coins), as a set of CoinGecko ids. Best-effort: empty on failure. */
export async function cgTrending() {
  try { const j = await cgFetch('/search/trending'); return new Set((j.coins ?? []).map((c) => c.item?.id).filter(Boolean)); }
  catch (e) { warn('CoinGecko trending unavailable:', e.message); return new Set(); }
}

export const universe = { coins: new Map(), updatedAt: 0, cmcAvailable: false, lastError: null, coinbaseMarkets: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frac = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x) / 100);   // CoinGecko sends percentages

/** Stage 0 of the funnel: cheap data for EVERY coin CoinGecko lists (~8,200). Price, market cap, volume, 1h/24h/7d change. */
export const radar = { rows: new Map(), at: 0, running: false, pages: 0, partial: false, error: null };

async function sweepRadar(limit = Z.maxPages) {
  if (radar.running) return;
  radar.running = true;
  const next = new Map();
  let pages = 0, failedAt = null, lastErr = null;
  try {
    for (let n = 1; n <= limit; n++) {
      if (n > 1) await sleep(Z.pageDelayMs);
      let got = null;
      for (let attempt = 0; attempt < 2 && !got; attempt++) {
        try { got = await cgFetch(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${n}&sparkline=false&price_change_percentage=1h,24h,7d`); }
        catch (e) { lastErr = e.message; if (attempt === 0) await sleep(20_000); }
      }
      if (!got) { failedAt = n; break; }
      if (!got.length) break;                                   // past the end of CoinGecko's list
      pages++;
      const now = Date.now();
      for (const c of got) {
        const prev = radar.rows.get(c.id);
        next.set(c.id, {
          id: c.id, symbol: String(c.symbol).toUpperCase(), name: c.name, cgRank: c.market_cap_rank, mcap: c.market_cap, price: c.current_price, vol24: c.total_volume,
          chg1h: frac(c.price_change_percentage_1h_in_currency), chg24h: frac(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h), chg7d: frac(c.price_change_percentage_7d_in_currency),
          prev: prev ? { price: prev.price, vol24: prev.vol24, at: prev.at } : null, at: now, _page: n, tradable: prev?.tradable ?? false,
        });
      }
    }
    // Keep what we already knew about any pages this sweep did not reach (rate limit, or a short first sweep).
    const reached = failedAt ? failedAt - 1 : limit;
    for (const [id, row] of radar.rows) if (!next.has(id) && row._page > reached) next.set(id, row);
    if (next.size) { radar.rows = next; radar.at = Date.now(); radar.pages = pages; radar.partial = !!failedAt || limit < Z.maxPages; radar.error = failedAt ? `rate limited at page ${failedAt} (${lastErr})` : null; }
    else radar.error = lastErr ?? 'empty sweep';
  } finally { radar.running = false; }
  if (radar.error) warn('CoinGecko radar sweep:', radar.error);
  else log(`Radar sweep: ${radar.rows.size} coins monitored (${pages} pages)`);
}

/** Every online Coinbase USD market that CoinGecko can identify (and that is not a stablecoin / wrapped token), best market cap first. */
export async function refreshUniverse(productSet) {
  if (!radar.rows.size) {
    await sweepRadar(3);                                         // the first 750 coins cover nearly every Coinbase market: start fast...
    if (radar.rows.size) sweepRadar().catch((e) => warn('radar sweep', e.message));   // ...then finish the full sweep in the background
  } else if (Date.now() - radar.at > (radar.partial ? Z.retryMs : Z.everyMs) && !radar.running) sweepRadar().catch((e) => warn('radar sweep', e.message));
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
    const product = `${symbol}-USD`;
    const reason = nonTradableReason({ name: c.name, symbol, current_price: c.price }) || (productSet.has(product) ? null : 'no Coinbase USD market') || (seenSymbols.has(symbol) ? 'duplicate symbol' : null);
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
      marketCap: c.mcap, mcap: c.mcap, price: c.price, priceAt: c.at, volume24h: c.vol24 ?? 0, vol24: c.vol24, chg1h: c.chg1h, chg24h: c.chg24h, chg7d: c.chg7d, prev: c.prev, product,
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
  universe.coinbaseMarkets = productSet.size;
  if (!prevIds.size || added.length || removed.length || Date.now() - (universe.dbAt ?? 0) > 3600_000) { universe.dbAt = Date.now(); await db.upsertCoins(rows); await db.deactivateCoins(removed); }
  if (prevIds.size) { if (added.length || removed.length) log(`Universe refreshed: +${added.length} added, -${removed.length} removed (${next.size} tradable coins)`); }
  else log(`Universe loaded: ${next.size} tradable coins of ${radar.rows.size} monitored (${productSet.size} Coinbase USD markets)`);
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
