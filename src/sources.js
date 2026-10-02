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

/* ---------- Tier 2: derivatives. Coinglass first; OKX public perpetuals as an automatic, clearly-labelled fallback ---------- */
const cgCache = new Map(); // symbol -> { at, value }
let cgBlocked = null;      // { at, error } when Coinglass refused the key/plan; retried every 30 min

const OKX = 'https://www.okx.com/api/v5/public';
const oiHistory = [];      // [{ at, map: instId -> open interest USD }], kept ~2h
async function okxOpenInterest() {
  const last = oiHistory[oiHistory.length - 1];
  if (!last || Date.now() - last.at > 4 * 60_000) {
    const j = await getJson(`${OKX}/open-interest?instType=SWAP`);
    if (j.code !== '0') throw new Error('okx open-interest: ' + j.msg);
    oiHistory.push({ at: Date.now(), map: new Map(j.data.map((r) => [r.instId, Number(r.oiUsd)])) });
    while (oiHistory.length && Date.now() - oiHistory[0].at > 2 * 3600_000) oiHistory.shift();
  }
  return oiHistory;
}

async function okxDerivatives(symbol, cgError) {
  const instId = `${symbol}-USDT-SWAP`;
  try {
    const [fr, hist] = await Promise.all([getJson(`${OKX}/funding-rate?instId=${instId}`), okxOpenInterest()]);
    if (fr.code !== '0' || !fr.data?.[0]) throw new Error(`no OKX perpetual for ${symbol}`);
    const nowOi = hist[hist.length - 1].map.get(instId);
    const ref = hist.find((h) => Date.now() - h.at >= 55 * 60_000) ?? null; // needs ~1h of uptime before OI change exists
    const refOi = ref?.map.get(instId);
    return wrap(2, 'okx-public', {
      fundingRatePct: Number(fr.data[0].fundingRate) * 100,
      openInterestUsd: nowOi ?? null,
      oiChange1hPct: nowOi && refOi ? ((nowOi - refOi) / refOi) * 100 : null,
      oiChange24hPct: null,
    }, { fallbackFrom: { source: 'coinglass', error: cgError } });
  } catch (e) {
    return fail(2, 'okx-public', `${e.message} (coinglass: ${cgError})`);
  }
}

export async function derivatives(symbol) {
  const hit = cgCache.get(symbol);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  let value;
  if (!coinglass || (cgBlocked && Date.now() - cgBlocked.at < 30 * 60_000)) {
    value = await okxDerivatives(symbol, coinglass ? cgBlocked.error : 'COINGLASS_API_KEY not set');
    cgCache.set(symbol, { at: Date.now(), value });
    return value;
  }
  try {
    const h = { 'CG-API-KEY': coinglass };
    const base = 'https://open-api-v4.coinglass.com/api/futures';
    const [fr, oi] = await Promise.all([
      getJson(`${base}/funding-rate/exchange-list?symbol=${symbol}`, h),
      getJson(`${base}/open-interest/exchange-list?symbol=${symbol}`, h),
    ]);
    for (const r of [fr, oi]) if (r.code != null && String(r.code) !== '0') throw new Error(`coinglass ${r.code} ${r.msg}`);
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
    cgBlocked = { at: Date.now(), error: e.message };
    value = await okxDerivatives(symbol, e.message);
  }
  cgCache.set(symbol, { at: Date.now(), value });
  return value;
}

