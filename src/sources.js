// Context sources with explicit reliability tiers + timestamps (provenance for every datum).
// Tier 1: exchange feed (exchange.js) | Tier 2: Coinglass derivatives | Tier 3: FRED / Congress.gov | Tier 4: news / on-chain.
import { config, warn } from './config.js';

const { coinglass, fred, congress, etherscan } = config.keys;

async function getJson(url, headers = {}, timeoutMs = 15_000) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} -> ${res.status}`);
  return res.json();
}

const wrap = (tier, source, data, extra = {}) => ({ tier, source, fetchedAt: Date.now(), ok: true, data, ...extra });
const fail = (tier, source, error) => ({ tier, source, fetchedAt: Date.now(), ok: false, data: null, error });

/* ---------- Tier 2: Coinglass (funding rate, open interest) ---------- */
const cgCache = new Map(); // symbol -> { at, value }
export async function derivatives(symbol) {
  if (!coinglass) return fail(2, 'coinglass', 'COINGLASS_API_KEY not set');
  const hit = cgCache.get(symbol);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  let value;
  try {
    const h = { 'CG-API-KEY': coinglass };
    const base = 'https://open-api-v4.coinglass.com/api/futures';
    const [fr, oi] = await Promise.all([
      getJson(`${base}/funding-rate/exchange-list?symbol=${symbol}`, h),
      getJson(`${base}/open-interest/exchange-list?symbol=${symbol}`, h),
    ]);
    const frRows = fr.data?.find?.((d) => d.symbol === symbol)?.stablecoin_margin_list ?? fr.data ?? [];
    const rates = (Array.isArray(frRows) ? frRows : []).map((r) => Number(r.funding_rate)).filter(Number.isFinite);
    const oiAll = Array.isArray(oi.data) ? oi.data.find((d) => d.exchange === 'All') : null;
    if (!rates.length && !oiAll) throw new Error('no usable Coinglass rows');
    value = wrap(2, 'coinglass', {
      fundingRatePct: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null, // % per interval, averaged across exchanges
      openInterestUsd: oiAll ? Number(oiAll.open_interest_usd) : null,
      oiChange1hPct: oiAll ? Number(oiAll.open_interest_change_percent_1h) : null,
      oiChange24hPct: oiAll ? Number(oiAll.open_interest_change_percent_24h) : null,
    });
  } catch (e) {
    value = fail(2, 'coinglass', e.message);
  }
  cgCache.set(symbol, { at: Date.now(), value });
  return value;
}

/* ---------- Tier 3: FRED macro ---------- */
let macroCache = null;
export async function macro() {
  if (!fred) return fail(3, 'fred', 'FRED_API_KEY not set');
  if (macroCache && Date.now() - macroCache.at < 6 * 3600_000) return macroCache.value;
  const series = { fed_funds_rate: 'DFF', us10y_yield: 'DGS10', us2y_yield: 'DGS2', vix: 'VIXCLS', cpi_index: 'CPIAUCSL' };
  let value;
  try {
    const out = {};
    await Promise.all(Object.entries(series).map(async ([k, id]) => {
      const j = await getJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${fred}&file_type=json&sort_order=desc&limit=5`);
      const o = j.observations?.find((x) => x.value !== '.');
      if (o) out[k] = { value: Number(o.value), asOf: o.date };
    }));
    if (!Object.keys(out).length) throw new Error('no observations');
    value = wrap(3, 'fred', out);
  } catch (e) { value = fail(3, 'fred', e.message); }
  macroCache = { at: Date.now(), value };
  return value;
}

/* ---------- Tier 3: Congress.gov crypto-related legislation ---------- */
let billsCache = null;
export async function legislation() {
  if (!congress) return fail(3, 'congress.gov', 'CONGRESS_KEY not set');
  if (billsCache && Date.now() - billsCache.at < 6 * 3600_000) return billsCache.value;
  let value;
  try {
    const j = await getJson(`https://api.congress.gov/v3/bill?api_key=${congress}&format=json&limit=100&sort=updateDate+desc`);
    const re = /crypto|digital asset|blockchain|stablecoin|bitcoin|virtual currency/i;
    const hits = (j.bills || []).filter((b) => re.test(b.title)).slice(0, 5)
      .map((b) => ({ title: b.title, latestAction: b.latestAction?.text, actionDate: b.latestAction?.actionDate, number: `${b.type} ${b.number}` }));
    value = wrap(3, 'congress.gov', hits);
  } catch (e) { value = fail(3, 'congress.gov', e.message); }
  billsCache = { at: Date.now(), value };
  return value;
}

