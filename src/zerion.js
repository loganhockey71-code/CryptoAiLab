// READ-ONLY Zerion API client + on-chain trade parsing/scoring. Auth: HTTP Basic with the API key as the username.
import { config, warn } from './config.js';
import { summarize } from './traders.js';

const BASE = 'https://api.zerion.io';
const KEY = config.keys.zerion;
export const zerionEnabled = !!KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two spaced queues (history scoring vs live polling) so scoring hundreds of wallets can't starve live detection.
const chains = { bulk: Promise.resolve(), live: Promise.resolve() };
const gaps = { bulk: 1300, live: 450 };
function queued(kind, fn) {
  const p = chains[kind].then(fn);
  chains[kind] = p.then(() => sleep(gaps[kind]), () => sleep(gaps[kind]));
  return p;
}

async function request(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', authorization: 'Basic ' + Buffer.from(`${KEY}:`).toString('base64') },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429 && attempt < 4) { await sleep(3000 * (attempt + 1)); return request(url, attempt + 1); }
  if (res.status === 401 || res.status === 403) throw new Error('Zerion rejected the API key (check ZERION_API_KEY in .env)');
  if (!res.ok) throw new Error(`zerion ${new URL(url).pathname} -> ${res.status}`);
  return res.json();
}
const get = (url, live) => queued(live ? 'live' : 'bulk', () => request(url));

/** Decoded swaps for a wallet since `sinceMs` (newest first from the API). */
export async function fetchTrades(address, sinceMs, { live = false, maxPages = 8 } = {}) {
  let url = `${BASE}/v1/wallets/${address}/transactions/?currency=usd&page[size]=100&filter[operation_types]=trade&filter[asset_types]=fungible&filter[trash]=only_non_trash&filter[min_mined_at]=${Math.floor(sinceMs)}`;
  const out = [];
  for (let i = 0; i < maxPages && url; i++) {
    const j = await get(url, live);
    out.push(...(j.data ?? []));
    url = j.links?.next || null;
  }
  return out;
}

export async function getPortfolioValue(address, { live = false } = {}) {
  const j = await get(`${BASE}/v1/wallets/${address}/portfolio?currency=usd`, live);
  return Number(j.data?.attributes?.total?.positions ?? 0);
}

/** Current wallet token holdings (not paginated). */
export async function getPositions(address, { live = false } = {}) {
  const j = await get(`${BASE}/v1/wallets/${address}/positions/?currency=usd&filter[positions]=only_simple&filter[position_types]=wallet&filter[trash]=only_non_trash`, live);
  return (j.data ?? []).map((p) => {
    const a = p.attributes, chain = p.relationships?.chain?.data?.id;
    return { fungibleId: a.fungible_info?.id, symbol: a.fungible_info?.symbol, chain, qty: Number(a.quantity?.float ?? 0), value: Number(a.value ?? 0) };
  });
}

/* ------------------------------------------------------------------ parsing */

// Stablecoins and gas/major assets are "base" money: we score and copy trades in OTHER tokens against them.
const STABLE_RE = /^(USDC|USDT|DAI|USDE|USDS|FDUSD|PYUSD|TUSD|USDD|FRAX|LUSD|GUSD|USD\+|CRVUSD|USDBC|USDC\.E|USDT0|SUSD|EURC|EURS|USR)$/i;
const MAJOR_RE = /^(ETH|WETH|SOL|WSOL|BNB|WBNB|POL|WPOL|MATIC|WMATIC|AVAX|WAVAX|WBTC|CBBTC|BTC|STETH|WSTETH|WEETH|CBETH|RETH)$/i;
export const isBase = (symbol) => STABLE_RE.test(symbol ?? '') || MAJOR_RE.test(symbol ?? '');

function leg(t, chain) {
  const f = t.fungible_info, qty = Number(t.quantity?.float), usd = Number(t.value);
  const impl = f.implementations?.find((i) => i.chain_id === chain) ?? null;
  const address = impl?.address ?? null;
  return {
    fungibleId: f.id, symbol: f.symbol, chain, address, qty, usd,
    px: Number(t.price) || (qty ? usd / qty : 0),
    key: address ? `${chain}:${String(address).toLowerCase()}` : `${chain}:native:${f.symbol}`,
    base: isBase(f.symbol),
  };
}

/** Normalise a Zerion transaction into { id, at, chain, outs[], ins[], feeUsd } or null if it isn't a usable confirmed swap. */
export function parseTrade(tx) {
  const a = tx?.attributes;
  if (!a || a.operation_type !== 'trade' || a.status !== 'confirmed' || a.flags?.is_trash) return null;
  const chain = tx.relationships?.chain?.data?.id;
  const ok = (a.transfers ?? []).filter((t) => t.fungible_info && Number(t.quantity?.float) > 0 && t.value != null && Number(t.value) > 0);
  const outs = ok.filter((t) => t.direction === 'out').map((t) => leg(t, chain));
  const ins = ok.filter((t) => t.direction === 'in').map((t) => leg(t, chain));
  if (!outs.length || !ins.length) return null;
  return { id: tx.id, hash: a.hash, at: Date.parse(a.mined_at), chain, outs, ins, feeUsd: Number(a.fee?.value ?? 0) };
}

/**
 * Average-cost accounting per token. A "trade" is one SELL of a non-base token whose purchase we saw in the window;
 * net = USD proceeds - average USD cost - gas. Sells with no known basis (airdrops, pre-window buys) are ignored, not counted as wins.
 * Returns { closings: [{ time, net, key, symbol }], book: Map(key -> { qty, cost, symbol, fungibleId }) }.
 */
export function scoreTrades(trades, minTradeUsd = config.zerion.minTradeUsd) {
  const book = new Map();
  const closings = [];
  for (const tr of [...trades].sort((a, b) => a.at - b.at)) {
    const legs = [...tr.outs, ...tr.ins].filter((l) => !l.base).length || 1;
    const fee = tr.feeUsd / legs;
    for (const out of tr.outs) {
      if (out.base) continue;
      const b = book.get(out.key);
      if (!b || b.qty <= 0 || out.usd < minTradeUsd) continue;
      const sold = Math.min(out.qty, b.qty), frac = sold / out.qty;
      const cost = b.cost * (sold / b.qty);
      closings.push({ time: tr.at, net: out.usd * frac - fee - cost, key: out.key, symbol: out.symbol });
      b.qty -= sold; b.cost -= cost;
    }
    for (const inn of tr.ins) {
      if (inn.base) continue;
      const b = book.get(inn.key) ?? { qty: 0, cost: 0, symbol: inn.symbol, fungibleId: inn.fungibleId };
      b.qty += inn.qty; b.cost += inn.usd + fee;
      book.set(inn.key, b);
    }
  }
  return { closings, book };
}

export { summarize };