/* ---------- Tier 3: FRED macro ---------- */
let macroCache = null;
export async function macro() {
  if (!fred) return fail(3, 'fred', 'FRED_API_KEY not set');
  if (macroCache && Date.now() - macroCache.at < 6 * 3600_000) return macroCache.value;
  const series = { fed_funds_rate: 'DFF', us10y_yield: 'DGS10', us2y_yield: 'DGS2', vix: 'VIXCLS', cpi_index: 'CPIAUCSL', oil: 'DCOILWTICO', dollar: 'DTWEXBGS' };
  let value;
  try {
    const out = {};
    await Promise.all(Object.entries(series).map(async ([k, id]) => {
      const j = await getJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${fred}&file_type=json&sort_order=desc&limit=8`);
      const obs = (j.observations ?? []).filter((x) => x.value !== '.');
      const o = obs[0], old = obs.length > 4 ? obs[Math.min(5, obs.length - 1)] : null;   // ~one trading week back
      if (o) out[k] = { value: Number(o.value), asOf: o.date, ...(old && Number(old.value) > 0 ? { changePct: (Number(o.value) / Number(old.value) - 1) * 100 } : {}) };
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
    const j = await getJson(`https://api.congress.gov/v3/bill?api_key=${congress}&format=json&limit=250&sort=updateDate+desc`);
    const re = /crypto|digital asset|blockchain|stablecoin|bitcoin|virtual currency|CBDC|central bank digital|tariff|sanction|securities|commodit|derivative|financial technology|fintech|money laundering|bank secrecy|capital gains|federal reserve|debt ceiling|appropriations/i;
    const hits = (j.bills || []).filter((b) => re.test(b.title)).slice(0, 8)
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

/* ---------- Tier 3/4: political, regulatory, central-bank and general news feeds ---------- */
const safeUrl = (u) => (u && /^https?:\/\//i.test(u.trim()) ? decode(u.trim()) : null);
const strip = (s) => decode(String(s ?? '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Parse RSS (<item>) and Atom (<entry>) into { title, desc, link, publishedAt }. */
export function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const b = m[2];
    const pick = (tag) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(b)?.[1];
    const date = strip(pick('pubDate') ?? pick('published') ?? pick('updated') ?? pick('dc:date'));
    const link = /<link\b[^>]*>\s*([^<\s][^<]*)<\/link>/i.exec(b)?.[1] ?? /<link\b[^>]*href="([^"]+)"/i.exec(b)?.[1];
    out.push({ title: strip(pick('title')), desc: strip(pick('description') ?? pick('summary') ?? pick('content')), link: safeUrl(strip(link)), publishedAt: date ? Date.parse(date) || null : null });
  }
  return out;
}

const HOUR = 3600_000;
// tier 3 = official government / central-bank source, tier 4 = news organisation or unofficial mirror
const POLITICAL_FEEDS = [
  { name: 'White House: presidential actions', url: 'https://www.whitehouse.gov/presidential-actions/feed/', tier: 3, kind: 'executive', maxAgeH: 168, take: 6 },
  { name: 'Federal Reserve: press releases', url: 'https://www.federalreserve.gov/feeds/press_all.xml', tier: 3, kind: 'central_bank', maxAgeH: 72, take: 5 },
  { name: 'Federal Reserve: speeches', url: 'https://www.federalreserve.gov/feeds/speeches.xml', tier: 3, kind: 'central_bank', maxAgeH: 96, take: 4 },
  { name: 'SEC: press releases', url: 'https://www.sec.gov/news/pressreleases.rss', tier: 3, kind: 'regulator', maxAgeH: 96, take: 5 },
  { name: 'CFTC: press releases', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', tier: 3, kind: 'regulator', maxAgeH: 96, take: 4 },
  { name: 'BBC News: world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', tier: 4, kind: 'world', maxAgeH: 24, take: 6 },
  { name: 'NPR: politics', url: 'https://feeds.npr.org/1014/rss.xml', tier: 4, kind: 'politics', maxAgeH: 24, take: 6 },
  { name: 'CNBC: markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', tier: 4, kind: 'markets', maxAgeH: 24, take: 6 },
  { name: 'Google News: tariffs, sanctions, Fed, executive orders, war', url: 'https://news.google.com/rss/search?q=when:1d+(tariffs+OR+sanctions+OR+%22Federal+Reserve%22+OR+%22executive+order%22+OR+war+OR+election)&hl=en-US&gl=US&ceid=US:en', tier: 4, kind: 'politics', maxAgeH: 24, take: 10 },
  { name: 'Truth Social posts (unofficial mirror)', url: 'https://www.trumpstruth.org/feed', tier: 4, kind: 'social', maxAgeH: 24, take: 8, social: true },
];

async function readFeed(f) {
  const res = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 crypto-ai-lab', accept: 'application/rss+xml, application/xml, text/xml, */*' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const now = Date.now();
  const items = [];
  for (const it of parseFeed(await res.text())) {
    let title = it.title;
    if (f.social && /^\[No Title\]/i.test(title)) title = it.desc.slice(0, 280);      // the mirror puts the post text in the description
    if (!title) continue;                                                                    // image-only / empty posts
    if (it.publishedAt && now - it.publishedAt > f.maxAgeH * HOUR) continue;
    items.push({ source: f.name, tier: f.tier, kind: f.kind, title: title.slice(0, 300), url: it.link, publishedAt: it.publishedAt });
    if (items.length >= f.take) break;
  }
  return items;
}

async function federalRegisterOrders() {
  const res = await fetch('https://www.federalregister.gov/api/v1/documents.json?conditions[presidential_document_type][]=executive_order&order=newest&per_page=5', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const cutoff = Date.now() - 14 * 24 * HOUR;
  return (j.results ?? []).map((r) => ({
    source: 'Federal Register: executive orders', tier: 3, kind: 'executive', title: `Executive Order ${r.executive_order_number ?? ''}: ${r.title}`.replace('Order :', 'Order:'),
    url: safeUrl(r.html_url), publishedAt: Date.parse(r.signing_date || r.publication_date) || null,
  })).filter((i) => !i.publishedAt || i.publishedAt > cutoff);
}

let politicsCache = null;
export async function politics() {
  if (politicsCache && Date.now() - politicsCache.at < 10 * 60_000) return politicsCache.value;
  const items = [], feeds = [];
  const jobs = [...POLITICAL_FEEDS.map((f) => ({ name: f.name, tier: f.tier, run: () => readFeed(f) })), { name: 'Federal Register: executive orders', tier: 3, run: federalRegisterOrders }];
  await Promise.all(jobs.map(async (j) => {
    try { const got = await j.run(); items.push(...got); feeds.push({ name: j.name, tier: j.tier, ok: true, count: got.length, error: null }); }
    catch (e) { feeds.push({ name: j.name, tier: j.tier, ok: false, count: 0, error: e.message }); }
  }));
  items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  const failed = feeds.filter((f) => !f.ok);
  if (failed.length) warn('political feeds unavailable:', failed.map((f) => `${f.name} (${f.error})`).join('; '));
  const value = items.length ? wrap(3, 'political-feeds', items, { feeds }) : { ...fail(3, 'political-feeds', 'no feed returned items'), feeds };
  politicsCache = { at: Date.now(), value };
  return value;
}
