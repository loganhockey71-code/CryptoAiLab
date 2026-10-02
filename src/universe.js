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

const U = config.universe;
/** CoinGecko's trending list (top searched coins), as a set of CoinGecko ids. Best-effort: empty on failure. */
export async function cgTrending() {
  try { const j = await cgFetch('/search/trending'); return new Set((j.coins ?? []).map((c) => c.item?.id).filter(Boolean)); }
  catch (e) { warn('CoinGecko trending unavailable:', e.message); return new Set(); }
}

export const universe = { coins: new Map(), updatedAt: 0, cmcAvailable: false, lastError: null, coinbaseMarkets: 0 };

const page = (n) => cgFetch(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${n}&sparkline=false`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let deep = { at: 0, rows: [] };   // CoinGecko pages 3+ (smaller coins), refreshed hourly

/** Every online Coinbase USD market that CoinGecko can identify (and that is not a stablecoin / wrapped token), best market cap first. */
export async function refreshUniverse(productSet) {
  let markets;
  try {
    const top = [...await page(1), ...await page(2)].map((c) => ({ ...c, _at: Date.now() }));
    if (Date.now() - deep.at > U.fullRefreshMs || !deep.rows.length) {
      const rows = [], matched = new Set();
      const want = new Set([...productSet].map((p) => p.replace(/-USD$/, '')));
      for (const c of top) if (productSet.has(`${c.symbol.toUpperCase()}-USD`)) matched.add(c.symbol.toUpperCase());
      let partial = false;
      for (let n = 3; n <= U.maxPages && matched.size < want.size; n++) {
        await sleep(U.pageDelayMs);
        let got = null;
        for (let attempt = 0; attempt < 2 && !got; attempt++) {
          try { got = await page(n); } catch (e) { if (attempt === 0) await sleep(20_000); else warn(`CoinGecko page ${n} failed (${e.message})`); }
        }
        if (!got) { partial = true; rows.push(...deep.rows.filter((r) => r._page >= n)); break; }   // keep the deeper coins we already knew about
        for (const c of got) { rows.push({ ...c, _at: Date.now(), _page: n }); if (productSet.has(`${c.symbol.toUpperCase()}-USD`)) matched.add(c.symbol.toUpperCase()); }
      }
      // After a partial pull, try the missing pages again in ~5 minutes instead of waiting a full hour.
      if (rows.length || !deep.rows.length) deep = { at: partial ? Date.now() - U.fullRefreshMs + 5 * 60_000 : Date.now(), rows };
    }
    const seen = new Set(top.map((c) => c.id));
    markets = top.concat(deep.rows.filter((c) => !seen.has(c.id)));
  } catch (e) {
    universe.lastError = e.message;
    warn('CoinGecko universe refresh failed:', e.message);
    return null; // keep the previous universe rather than guessing
  }
  universe.lastError = null;
  const cmc = await cmcTop100();
  universe.cmcAvailable = !!cmc;

  const prevIds = new Set(universe.coins.keys());
  const next = new Map();
  const rows = [];
  const seenSymbols = new Set();
  let tradeRank = 0;
  for (const c of markets) {
    const symbol = c.symbol.toUpperCase();
    const product = `${symbol}-USD`;
    const reason = nonTradableReason(c) || (productSet.has(product) ? null : 'no Coinbase USD market') || (seenSymbols.has(symbol) ? 'duplicate symbol' : null);
    if (reason) continue;                         // not tradable: not part of the universe
    if (tradeRank >= U.maxCoins) break;
    seenSymbols.add(symbol); tradeRank++;
    const cmcRank = cmc?.get(symbol) ?? null;
    let discrepancy = false, note = null;
    if (cmc && c.market_cap_rank <= 300) {
      if (cmcRank == null) { discrepancy = true; note = `CoinGecko #${c.market_cap_rank}, absent from CoinMarketCap top 300`; }
      else if (Math.abs(cmcRank - c.market_cap_rank) > 5) { discrepancy = true; note = `CoinGecko #${c.market_cap_rank} vs CoinMarketCap #${cmcRank}`; }
    }
    const prior = universe.coins.get(c.id);
    const coin = {
      id: c.id, symbol, name: c.name, rank: tradeRank, cgRank: c.market_cap_rank, cmcRank, discrepancy, discrepancyNote: note,
      marketCap: c.market_cap, price: c.current_price, priceAt: c._at, volume24h: c.total_volume ?? 0, product,
      tradable: true, excludedReason: null,
      cooldownUntil: prior?.cooldownUntil ?? null,
    };
    next.set(c.id, coin);
    rows.push({
      coingecko_id: c.id, symbol, name: c.name, cg_rank: c.market_cap_rank, cmc_rank: cmcRank,
      rank_discrepancy: discrepancy, discrepancy_note: note, market_cap: c.market_cap, price: c.current_price,
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
  else log(`Universe loaded: ${next.size} tradable coins = every coin with a Coinbase USD market that CoinGecko identifies (${productSet.size} Coinbase USD markets; deepest CoinGecko rank #${Math.max(...[...next.values()].map((c) => c.cgRank))})`);
  return { added: prevIds.size ? added : [], removed };
}

// Restore stop-loss cooldowns persisted in Supabase after a restart.
export async function restoreCooldowns() {
  const rows = await db.loadCoins();
  for (const r of rows || []) {
    const c = universe.coins.get(r.coingecko_id);
    if (c && r.cooldown_until) c.cooldownUntil = new Date(r.cooldown_until).getTime();
  }
}