/* ---------- Tier 4: Etherscan (market-wide on-chain pulse; per-token whale flow is not wired) ---------- */
let gasCache = null;
export async function onchain() {
  if (!etherscan) return fail(4, 'etherscan', 'ETHERSCAN_API_KEY not set');
  if (gasCache && Date.now() - gasCache.at < 10 * 60_000) return gasCache.value;
  let value;
  try {
    const j = await getJson(`https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${etherscan}`);
    if (j.status !== '1') throw new Error(String(j.result).slice(0, 80));
    value = wrap(4, 'etherscan', { ethGasGwei: { safe: Number(j.result.SafeGasPrice), fast: Number(j.result.FastGasPrice) } });
  } catch (e) { value = fail(4, 'etherscan', e.message); }
  gasCache = { at: Date.now(), value };
  return value;
}

/* ---------- Tier 4: reputable news RSS + lexicon sentiment ---------- */
const FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
];
const POS = ['surge', 'rally', 'soar', 'gain', 'bullish', 'approve', 'approval', 'adopt', 'record high', 'breakout', 'inflow', 'partnership', 'upgrade', 'launch', 'etf approved', 'jumps', 'climbs'];
const NEG = ['plunge', 'crash', 'drop', 'bearish', 'hack', 'exploit', 'lawsuit', 'ban', 'reject', 'outflow', 'liquidat', 'sell-off', 'selloff', 'fraud', 'delist', 'sec sues', 'falls', 'slump', 'tumbles'];
const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;|&gt;/g, '').trim();

export function scoreHeadline(title) {
  const t = title.toLowerCase();
  let s = 0;
  for (const w of POS) if (t.includes(w)) s++;
  for (const w of NEG) if (t.includes(w)) s--;
  return Math.max(-1, Math.min(1, s));
}

let newsCache = null;
export async function news() {
  if (newsCache && Date.now() - newsCache.at < 10 * 60_000) return newsCache.value;
  const items = [];
  const errors = [];
  await Promise.all(FEEDS.map(async (f) => {
    try {
      const res = await fetch(f.url, { headers: { 'User-Agent': 'crypto-ai-lab/1.0' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${f.name} -> ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const title = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1];
        const date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1])?.[1];
        if (title) items.push({ source: f.name, title: decode(title), publishedAt: date ? new Date(date).getTime() : null });
      }
    } catch (e) { errors.push(e.message); }
  }));
  const cutoff = Date.now() - 24 * 3600_000;
  const recent = items.filter((i) => !i.publishedAt || i.publishedAt > cutoff)
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).slice(0, 60)
    .map((i) => ({ ...i, sentiment: scoreHeadline(i.title) }));
  const value = recent.length ? wrap(4, 'news-rss', recent) : fail(4, 'news-rss', errors.join('; ') || 'no items');
  if (errors.length && recent.length) warn('news feed partial failure:', errors.join('; '));
  newsCache = { at: Date.now(), value };
  return value;
}

// Per-coin sentiment from headlines that mention the coin (null when nothing mentions it).
export function coinSentiment(newsResult, coin) {
  if (!newsResult?.ok) return null;
  const sym = new RegExp(`\\b${coin.symbol}\\b`, 'i');
  const name = new RegExp(`\\b${coin.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const hits = newsResult.data.filter((n) => name.test(n.title) || (coin.symbol.length >= 3 && sym.test(n.title)));
  if (!hits.length) return null;
  return { score: hits.reduce((a, h) => a + h.sentiment, 0) / hits.length, count: hits.length, headlines: hits.slice(0, 3).map((h) => h.title) };
}
