// Dynamic Top 100 universe: CoinGecko is the ranking source, CoinMarketCap validates it.
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

const UNIVERSE_SIZE = 100;
/** CoinGecko's trending list (top searched coins), as a set of CoinGecko ids. Best-effort: empty on failure. */
export async function cgTrending() {
  try { const j = await cgFetch('/search/trending'); return new Set((j.coins ?? []).map((c) => c.item?.id).filter(Boolean)); }
  catch (e) { warn('CoinGecko trending unavailable:', e.message); return new Set(); }
}

export const universe = { coins: new Map(), updatedAt: 0, cmcAvailable: false, lastError: null };

export async function refreshUniverse(productSet) {
  let markets;
  try {
    // The universe is the 100 largest coins BY MARKET CAP THAT ARE TRADABLE here, so look past the plain top 100 (stablecoins,
    // wrapped tokens and coins with no Coinbase USD market are skipped). Page 2 is only fetched if page 1 doesn't yield 100.
    markets = await cgFetch('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false');
    const eligible = (list) => list.filter((c) => !nonTradableReason(c) && productSet.has(`${c.symbol.toUpperCase()}-USD`)).length;
    if (eligible(markets) < UNIVERSE_SIZE) markets = markets.concat(await cgFetch('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2&sparkline=false'));
  } catch (e) {
    universe.lastError = e.message;
    warn('CoinGecko top-100 refresh failed:', e.message);
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
    if (tradeRank >= UNIVERSE_SIZE) break;
    seenSymbols.add(symbol); tradeRank++;
    const cmcRank = cmc?.get(symbol) ?? null;
    let discrepancy = false, note = null;
    if (cmc) {
      if (cmcRank == null) { discrepancy = true; note = `CoinGecko #${c.market_cap_rank}, absent from CoinMarketCap top 300`; }
      else if (Math.abs(cmcRank - c.market_cap_rank) > 5) { discrepancy = true; note = `CoinGecko #${c.market_cap_rank} vs CoinMarketCap #${cmcRank}`; }
    }
    const prior = universe.coins.get(c.id);
    const coin = {
      id: c.id, symbol, name: c.name, rank: tradeRank, cgRank: c.market_cap_rank, cmcRank, discrepancy, discrepancyNote: note,
      marketCap: c.market_cap, price: c.current_price, product,
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
  await db.upsertCoins(rows);
  await db.deactivateCoins(removed);
  if (prevIds.size) log(`Universe refreshed: +${added.length} added, -${removed.length} removed, ${rows.filter((r) => r.rank_discrepancy).length} rank discrepancies`);
  else log(`Universe loaded: ${next.size} tradable coins (top ${UNIVERSE_SIZE} by market cap that Coinbase lists; deepest CoinGecko rank #${Math.max(...[...next.values()].map((c) => c.cgRank))})`);
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
