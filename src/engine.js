// Scan -> validate -> analyze -> candidate -> candle confirm -> risk filter -> enter -> monitor -> trail -> exit -> P&L -> post-mortem -> lessons -> resume.
// PAPER ONLY: this module never talks to any order endpoint. Positions are simulated in memory + Supabase.
import { config, log, warn } from './config.js';
import { db } from './db.js';
import { feed, fetchCandles, loadProducts, loadGateMarkets, fetchBook } from './exchange.js';
import { hl } from './hyperliquid.js';
import { onchainPx } from './onchainprices.js';
import { refreshUniverse, restoreCooldowns, universe, cgTrending, radar as radarState, watchOnlyMovers, refreshHot, refreshTail, cgStats } from './universe.js';
import * as radarLib from './radar.js';
import { snapshot, aggregate, rvol as calcRvol, atr, ema, rsi, candlePattern } from './indicators.js';
import * as src from './sources.js';
import { reflectOnTrade, reviewDecision, llmAvailable, llmUsable, llmResumeAt, llmProviders, llmStats } from './research.js';
import { analyzeAll } from './structure.js';
import * as brain from './brain.js';
import * as newsimpact from './newsimpact.js';
import * as learning from './learning.js';
import * as discovery from './discovery.js';
import * as riskLib from './risk.js';
import { downtrendSignal } from './exits.js';
import { guard } from './guardrails.js';

const R = config.risk;
const U = config.universe, Z = config.radar;
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => (x * 100).toFixed(2) + '%';

export const state = {
  portfolio: null,
  coins: new Map(),            // symbol -> per-coin analysis state
  btc: { regime: 'unknown', bullish: false },
  positions: new Map(),        // trade id -> position
  pending: new Map(),          // signal id -> awaiting candle confirmation
  decisions: [],               // newest first (decision log panel)
  reflections: [],             // newest first (AI learning feed)
  closedToday: [],             // closed trades since UTC midnight
  recentClosed: [],            // newest first, feeds the Trade History panel
  shortlist: { size: 0, top: [] },   // stage 1 of the funnel: coins that get candle analysis every scan
  researchQueue: [],           // stage 2: the coins deeply researched in the latest scan
  rejected: {},                // why coins were screened out as illiquid / manipulated-looking / unreliable (latest scan)
  closedTotal: 0,              // every trade ever closed (top-bar counter; recentClosed is capped at 200)
  trending: new Set(),         // CoinGecko trending ids, refreshed every scan
  ctx: null,                   // latest news/macro/politics context, reused by the fast mover scan
  newsFeed: { at: null, feeds: [], items: [] },   // everything the app read this scan (News & Politics panel)
  freezeKeys: new Set(),       // breaker events that have already caused a freeze (so one event can never re-freeze)
  copyCooldown: new Map(),     // coin -> until (2h lockout after a copied position hits its stop)
  rescore: new Set(),          // trader addresses whose win rate must be re-evaluated now (3rd straight loss, or manual release)
  brain: { at: null, regime: null, market: null, env: null, events: [], opportunities: [], avoid: [], watch: [], counts: {}, analysed: 0, byClass: {} },   // the Brain's latest read of the whole market
  scan: { running: false, startedAt: null, finishedAt: null, count: 0, lastError: null, progress: '' },
  sources: {},                 // name -> { tier, ok, fetchedAt, error }
  productSet: new Set(),
  productsAt: 0,
};

/* ------------------------------------------------------------------ helpers */

export function logDecision(type, symbol, message, extra = {}) {
  state.decisions.unshift({ at: Date.now(), type, symbol, message, ...extra });
  if (state.decisions.length > 300) state.decisions.length = 300;
}

const coinState = (symbol) => {
  let c = state.coins.get(symbol);
  if (!c) { c = { symbol, snaps: {}, rvol: null, atr15: null, deriv: null, sentiment: null, health: { ok: false, reason: 'not scanned yet' }, brain: null, ta: null, patterns: {} }; state.coins.set(symbol, c); }
  return c;
};

function noteSource(r) {
  if (!r) return;
  if (r.feeds) for (const f of r.feeds) state.sources[f.name] = { tier: f.tier, ok: f.ok, fetchedAt: r.fetchedAt, error: f.error };
  if (r.fallbackFrom) state.sources[r.fallbackFrom.source] = { tier: r.tier, ok: false, fetchedAt: r.fetchedAt, error: `${r.fallbackFrom.error}: using ${r.source} instead` };
  state.sources[r.source] = { tier: r.tier, ok: r.ok, fetchedAt: r.fetchedAt, error: r.error ?? null };
}

function priceOf(pos) {
  if (pos.venue === 'hl') return hl.mid(pos.coin) ?? pos.lastPrice ?? pos.entry;
  if (pos.venue === 'onchain') return onchainPx.get(pos.coin)?.px ?? pos.lastPrice ?? pos.entry;
  return feed.price(pos.product) ?? pos.lastPrice ?? pos.entry;
}
const unrealizedGross = (pos, px) => pos.qty * (pos.side === 'short' ? pos.entry - px : px - pos.entry);

export function markEquity() {
  const p = state.portfolio;
  let eq = p.cash;
  for (const pos of state.positions.values()) eq += pos.notional + unrealizedGross(pos, priceOf(pos));
  p.equity = eq;
  return eq;
}

let saveTimer = null;
export function persistPortfolio(now = false) {
  const go = () => { saveTimer = null; markEquity(); return db.savePortfolio(state.portfolio); };
  if (now) { clearTimeout(saveTimer); return go(); }
  if (!saveTimer) saveTimer = setTimeout(go, 3000);
}

/* ------------------------------------------------------------------- scan */

async function analyzeCoin(coin) {
  const cs = coinState(coin.symbol);
  cs.coin = coin;
  try {
    const [d1, h1, m15, m5] = [
      await fetchCandles(coin.product, 86400),
      await fetchCandles(coin.product, 3600),
      await fetchCandles(coin.product, 900),
      await fetchCandles(coin.product, 300),
    ];
    const last5 = m5[m5.length - 1];
    const ageMin = (Date.now() / 1000 - last5.t) / 60;
    const priceDiff = Math.abs(last5.c - coin.price) / coin.price;
    if (ageMin > 20) cs.health = { ok: false, reason: `stale candles (${ageMin.toFixed(0)}m old)` };
    else if (priceDiff > ((Date.now() - (coin.priceAt ?? 0)) < 10 * 60_000 ? 0.15 : 0.40)) cs.health = { ok: false, reason: `contradictory price: exchange ${last5.c} vs reference ${coin.price} (${(priceDiff * 100).toFixed(0)}% apart: the data is clearly broken)` };
    else cs.health = { ok: true, reason: null, warn: priceDiff > ((Date.now() - (coin.priceAt ?? 0)) < 10 * 60_000 ? 0.05 : 0.15) ? `exchange price ${last5.c} differs ${(priceDiff * 100).toFixed(1)}% from the reference price ${coin.price} (warning, not a rejection)` : null, checkedAt: Date.now() };
    cs.ta = analyzeAll({ d1, h1, m15, m5 });                       // swings, levels, ranges, candle patterns, buyer/seller pressure per timeframe (structure.js)
    cs.h1series = h1.slice(-50).map((c) => ({ t: c.t, h: c.h, l: c.l, c: c.c }));   // for news priced-in checks and the missed-move review
    cs.snaps = { '1d': snapshot(d1), '4h': snapshot(aggregate(h1, 4 * 3600)), '1h': snapshot(h1), '15m': snapshot(m15), '5m': snapshot(m5) };
    cs.rvol = calcRvol(m15);
    cs.atr15 = atr(m15);
    cs.atr1h = atr(h1);
    cs.patterns = { '5m': candlePattern(m5), '1h': candlePattern(h1) };
    cs.priceUp = m15.length > 2 && m15[m15.length - 1].c > m15[m15.length - 3].c;
    cs.series5m = m5.slice(-30).map((c) => ({ t: c.t, c: c.c }));
    const change = (arr, n) => (arr.length > n ? arr[arr.length - 1].c / arr[arr.length - 1 - n].c - 1 : 0);
    cs.chg = { m15: change(m5, 3), h1: change(m5, 12), h4: change(h1, 4), h24: change(h1, 24) };
    if (coin.symbol === 'BTC') {
      state.btc = { ...riskLib.btcRegime(cs.snaps['1h']), at: Date.now() };
    }
  } catch (e) {
    cs.health = { ok: false, reason: `candle fetch failed: ${e.message}` };
    warn('analyze', coin.symbol, e.message);
  }
}

async function runScan() {
  const s = state.scan;
  s.running = true; s.startedAt = Date.now(); s.lastError = null; s.progress = 'refreshing universe';
  try {
    if (Date.now() - state.productsAt > 3600_000 || !state.productSet.size) {
      state.productSet = await loadProducts(); state.productsAt = Date.now();
      try { state.gateMarkets = await loadGateMarkets(); } catch (e) { warn('Gate.io markets unavailable (keeping the previous list):', e.message); }
    }
    const changes = await refreshUniverse(state.productSet, state.gateMarkets ?? new Map());
    if (changes) {
      for (const id of changes.added) { const c = universe.coins.get(id); logDecision('info', c.symbol, `entered the tradable universe (market-cap rank #${c.cgRank})`); }
      for (const id of changes.removed) logDecision('info', id, 'dropped out of the tradable universe');
    }
    if (!universe.coins.size) throw new Error(`no universe available (${universe.lastError ?? 'unknown'})`);
    await restoreCooldowns();

    const tradable = [...universe.coins.values()].filter((c) => c.tradable);
    const products = new Set(tradable.map((c) => c.product));
    for (const pos of state.positions.values()) if (pos.product) products.add(pos.product);
    feed.setProducts([...products]);
    feed.setHot([...state.positions.values(), ...state.pending.values()].map((x) => x.product).filter(Boolean));

    // BTC first so the regime gate is current before anything else is evaluated.
    tradable.sort((a, b) => (a.symbol === 'BTC' ? -1 : b.symbol === 'BTC' ? 1 : a.cgRank - b.cgRank));
    for (const c of tradable) coinState(c.symbol).coin = c;
    state.mkt = marketMoves();                                    // market / BTC / ETH moves: the yardstick for relative strength in the ranking
    const prio = new Map(tradable.map((c) => [c.symbol, priorityOf(state.coins.get(c.symbol))]));
    for (const c of tradable) { const cs = state.coins.get(c.symbol); if (cs) cs.prioReasons = prio.get(c.symbol)?.reasons ?? []; }
    const ranked = [...prio.entries()].sort((a, b) => b[1].score - a[1].score);
    state.funnel = funnelCounts(tradable, ranked);
    const shortlist = new Set(ranked.slice(0, Z.shortlistSize).map(([sym]) => sym));
    for (const pos of state.positions.values()) shortlist.add(pos.symbol);
    hotSymbols = shortlist;
    state.shortlist = { size: shortlist.size, top: ranked.slice(0, 25).map(([sym, p]) => ({ symbol: sym, score: +p.score.toFixed(0), reasons: p.reasons })) };
    // The shortlist is refreshed with candles every scan; everyone else every tailEvery-th scan (staggered) and on first sight, so any coin can move up the queue.
    const todo = tradable.filter((c, idx) => c.symbol === 'BTC' || shortlist.has(c.symbol) || (!radarLib.rejectReason(c) && ( !state.coins.get(c.symbol)?.snaps?.['1h'] || (idx + s.count) % U.tailEvery === 0)))
      .sort((a, b) => (a.symbol === 'BTC' ? -1 : b.symbol === 'BTC' ? 1 : (prio.get(b.symbol)?.score ?? 0) - (prio.get(a.symbol)?.score ?? 0)));
    let i = 0;
    for (const coin of todo) {
      s.progress = `fetching candles ${++i}/${todo.length} of ${tradable.length} coins (${coin.symbol})`;
      await analyzeCoin(coin);
    }
    for (const c of universe.coins.values()) if (!c.tradable) coinState(c.symbol).coin = c;
    // drop state for coins no longer in the universe
    for (const sym of [...state.coins.keys()]) if (![...universe.coins.values()].some((c) => c.symbol === sym)) state.coins.delete(sym);

    s.progress = 'collecting context';
    const [news, macro, bills, onchain, politics] = await Promise.all([src.news(), src.macro(), src.legislation(), src.onchain(), src.politics()]);
    [news, macro, bills, onchain, politics].forEach(noteSource);
    state.newsFeed = {
      at: Date.now(),
      feeds: [...(politics.feeds ?? []), { name: 'Crypto news RSS (CoinDesk, Cointelegraph)', tier: 4, ok: news.ok, count: news.ok ? news.data.length : 0, error: news.error ?? null },
        { name: 'Congress.gov: market-relevant bills', tier: 3, ok: bills.ok, count: bills.ok ? bills.data.length : 0, error: bills.error ?? null }],
      items: [
        ...(politics.ok ? politics.data : []),
        ...(news.ok ? news.data.map((n) => ({ source: n.source, tier: 4, kind: 'crypto', title: n.title, url: null, publishedAt: n.publishedAt })) : []),
        ...(bills.ok ? bills.data.map((b) => ({ source: 'Congress.gov', tier: 3, kind: 'legislation', title: `${b.number}: ${b.title}${b.latestAction ? ` — ${b.latestAction}` : ''}`, url: null, publishedAt: Date.parse(b.actionDate) || null })) : []),
      ].filter((i) => i.publishedAt).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 100),
    };
    for (const cs of state.coins.values()) cs.sentiment = cs.coin ? src.coinSentiment(news, cs.coin) : null;

    cgTrending().then((t) => { state.trending = t; }).catch(() => {});   // cached 15 min; never lets a CoinGecko rate-limit pause hold up the scan
    state.ctx = { news, macro, bills, onchain, politics };
    s.progress = 'thinking: ranking coins, reading structure and news';
    await runBrain({ news, macro, bills, onchain, politics });
    s.count++;
  } catch (e) {
    s.lastError = e.message;
    warn('scan failed:', e.message);
  } finally {
    s.running = false; s.finishedAt = Date.now(); s.progress = '';
  }
}

/* ------------------------------------------------------- movers + smart money */

let smartMoneyProvider = null;
export function setSmartMoneyProvider(fn) { smartMoneyProvider = fn; }

const MOVER = config.movers;

/** Live price change over the last 15m / 1h, from the stored 5m series and the live exchange price. */
function liveChange(cs) {
  const series = cs.series5m ?? [];
  const live = cs.coin?.product && feed.tickAgeMs(cs.coin.product) <= 60_000 ? feed.price(cs.coin.product) : null;
  const price = live ?? series[series.length - 1]?.c ?? null;
  if (!price || !series.length) return { price, m15: 0, h1: 0 };
  const at = (ms) => { const cutoff = (Date.now() - ms) / 1000; let ref = null; for (const c of series) if (c.t <= cutoff) ref = c; return ref ? price / ref.c - 1 : 0; };
  return { price, m15: at(15 * 60_000), h1: at(3600_000) };
}

/** Is this asset trending or unusually active right now? Used to PRIORITISE research, never to skip any requirement. */
export function activity(cs) {
  const live = liveChange(cs), reasons = [];
  let score = 0;
  const up = (x, thr, label) => { if (x >= thr) { reasons.push(`${label} ${pct(x)}`); score = Math.max(score, x / thr); } };
  up(live.h1, MOVER.chg1h, '1h');
  up(cs.chg?.h4 ?? 0, MOVER.chg4h, '4h');
  up(cs.chg?.h24 ?? 0, MOVER.chg24h, '24h');
  if (cs.rvol != null && cs.rvol >= MOVER.rvol) { reasons.push(`volume ${cs.rvol.toFixed(1)}x normal`); score = Math.max(score, cs.rvol / MOVER.rvol); }
  if (cs.coin && state.trending.has(cs.coin.id)) { reasons.push('trending on CoinGecko'); score = Math.max(score, 1.5); }
  const dump = live.h1 <= -MOVER.chg1h || (cs.chg?.h24 ?? 0) <= -MOVER.chg24h;   // unusual, but we only buy: flagged, never prioritised
  return { hot: reasons.length > 0, score, reasons, h1: live.h1, h24: cs.chg?.h24 ?? null, dump };
}
/** Cheap research priority for a coin (radar data + whatever technical state we already hold). Higher = look sooner. */
/** Median 1h / 24h move of every liquid coin the radar knows (the "market"), plus BTC and ETH. Cheap radar data only. */
function marketMoves() {
  const med = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const rows = [...radarState.rows.values()].filter((r) => (r.vol24 ?? 0) >= config.brain.funnel.minVol24 && (r.mcap ?? 0) >= config.brain.funnel.minMcap);
  const get = (sym) => rows.find((r) => r.symbol === sym);
  return { chg1h: med(rows.map((r) => r.chg1h)), chg24h: med(rows.map((r) => r.chg24h)), btc1h: get('BTC')?.chg1h ?? null, btc24: get('BTC')?.chg24h ?? null, eth1h: get('ETH')?.chg1h ?? null, eth24: get('ETH')?.chg24h ?? null, n: rows.length };
}

/** 8,500 coins -> liquidity -> quality -> relative strength -> ranked -> deep analysis. The counts per stage, for the dashboard. */
function funnelCounts(tradable, ranked) {
  const all = [...radarState.rows.values()], F = config.brain.funnel, m = state.mkt ?? { chg1h: 0, chg24h: 0 };
  const liquid = all.filter((r) => (r.vol24 ?? 0) >= F.minVol24 && (r.mcap ?? 0) >= F.minMcap);
  const quality = tradable.filter((c) => !radarLib.rejectReason(c));
  const rsMoving = quality.filter((c) => Math.abs((c.chg1h ?? 0) - m.chg1h) >= 0.005 || Math.abs((c.chg24h ?? 0) - m.chg24h) >= 0.02);
  return { monitored: all.length, liquid: liquid.length, tradable: tradable.length, quality: quality.length, relStrengthMovers: rsMoving.length, shortlist: Math.min(Z.shortlistSize, ranked.length), deep: 0, setups: 0, ready: 0, at: Date.now() };
}

function priorityOf(cs) {
  if (!cs?.coin) return { score: 0, reasons: [] };
  const sm = smartMoneyProvider ? smartMoneyProvider(cs.symbol) : null;
  const b = cs.brain;
  return radarLib.radarPriority(cs.coin, { rvol: cs.rvol, smartMoney: sm, sentiment: cs.sentiment, partial: b ? Math.max(0, Math.min(50, (b.score - 40) / 60 * 50)) : null, partialDelta: cs.brainDelta ?? 0, brainCls: b?.cls, mkt: state.mkt });
}

/** Illiquid, tiny, manipulated-looking or data-poor coins are rejected outright. Returns { code, text } or null. */
function rejectFor(cs) {
  const r = radarLib.rejectReason(cs?.coin);
  if (r) return r;
  if (!cs?.ta?.['1h'] || !cs.ta['15m']) return { code: 'insufficient_data', text: 'insufficient candle history to calculate the indicators the setups use (1h and 15m; 4h / 5m are optional and the nearest timeframe stands in)' };
  return null;
}

const rowActivity = (cs) => { const a = activity(cs); return { chg1h: a.h1, chg24h: a.h24, hot: a.hot, hotReasons: a.reasons, dump: a.dump }; };

/* ------------------------------------------------------------ the Brain's loop */
// Scan -> rank coins -> detect regime -> analyse structure / candles / supply-demand -> analyse news -> find setups -> calculate edge -> decide -> paper trade -> manage -> evaluate -> learn.
// Every coin that has candles is analysed EVERY scan by the pure Brain (src/brain.js); the LLM only gets a veto-only second look at a BUY (research.reviewDecision).

const moveSinceFor = (cs) => {
  const s = cs.h1series ?? [];
  const now = feed.price(cs.coin.product) ?? s[s.length - 1]?.c;
  return (pubMs) => {
    const sec = pubMs / 1000;
    if (!s.length || !now || sec < s[0].t) return null;
    let ref = s[0]; for (const b of s) if (b.t <= sec) ref = b;
    return now / ref.c - 1;
  };
};

/** One coin, one decision. Pure inputs only: nothing here depends on what any other trader is doing. */
function thinkAbout(cs, env) {
  const coin = cs.coin;
  const rejected = radarLib.rejectReason(coin) ?? (cs.health?.ok ? null : { text: `data not reliable: ${cs.health?.reason ?? 'unknown'}` });
  const base = {
    symbol: cs.symbol, name: coin.name, ta: cs.ta, regime: env.regime, market: env.market, rejected,
    news: newsimpact.coinImpact(env.events, { symbol: cs.symbol, name: coin.name }, moveSinceFor(cs), cs.ta?.['1h']?.atrPct, env.newsTrust),
    book: cs.book && Date.now() - cs.book.at < 180_000 ? cs.book : null,
    warnings: [...radarLib.screenWarnings(coin), ...(cs.health?.warn ? [cs.health.warn] : [])], discovered: discovery.discoveredRules(),
    chg1h: cs.chg?.h1 ?? 0, chg24h: cs.chg?.h24 ?? 0, rs: env.rs, empirical: env.empirical, selected: (cs.prioReasons ?? []).slice(0, 3).map((r) => `ranked up by: ${r}`),
    vol24: coin.vol24, smart: smartMoneyProvider ? smartMoneyProvider(cs.symbol) : null, adj: [],
    shape: (e, st, tg) => riskLib.shapeTrade(e, st, tg, { symbol: cs.symbol, rank: coin.rank ?? 100 }),
  };
  let d = brain.decide(base);
  const adj = learning.adjustmentsFor(d);                       // validated general rules only (bounded points); may change the score, never a veto or a risk limit
  if (adj.length) d = brain.decide({ ...base, adj });
  d.name = coin.name; d.rank = coin.rank ?? null; d.price = feed.price(coin.product) ?? cs.ta?.['1h']?.price ?? coin.price;
  return d;
}

const ACT_ORDER = { BUY: 0, SHORT: 0, SELL: 0, HOLD: 1, WATCH: 2, IGNORE: 3 };
const compactRow = (d) => ({
  exploration: d.exploration ?? null, rankInScan: d.rankInScan ?? null, eligibleCount: d.eligibleCount ?? null, symbol: d.symbol, name: d.name, price: d.price, action: d.action, verdict: d.verdict, side: d.side, cls: d.cls, score: d.score, scores: d.scores, mean: d.mean, floor: d.floor, confidence: d.confidence, evLB: d.evLB, cautions: (d.cautions ?? []).map((c) => c.text), penalties: (d.penalties ?? []).map((p) => `${p.text} (-${p.pts})`), pUp: d.pUp, pUpSource: d.pUpSource, pSample: d.pSample, ev: d.ev, setup: d.setup?.label ?? null, setupId: d.setup?.name ?? null,
  chase: d.chase ?? null, timing: d.timing ? { score: d.timing.score, insideZone: d.timing.insideZone, trigger: d.timing.trigger } : null, why: d.why ?? null, entryZone: d.entryZone ?? null, relStrength: d.relStrength ?? null, realisticR: d.realisticR ?? null, targetR: d.targetR ?? null, families: d.families ?? null,
  other: d.alt ? { side: d.alt.side, verdict: d.alt.verdict, scores: d.alt.scores, setup: d.alt.setup } : null,
  trend: d.evidence?.trend ?? null, flow: d.evidence?.flow ?? null, candles: d.evidence?.candles ?? [], volume: d.evidence?.volume ?? null, momentum: d.evidence?.momentum ?? null,
  levels: d.evidence?.levels ?? null, box: d.evidence?.box ?? null, news: d.evidence?.news ?? null, entry: d.entry, stop: d.stop, target: d.target, rr: d.rr, holdHours: d.holdHours,
  reasons: d.reasons.slice(0, 7), vetoes: d.vetoes.map((v) => v.text), hard: d.vetoes.some((v) => v.hard), waitingFor: d.waitingFor, factors: d.factors, adjustments: d.adjustments ?? [],
});

async function runBrain(ctxSources) {
  const now = Date.now(), Bc = config.brain;
  const coins = [...state.coins.values()].filter((cs) => cs.coin?.tradable && cs.ta);
  const live = coins.filter((cs) => cs.ta['1h'] && cs.health.ok);
  const breadth = live.length >= 20 ? live.filter((cs) => cs.ta['1h'].trend.score >= 0.25).length / live.length : null;
  const regime = brain.marketRegime({ btc: state.coins.get('BTC')?.ta, eth: state.coins.get('ETH')?.ta, breadth, btcGate: state.btc.bullish });          // the BTC EMA gate is now only a note: the regime is a probability / size modifier, and only `severe` blocks longs
  state.btc.severe = regime.severe;
  const events = newsimpact.extractEvents(state.newsFeed.items, coins.map((cs) => ({ symbol: cs.symbol, name: cs.coin.name })), now);
  const market = newsimpact.marketImpact(events, ctxSources.macro);
  learning.noteEvents(events, now);                                // event -> expected direction -> affected assets -> (later) actual reaction
  const mk = state.mkt ?? marketMoves();
  const env = {
    regime, events, market, btcChg24h: state.coins.get('BTC')?.chg?.h24 ?? 0, empirical: learning.empiricalModel(now), newsTrust: learning.newsTrust(),
    rs: { mkt1: mk.chg1h, mkt24: mk.chg24h, btc24: mk.btc24 ?? state.coins.get('BTC')?.chg?.h24 ?? 0, eth24: mk.eth24 ?? state.coins.get('ETH')?.chg?.h24 ?? 0 },
  };
  const decisions = [];
  for (const cs of coins) {
    const prev = cs.brain?.score;
    const d = thinkAbout(cs, env);
    cs.brainDelta = prev != null ? d.score - prev : 0; cs.brain = d;
    decisions.push(d);
    learning.noteScan(cs.symbol, d, now);
  }
  for (const cs of state.coins.values()) if (!cs.coin?.tradable) cs.brain = null;

  // rank: "which coins have the strongest probability of going up from this point?"
  // Eligible coins are RANKED against each other by their composite (then EV): a 65 can be taken when it is the strongest available, and only the best few are bought.
  const rank = (a, b) => ACT_ORDER[a.action] - ACT_ORDER[b.action] || b.score - a.score || (b.ev ?? -9) - (a.ev ?? -9);
  decisions.sort(rank);
  decisions.filter((d) => d.action === 'BUY').forEach((d, i, arr) => { d.rankInScan = i + 1; d.eligibleCount = arr.length; });
  const by = (cls) => decisions.filter((d) => d.cls === cls);
  const live1 = (d) => d.action === 'BUY' || d.action === 'SHORT';
  const opp = decisions.filter((d) => live1(d) || d.cls === 'HOT' || d.cls === 'SHORT' || d.action === 'WATCH').sort((a, b) => (live1(a) ? 0 : 1) - (live1(b) ? 0 : 1) || b.score - a.score || b.scores.direction - a.scores.direction);
  state.brain = {
    ...state.brain, at: now, env, regime, market, events: events.slice(0, 30), breadth, analysed: decisions.length,
    counts: { BUY: decisions.filter((d) => d.action === 'BUY').length, SHORT: decisions.filter((d) => d.action === 'SHORT').length, WAIT: decisions.filter((d) => d.action === 'WATCH').length, HOT: by('HOT').length, WATCH: by('WATCH').length, NEUTRAL: by('NEUTRAL').length, AVOID: by('AVOID').length, IGNORE: by('IGNORE').length },
    opportunities: opp.slice(0, 30).map(compactRow),
    avoid: by('AVOID').sort((a, b) => a.score - b.score).slice(0, 25).map(compactRow),
    watch: by('WATCH').slice(0, 25).map(compactRow),
    byClass: Object.fromEntries(decisions.map((d) => [d.symbol, { cls: d.cls, action: d.action, score: d.score, pUp: d.pUp }])),
  };

  const vc = {}; for (const d of decisions) for (const v of d.vetoes.filter((x) => x.hard)) vc[v.code] = (vc[v.code] ?? 0) + 1;
  state.rejected = vc;
  state.researchQueue = opp.slice(0, 20).map((d) => ({ symbol: d.symbol, priority: d.score, reasons: [d.setup?.label ?? 'forming', `${d.action} · P ${(d.pUp * 100).toFixed(0)}%`] }));

  // journal the strongest candidates (incl. vetoed ones: their counterfactual outcome is how we learn whether a veto earns its keep)
  for (const d of decisions.filter((x) => x.setup).sort((a, b) => b.scores.direction - a.scores.direction).slice(0, 30)) learning.record(d, now);
  // counterfactuals for the coins the brain declined outright (no setup): "had we taken the better-supported direction here, what would have happened?"
  const declined = decisions.filter((d) => !d.setup && d.action !== 'BUY' && d.action !== 'SHORT' && !d.vetoes.some((v) => ['screened_out', 'no_data', 'dead_market', 'illiquid_book'].includes(v.code)));
  const bestDir = (d) => Math.max(d.long?.scores.direction ?? 0, d.short?.scores.direction ?? 0);
  for (const d of declined.sort((a, b) => bestDir(b) - bestDir(a)).slice(0, 25)) learning.record({ ...d, side: d.short && d.short.scores.direction > (d.long?.scores.direction ?? 0) ? 'short' : 'long' }, now, 'ignored');
  const ready = decisions.filter((d) => d.action === 'BUY' || d.action === 'SHORT');
  state.funnel = { ...(state.funnel ?? {}), deep: decisions.length, setups: decisions.filter((d) => d.setup).length, ready: ready.length };

  // open positions: HOLD while the structure that justified the trade holds, SELL when it breaks (2 consecutive scans to confirm)
  for (const pos of [...state.positions.values()]) {
    if (pos.copy || pos.venue || pos.closing) continue;
    const cs = state.coins.get(pos.symbol);
    if (!cs?.ta) continue;
    const m = brain.manage(pos, cs.ta, priceOf(pos));
    pos.brain = { ...m, at: now };
    pos.sellChecks = m.sell ? (pos.sellChecks ?? 0) + 1 : 0;
    if (m.sell && pos.sellChecks >= Bc.sellConfirmScans) { logDecision('exit', pos.symbol, `SELL (brain): ${m.reasons.join('; ')}`); closePosition(pos, priceOf(pos), 'brain_sell'); }
  }

  // BUY candidates
  const buys = decisions.filter((d) => d.action === 'BUY'), shorts = decisions.filter((d) => d.action === 'SHORT');
  logDecision('info', '*', `brain: ${decisions.length} coins analysed · regime ${regime.label.replace(/_/g, ' ')} (${regime.score}${regime.severe ? ', SEVERE' : ''}) · ${state.brain.counts.BUY} LONG, ${state.brain.counts.SHORT} SHORT, ${state.brain.counts.WAIT} WAIT, ${state.brain.counts.AVOID} AVOID · ${events.length} news events read${buys.length ? ` · LONG: ${buys.map((d) => d.symbol).join(', ')}` : ' · no entry with a good price right now: waiting'}${shorts.length ? ` · SHORT setups (detected, not executed: allowShortTrades=${config.brain.allowShortTrades}): ${shorts.map((d) => d.symbol).join(', ')}` : ''}`);
  await considerBuys(env, buys);
  if (config.brain.explore.enabled) {
    const explorers = decisions.filter((d) => d.exploration?.eligible).sort((a, b) => b.score - a.score);
    if (explorers.length) logDecision('info', '*', `exploration: ${explorers.length} setup(s) qualify (lowRR = fails only the protected ${R.minRR}R rule; lowScore = composite under the floor): ${explorers.slice(0, 5).map((d) => `${d.symbol} (${d.exploration.kind}, R:R ${d.exploration.rr}, score ${d.score}, risk ${(d.exploration.riskPct * 100).toFixed(2)}%)`).join(', ')}`);
    await considerBuys(env, explorers, { explore: true });
  }
}

/** Turn BUY decisions into pending signals (candle confirmation + execution-price checks still follow in onCandleClosed / tryEnter). */
/** Exploration pauses itself (a) when its closed trades have used the loss budget, (b) once 50+ closed trades show the lower-R:R setups LOSE after costs. Open exploration positions keep their normal exits. */
export function explorationPause() {
  const X = config.brain.explore, rep = learningReport().exploration;
  if (!X.enabled) return 'disabled';
  if (rep.pnlUsd <= -X.budgetPct * R.startingCapital) return `loss budget used: exploration trades are ${rep.pnlUsd.toFixed(2)} (limit -${(X.budgetPct * 100).toFixed(0)}% of the starting capital)`;
  if (rep.n >= X.prelimTrades && /^negative/.test(rep.verdict)) return `the evidence is already negative after ${rep.n} trades: lower-R:R setups lose money after costs`;
  return null;
}

async function considerBuys(env, buys, opts = {}) {
  const explore = !!opts.explore, X = config.brain.explore;
  if (!buys.length) return;
  if (explore) { const paused = explorationPause(); if (paused) { if (!state.brain.explorePausedLogged) logDecision('info', '*', `exploration paused: ${paused}`); state.brain.explorePausedLogged = true; return; } state.brain.explorePausedLogged = false; }
  const gate = riskLib.tradingGate(state.portfolio);
  if (!gate.allowed) { logDecision('skipped', '*', `trading blocked: ${gate.reason}`); return; }
  if (state.brain.regime?.severe) { logDecision('skipped', 'BTC', `severe market conditions (${state.brain.regime.notes.slice(-1)[0]}): ${buys.length} LONG decision(s) held back`); return; }
  const now = Date.now();
  let made = 0;
  for (const d of buys) {
    const slots = state.positions.size + state.pending.size;
    if (slots >= R.maxOpenPositions - (explore ? X.reserveSlots : 0)) { if (!explore) logDecision('skipped', '*', `${slots} positions/pending signals already (max ${R.maxOpenPositions})`); return; }
    if (explore && [...state.positions.values(), ...state.pending.values()].filter((x) => (x.mode ?? x.decision?.mode) === 'exploration').length >= X.maxOpen) return;      // exploration never uses the last slot and is capped
    if (made >= config.brain.maxBuysPerScan) return;
    const cs = state.coins.get(d.symbol);
    if (!cs?.coin?.product || cs.evaluating) continue;
    if (cs.coin.cooldownUntil && cs.coin.cooldownUntil > now) continue;
    if ([...state.positions.values()].some((p) => p.symbol === d.symbol) || [...state.pending.values()].some((p) => p.symbol === d.symbol)) continue;
    cs.evaluating = true;
    try {
      if (Date.now() - (cs.coin.priceAt ?? 0) > 20 * 60_000) await refreshHot([cs.coin.id]).catch(() => {});      // market data older than 20 minutes is refreshed before deciding
      const fp = await feed.freshPrice(cs.coin.product, R.evalStaleMs);
      if (fp.price == null) { logDecision('skipped', d.symbol, `BUY held back: price stream not verified fresh (age ${Math.round(fp.ageMs / 1000)}s)`); continue; }
      cs.book = await fetchBook(cs.coin.product).catch(() => null);        // spread + depth are now part of the decision (illiquid book = veto)
      const d2 = cs.book ? thinkAbout(cs, env) : d;
      if (explore ? !d2.exploration?.eligible : d2.action !== 'BUY') { logDecision('skipped', d.symbol, `${explore ? 'exploration' : 'BUY'} withdrawn after the order-book check: ${d2.vetoes.map((v) => v.text).join('; ')}`); continue; }
      d2.mode = explore ? 'exploration' : 'normal';
      if (config.brain.llmReview) {
        const heads = state.newsFeed.items.slice(0, 18).map((i) => `${i.title.slice(0, 140)} [${i.source}, tier ${i.tier}]`);
        const rv = await reviewDecision(d2, heads).catch(() => null);
        if (rv?.veto) { logDecision('skipped', d.symbol, `LLM review downgraded BUY to WATCH: ${rv.why}`); cs.lastLlmVeto = now; continue; }
      }
      d2.id = learning.record(d2, now);
      const row = await db.insertSignal({
        symbol: d.symbol, source_timestamp: new Date().toISOString(), direction: 'bullish', confidence: d2.pUp * 100, reference_price: fp.price, target_price: d2.target, stop_price: d2.stop,
        evidence_summary: d2.reasons.slice(0, 3).join(' | '), evidence: { brain: compactRow(d2), events: env.events.slice(0, 8) }, confluence: { total: d2.score, factors: d2.factors }, confluence_score: d2.score, btc_regime: state.btc.regime,
        prediction: { mode: d2.mode, expected_direction: 'up', setup: d2.setup?.name, p_up: d2.pUp, ev: d2.ev, target: d2.target, stop: d2.stop, timeframe_hours: d2.holdHours, made_at: new Date().toISOString(), reference_price: fp.price }, status: 'awaiting_confirmation',
      });
      const id = row?.id ?? `mem-${now}-${d.symbol}`;
      state.pending.set(id, { id, symbol: d.symbol, mode: d2.mode, product: cs.coin.product, refPrice: fp.price, createdAt: Date.now(), decision: d2, plan: d2.entryZone, trigger: { kind: 'brain', reasons: (d2.why?.now ?? d2.reasons).slice(0, 2) }, seen: 0 });
      logDecision('candidate', d.symbol, `${explore ? `EXPLORATION idea at ${(d2.exploration.riskPct * 100).toFixed(2)}% risk (fails only the 2.5R rule)` : 'LONG idea'} (${d2.setup.label}): direction ${d2.scores.direction} / timing ${d2.scores.timing} / geometry ${d2.scores.geometry}, P(target first) ${(d2.pUp * 100).toFixed(0)}% (${d2.pUpSource}), EV ${d2.ev}R, R:R ${d2.rr}, hold ~${d2.holdHours}h. WHY NOW: ${(d2.why?.now ?? []).join('; ')}. Waiting for a 1m candle that confirms INSIDE the entry zone ${d2.entryZone.lo.toPrecision(6)}-${d2.entryZone.hi.toPrecision(6)} (a close beyond it is chasing).`);
      feed.backfill1m(cs.coin.product);
      made++;
    } finally { cs.evaluating = false; }
  }
}

/** Coins the cheap CoinGecko refresh flagged as unusual (symbol -> { h1, reasons }), waiting for the fast path below. */
const promoted = new Map();
let hotSymbols = new Set();
let fastBusy = false;

const fastAllowed = () => !state.scan.running && !!state.ctx && !!state.brain.env && !state.brain.regime?.severe && riskLib.tradingGate(state.portfolio).allowed
  && state.positions.size + state.pending.size < R.maxOpenPositions;
const idle = (cs, now) => !cs.evaluating && !(cs.coin.cooldownUntil && cs.coin.cooldownUntil > now)
  && ![...state.positions.values()].some((p) => p.symbol === cs.symbol) && ![...state.pending.values()].some((p) => p.symbol === cs.symbol);

/** Re-analyse ONE coin right now (fresh candles) and give it the normal Brain decision. Same gates as a scan: nothing is relaxed. */
async function fastScan(cs, why, reasons) {
  cs.lastFast = Date.now();
  logDecision('info', cs.symbol, `FAST SCAN: ${why}. Re-analysing now instead of waiting for the next scan`);
  await analyzeCoin(cs.coin);
  if (!cs.health.ok || rejectFor(cs)) return;
  const d = thinkAbout(cs, state.brain.env);
  cs.brain = d;
  learning.noteScan(cs.symbol, d);
  if (d.action === 'BUY') await considerBuys(state.brain.env, [d]);
  else logDecision('info', cs.symbol, `FAST SCAN result: ${d.action} (${d.cls}, score ${d.score})${d.vetoes.length ? `: ${d.vetoes.slice(0, 2).map((v) => v.text).join('; ')}` : ''}`);
}

/** Promote coins the cheap refresh saw ripping (1h move or a volume jump) without waiting for the next full sweep or scan. */
function notePromotions(unusual) {
  const now = Date.now();
  for (const u of unusual) {
    const cs = state.coins.get(u.symbol);
    if (!cs?.coin?.tradable || now - (cs.lastPromoted ?? 0) < Z.promoteCooldownMs) continue;
    if (radarLib.rejectReason(cs.coin)) continue;                // cheap screens first (illiquid, tiny, wash-trading, thin spike): never worth a candle fetch
    cs.lastPromoted = now;
    promoted.set(u.symbol, { ...u, at: now });
  }
  if (promoted.size) drainPromoted().catch((e) => warn('promotion', e.message));
}

async function drainPromoted() {
  if (fastBusy) return;
  fastBusy = true;
  try {
    while (promoted.size && fastAllowed()) {
      const [sym, u] = [...promoted.entries()].sort((a, b) => b[1].h1 - a[1].h1)[0];
      promoted.delete(sym);
      const cs = state.coins.get(sym), now = Date.now();
      if (now - u.at > 10 * 60_000) continue;                    // a spike we could not act on (scan running, BTC bearish, slots full) goes stale
      if (!cs?.coin?.tradable || !idle(cs, now) || now - (cs.lastFast ?? 0) < MOVER.fastCooldownMs) continue;
      await fastScan(cs, `promoted by the CoinGecko refresh (${u.reasons.join(', ')})`, u.reasons);
    }
  } finally { fastBusy = false; }
}

/** Keep the coins we can trade fresh between full sweeps: shortlist + open positions often, the rest of the tradable set less often. Never waits for, or blocks, the scan. */
let hotBusy = false, tailBusy = false;
const hotIds = () => {
  const ids = new Set();
  for (const sym of hotSymbols) { const id = state.coins.get(sym)?.coin?.id; if (id) ids.add(id); }
  for (const pos of state.positions.values()) { const id = pos.symbol && state.coins.get(pos.symbol)?.coin?.id; if (id) ids.add(id); }
  return ids;
};
async function hotRefresh() {
  if (hotBusy || !universe.coins.size) return;
  hotBusy = true;
  try { const r = await refreshHot([...hotIds()]); if (r.error) warn('CoinGecko hot refresh:', r.error); notePromotions(r.unusual); } finally { hotBusy = false; }
}
async function tailRefresh() {
  if (tailBusy || !universe.coins.size) return;
  tailBusy = true;
  try { const r = await refreshTail([...hotIds()]); if (r.error) warn('CoinGecko tradable refresh:', r.error); notePromotions(r.unusual); } finally { tailBusy = false; }
}

/** Between full scans: if something is suddenly ripping (e.g. +8% in an hour), analyse it now instead of waiting up to 5 minutes. */
async function moverWatch() {
  if (!fastAllowed()) return;
  await drainPromoted();
  if (!fastAllowed()) return;
  const now = Date.now();
  const hit = [...state.coins.values()]
    .filter((cs) => cs.coin?.tradable && cs.health?.ok && !rejectFor(cs) && idle(cs, now))
    .filter((cs) => now - (cs.lastFast ?? 0) > MOVER.fastCooldownMs)
    .map((cs) => ({ cs, a: activity(cs) }))
    .filter((x) => x.a.h1 >= MOVER.fastTrigger1h)
    .sort((a, b) => b.a.h1 - a.a.h1)[0];
  if (!hit) return;
  await fastScan(hit.cs, `up ${pct(hit.a.h1)} in the last hour`, hit.a.reasons.length ? hit.a.reasons : [`1h ${pct(hit.a.h1)}`]);
}

/* ------------------------------------------------- candle confirmation + entry */

async function failSignal(p, status, reason, confirmation = null) {
  state.pending.delete(p.id);
  const cs = state.coins.get(p.symbol); if (cs?.signal) cs.signal.status = status;
  logDecision('skipped', p.symbol, reason);
  await db.updateSignal(p.id, { status, skip_reason: reason, ...(confirmation ? { confirmation } : {}) });
}

function onCandleClosed(product, candle) {
  for (const p of [...state.pending.values()]) {
    if (p.product !== product || candle.t * 1000 < Math.ceil(p.createdAt / 60000) * 60000) continue; // only candles that open AFTER the prediction
    p.seen++;
    const closed = feed.closed1m(product);
    const avgVol = closed.slice(-21, -1).reduce((a, c) => a + c.v, 0) / Math.max(1, closed.slice(-21, -1).length);
    // The confirmation has to confirm the THESIS, not just be green: the close holds the level (not below the zone), sits in or just past the zone, volume is reasonable, and the stop is not violated.
    // A bullish-ish close is enough (green, or closing in the upper half of its range): it does not have to be a perfect candle. A close far beyond the zone is the market running away, not a confirmation.
    const z = p.plan, range = candle.h - candle.l, bullish = candle.c >= candle.o || (range > 0 && (candle.c - candle.l) / range >= 0.5), volOk = avgVol === 0 || candle.v >= avgVol * 0.6;
    const near = z ? z.hi + 0.25 * (z.atr ?? 0) : Infinity, ranAway = !!z && candle.c > z.hi + config.brain.cancelBeyond * (z.atr ?? 0), heldLevel = z ? candle.c >= z.lo : candle.c > p.refPrice * 1.0005, aboveRef = heldLevel && candle.c <= near;
    if (p.decision?.stop != null && candle.l <= p.decision.stop) { failSignal(p, 'skipped', `setup invalidated: price traded through the planned stop ${p.decision.stop.toPrecision(6)} before confirming`); continue; }
    const confirmation = { candle_time: new Date(candle.t * 1000).toISOString(), o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v, bullish, above_reference: aboveRef, volume_ok: volOk, candles_seen: p.seen };
    if (ranAway) { failSignal(p, 'skipped', `price moved materially away from the plan: the 1m candle closed at ${candle.c}, well beyond the entry zone (top ${z.hi.toPrecision(6)}); cancelled and recalculated on the next scan instead of chasing`, confirmation); continue; }
    if (bullish && aboveRef && volOk) {
      confirmation.passed = true;
      state.pending.delete(p.id);
      db.updateSignal(p.id, { status: 'confirmed', confirmed_at: new Date().toISOString(), confirmation });
      logDecision('confirmed', p.symbol, `candle confirmed the planned entry (close ${candle.c} inside the zone ${z ? z.lo.toPrecision(6) + '-' + z.hi.toPrecision(6) : 'n/a'}): running risk filters`);
      tryEnter(p, confirmation);
    }                                                              // otherwise keep waiting: the structure is reassessed when the window ends, not discarded after exactly 3 candles
  }
}

async function tryEnter(p, confirmation) {
  const cs = state.coins.get(p.symbol);
  let d = p.decision;
  try {
    // Rules 59-63: recalculate the setup, the R:R and the scores from FRESH candles, a fresh order book and a fresh BTC / regime read, instead of trusting a plan made up to half an hour ago.
    if (cs?.coin && state.brain.env) {
      await analyzeCoin(cs.coin);
      cs.book = await fetchBook(p.product).catch(() => null);
      const btcCs = state.coins.get('BTC'); if (btcCs?.coin) await analyzeCoin(btcCs.coin);
      const env = { ...state.brain.env, regime: brain.marketRegime({ btc: btcCs?.ta, eth: state.coins.get('ETH')?.ta, breadth: state.brain.env.regime?.breadth, btcGate: state.btc.bullish }) };
      const d3 = thinkAbout(cs, env);
      const okNow = p.mode === 'exploration' ? !!d3.exploration?.eligible : d3.action === 'BUY';
      if (!okNow) {
        const why = `setup no longer valid when recalculated at entry (composite ${d3.score}, floor ${d3.floor}): ${d3.vetoes.map((v) => v.text).join('; ') || 'blocked'}`;
        await db.updateSignal(p.id, { status: 'skipped', skip_reason: why }); logDecision('skipped', p.symbol, why); return;
      }
      d3.id = d.id; d3.mode = p.mode ?? 'normal'; d = d3; p.decision = d3;
    }
    const fp = await feed.freshPrice(p.product, R.staleMs);
    // Re-verify the BTC regime with fresh candles right before entering.
    let btc = state.btc;
    try { btc = riskLib.btcRegime(snapshot(await fetchCandles('BTC-USD', 3600))); state.btc = { ...btc, at: Date.now() }; } catch { /* keep scan regime */ }
    const live = fp.price ?? p.refPrice;
    // Execution-price validation: a price that is stale (>10s) or has moved materially since the setup was confirmed is never traded.
    const execReasons = [];
    if (fp.price == null) execReasons.push(`execution price stale (last trade ${Number.isFinite(fp.ageMs) ? Math.round(fp.ageMs / 1000) + 's' : 'unknown'} ago, max ${R.staleMs / 1000}s)`);
    else if (confirmation?.c > 0 && Math.abs(fp.price / confirmation.c - 1) > R.maxEntryDriftPct) execReasons.push(`execution price ${fp.price} is ${(Math.abs(fp.price / confirmation.c - 1) * 100).toFixed(2)}% away from the confirmed price ${confirmation.c} (max ${R.maxEntryDriftPct * 100}%)`);
    if (d.entryZone && fp.price != null && fp.price > d.entryZone.hi + 0.25 * (d.entryZone.atr ?? 0)) execReasons.push(`not chasing: execution price ${fp.price} is beyond the (recalculated) entry zone (top ${d.entryZone.hi.toPrecision(6)})`);
    // The Brain proposes the structural stop and target; risk.shapeTrade keeps the stop inside the coin's band (never wider than 4%) and re-prices R:R at the LIVE entry.
    const shaped = riskLib.shapeTrade(live, d.stop, d.target, { symbol: p.symbol, rank: cs?.coin?.rank ?? 100 });
    const reasons = riskLib.entryFilters({
      signal: { direction: 'bullish' }, entry: live, shaped, composite: d.score, floor: p.mode === 'exploration' && d.exploration?.kind === 'lowScore' ? d.floor - config.brain.explore.floorDrop : d.floor, minRR: p.mode === 'exploration' && d.exploration?.kind === 'lowRR' ? config.brain.explore.minRR : undefined, btc: { ...btc, severe: !!state.brain.regime?.severe }, portfolio: state.portfolio,
      openCount: state.positions.size, cooldownUntil: cs?.coin?.cooldownUntil, dataFresh: fp.price != null,
    });
    if (live <= shaped.stop) reasons.push('price already at/below the stop level');
    if (cs?.coin) { const rj = radarLib.rejectReason(cs.coin); if (rj) reasons.push(rj.text); }
    reasons.push(...execReasons);
    if (reasons.length) {
      await db.updateSignal(p.id, { status: 'skipped', skip_reason: reasons.join(' | '), rr: shaped.rr });
      if (cs) cs.signalStatus = 'skipped';
      logDecision('skipped', p.symbol, `blocked after confirmation: ${reasons.join(' | ')}`);
      return;
    }
    const equity = markEquity();
    const entryPx = riskLib.entryFill(live);
    // Size comes from the stop distance, not from conviction: (equity x 1%) / (stop% + fees/slippage%), capped by the global position cap.
    // Exploration sizing: until the Brain has 30+ measured own trades with a positive average R, it risks only half the normal 1% (smaller than the cap, never larger).
    const lr = learningReport(), proven = lr.trades.n >= config.brain.exploreMinTrades && lr.trades.avgR > 0;
    // Size can only go DOWN from the 1%-risk cap: half size while exploring, times the regime multiplier (bearish-but-not-severe market 0.6x, neutral 0.85x).
    const exploring = p.mode === 'exploration';
    // Exploration risks only 0.10% - 0.25% of equity: notional = equity x risk% / (stop% + round-trip costs). It can only be SMALLER than the normal cap, never larger.
    const wanted = exploring
      ? riskLib.explorationNotional(equity, d.exploration.riskPct, shaped.stopDist, guard.maxNotionalFor(equity, shaped.stopDist)) * Math.min(1, d.riskMult ?? 1)
      : guard.maxNotionalFor(equity, shaped.stopDist) * (proven ? 1 : config.brain.exploreRiskFraction) * Math.min(1, d.riskMult ?? 1);
    const fin = guard.finalizeEntry({ side: 'long', equity, cash: state.portfolio.cash, entry: entryPx, stop: shaped.stop, wanted });
    if (!fin.ok || fin.notional < 10) {
      const why = !fin.ok ? fin.reasons.join('; ') : `risk-based size $${fin.notional.toFixed(2)} is below the $10 minimum order (or insufficient cash)`;
      logDecision('skipped', p.symbol, why); await db.updateSignal(p.id, { status: 'skipped', skip_reason: why }); return;
    }
    const sizePct = fin.notional / equity, stopPx = fin.stop;
    const qty = fin.notional / entryPx, notional = qty * entryPx, fee = riskLib.feeOn(notional);
    const why = `${exploring ? `EXPLORATION (${(d.exploration.riskPct * 100).toFixed(2)}% risk, net R:R ${shaped.rr.toFixed(2)} < the normal 2.5 minimum, measured separately). ` : ''}${d.setup.label}. WHY NOW: ${(d.why?.now ?? []).join('; ')}. ${d.reasons.slice(0, 2).join(' · ')}. Direction ${d.scores.direction} / timing ${d.scores.timing} / geometry ${d.scores.geometry}, P(target before stop) ${(d.pUp * 100).toFixed(0)}% (${d.pUpSource}), EV ${d.ev}R, net R:R ${shaped.rr.toFixed(2)}, planned hold ~${d.holdHours}h. BTC 1h ${btc.regime}; candle confirmed.${proven ? '' : ` Exploration size (${config.brain.exploreRiskFraction}x risk): the edge is not yet proven by measured outcomes.`}`;
    const row = await db.insertTrade({
      symbol: p.symbol, signal_id: p.id.startsWith('mem-') ? null : p.id, status: 'open', entry_price: entryPx, qty, notional,
      target_price: shaped.target, stop_price: stopPx, high_water: entryPx, rr: shaped.rr, confluence_score: d.score, rationale: why,
      fee_entry: fee, entry_trigger: exploring ? 'brain_explore' : 'brain', prediction: { product: p.product, mode: p.mode ?? 'normal', xkind: p.mode === 'exploration' ? d.exploration?.kind ?? null : null, riskUsd: fin.riskUsd, expected_direction: 'up', decisionId: d.id ?? null, setup: d.setup.name, p_up: d.pUp, ev: d.ev, scores: d.scores, why: d.why, chase: d.chase, entryZone: d.entryZone, factors: d.factors, target: d.target, stop: d.stop, timeframe_hours: d.holdHours, confirmation, trigger: p.trigger ?? null, evidence: d.evidence },
      evidence_used: d.reasons.join(' | '), expected_direction: 'up', confidence: d.pUp * 100,
      candle_pattern: `${(d.evidence?.candles ?? []).join(', ') || 'no clear pattern'}; 1m confirm close ${confirmation.c}`, market_regime: `${d.evidence?.regime ?? '?'}; BTC 1h ${btc.regime}`,
    });
    const id = row?.id ?? `mem-trade-${Date.now()}`;
    if (d.id) learning.attachTrade(d.id, id, p.mode ?? 'normal', p.mode === 'exploration' ? d.exploration?.kind : undefined);
    state.portfolio.cash -= notional + fee;
    state.positions.set(id, {
      id, symbol: p.symbol, mode: p.mode ?? 'normal', rrEntry: shaped.rr, product: p.product, signalId: p.id, decisionId: d.id ?? null, qty, entry: entryPx, notional, fee, stop: stopPx, stopPct: fin.stopPct, riskUsd: fin.riskUsd, target: shaped.target, band: shaped.band, partialTaken: false, horizonHours: clampN(d.holdHours ?? 24, 1, 72),
      trailing: null, highWater: entryPx, lowWater: entryPx, openedAt: Date.now(), rationale: why, lastPrice: live, sizePct, trigger: p.trigger ?? { kind: 'brain', reasons: [] },
      ctx: { brain: d, btc: btc.regime, confirmation, regime: d.evidence?.regime },
    });
    await db.updateSignal(p.id, { status: 'entered', trade_id: row?.id ?? null, rr: shaped.rr });
    persistPortfolio(true);
    feed.backfill1m(p.product);
    logDecision('entered', p.symbol, `${exploring ? 'EXPLORATION ' : ''}PAPER LONG ${qty.toPrecision(5)} @ ${entryPx.toPrecision(6)} ($${notional.toFixed(0)}, ${pct(sizePct)} of equity) stop ${stopPx.toPrecision(6)} (${pct(fin.stopPct)}) risk $${fin.riskUsd.toFixed(2)} (${pct(fin.riskUsd / equity)} of equity) target ${shaped.target.toPrecision(6)} · ${d.setup.label}`);
  } catch (e) {
    warn('tryEnter failed', p.symbol, e.message);
    await failSignal(p, 'skipped', `entry error: ${e.message}`);
  }
}

/* ----------------------------------------------------------- position monitor */

function onTick(product, price) {
  for (const pos of state.positions.values()) {
    if (pos.product !== product || pos.closing) continue;
    pos.lastPrice = price;
    if (price > pos.highWater) pos.highWater = price;
    if (price < (pos.lowWater ?? pos.entry)) pos.lowWater = price;
    if (pos.target && !partialDone(pos) && price >= pos.target) takePartial(pos, price, R.partialPct, 'target_partial');
    if (price >= pos.entry * (1 + R.trailActivatePct)) {
      const next = chandelierStop(pos, price);
      if (next > (pos.trailing ?? 0)) {                              // ratchet only: a stop/trail is never lowered to chase more profit
        pos.trailing = next;
        if (!pos.syncAt || Date.now() - pos.syncAt > 5000) { pos.syncAt = Date.now(); db.updateTrade(pos.id, { trailing_stop: next, high_water: pos.highWater }); }
      }
    }
    const level = Math.max(pos.stop, pos.trailing ?? 0);
    if (price <= level) closePosition(pos, price, pos.trailing && level === pos.trailing ? 'trailing_stop' : partialDone(pos) && pos.stop >= pos.entry ? 'breakeven_stop' : 'stop_loss');
  }
}
const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// A position meant to be held for more than ~6h is a swing hold: 1-minute noise must never close it. Missing horizon counts as a swing (hold by default).
const isSwing = (pos) => (pos.horizonHours ?? 24) > 6;
const partialDone = (pos) => pos.partialTaken ?? (pos.realized ?? 0) !== 0;
const bandOf = (pos) => (pos.band ??= riskLib.stopBand(pos.symbol, state.coins.get(pos.symbol)?.coin?.rank ?? 100));

function takePartial(pos, price, fraction, reason) {
  if (reason === 'target_partial') {
    pos.partialTaken = true;
    pos.stop = guard.keepStopTight('long', pos.stop, pos.entry);     // tighten only: once the target is banked the stop moves up to breakeven
  }
  reducePosition(pos, fraction, price, reason).catch((e) => warn('partial exit failed', pos.symbol, e.message));
}

/**
 * Chandelier-style dynamic trailing stop: highest price since entry minus k x ATR(15m). k shrinks as unrealised profit (in R, where
 * R = the initial stop distance) grows: 3.0 below 1R, 2.5 to 2R, 2.0 to 3R, 1.5 above. Fading momentum or a non-bullish BTC regime tighten it
 * a further 20%. The caller only ever ratchets the result upward, so a trailing stop is never lowered or widened.
 */
function chandelierStop(pos, price) {
  const band = bandOf(pos), cs = state.coins.get(pos.symbol);
  const atr = (isSwing(pos) && cs?.atr1h > 0 ? cs.atr1h : cs?.atr15) || pos.entry * band.min;   // swing holds trail on the 1h ATR so ordinary hourly swings do not shake them out
  const riskDist = pos.entry * (pos.stopPct ?? band.max);
  const profitR = (pos.highWater - pos.entry) / riskDist;
  let k = profitR >= 3 ? 1.5 : profitR >= 2 ? 2.0 : profitR >= 1 ? 2.5 : 3.0;
  if ((pos.momFactor ?? 1) < 1 || !state.btc.bullish) k *= 0.8;
  return pos.highWater - k * atr;
}

function onMomentumCheck(product) {
  for (const pos of state.positions.values()) {
    if (pos.product !== product || pos.closing) continue;
    const closed = feed.closed1m(product);
    if (closed.length < 20) continue;
    const closes = closed.map((c) => c.c);
    const e9 = ema(closes, 9), r = rsi(closes);
    if (!e9.length || r == null) continue;
    const price = priceOf(pos);
    const last2Below = closes.slice(-2).every((c) => c < e9[e9.length - 1]);
    // Structural confirmation only: a single red 1m candle never closes a winner. Needs EITHER two consecutive lower lows on declining
    // volume, OR a confirmed EMA break (two closes below the 21 EMA with RSI < 45).
    const [c3, c2, c1] = closed.slice(-3);
    const lowerLows = c1.l < c2.l && c2.l < c3.l, volDeclining = c1.v < c2.v && c2.v < c3.v;
    const e21 = ema(closes, 21), emaBreak = e21.length && closes.slice(-2).every((c) => c < e21[e21.length - 1]) && r < 45;
    const swing = isSwing(pos), cs1h = state.coins.get(pos.symbol)?.snaps?.['1h'];
    // A LOSING position in a confirmed, continuing downtrend (lower highs and lows on 5m, under the EMA, RSI weak and falling, no bounce) is cut now instead of
    // waiting for the stop. Needs 3 consecutive 1m closes of confirmation. Winners are handled by the trail / trend_break / momentum_reversal rules below.
    const dt = downtrendSignal({ pos, price, closed1m: closed, riskDist: pos.entry * (pos.stopPct ?? bandOf(pos).max), swing, snap1h: cs1h });
    pos.dtChecks = dt.fire ? (pos.dtChecks ?? 0) + 1 : 0;
    if (dt.fire && pos.dtChecks >= config.exits.downtrend.confirmChecks) {
      logDecision('info', pos.symbol, `downtrend exit instead of waiting for the stop: ${dt.detail}`);
      closePosition(pos, price, 'downtrend_exit'); continue;
    }
    if (swing) {
      // Swing hold (1-2 days): ignore 1-minute noise entirely. Leave on a broken 1h trend, otherwise let the stop / Chandelier trail decide.
      pos.momFactor = 1;
      if (price > pos.entry && Date.now() - pos.openedAt > 3600_000 && cs1h && !cs1h.trendUp && !cs1h.aboveEma20) { closePosition(pos, price, 'trend_break'); continue; }
    } else {
      if (price > pos.entry && ((lowerLows && volDeclining) || emaBreak)) { closePosition(pos, price, 'momentum_reversal'); continue; }
      pos.momFactor = r < 55 || last2Below ? 0.7 : 1;              // fading momentum tightens the trail
    }
    if (!partialDone(pos) || price <= pos.entry) continue;
    // Runner management after the target was banked: leave on a regime flip (short holds only), or lighten up into resistance when overextended.
    if (!swing && !state.btc.bullish) { closePosition(pos, price, 'regime_exit'); continue; }
    const hi = Math.max(...closed.slice(-241, -1).map((c) => c.h));   // highest high of the previous ~4h = nearest resistance
    if (!pos.resistTrimmed && r >= 75 && price >= hi * 0.995 && price <= hi * 1.002) {
      pos.resistTrimmed = true;
      takePartial(pos, price, R.extraPartialPct, 'resistance_partial');
    }
  }
}

/* ---------------------------------------------------------------- trade history */

const sourceOf = (pos) => (pos.copy ? (pos.venue === 'onchain' ? 'copy_zerion' : 'copy_hyperliquid') : 'strategy');

function historyFromDb(t) {
  return {
    id: t.id, symbol: t.symbol, side: t.side ?? 'long', source: t.source ?? 'strategy', trader: t.source_trader ?? null,
    entry: Number(t.entry_price), exit: Number(t.exit_price), notional: Number(t.final_pnl_pct) ? Math.abs(Number(t.final_pnl) / Number(t.final_pnl_pct)) : Number(t.notional), pnl: Number(t.final_pnl), pnlPct: Number(t.final_pnl_pct),
    reason: t.exit_reason, openedAt: new Date(t.entry_time).getTime(), closedAt: new Date(t.exit_time).getTime(),
    origin: String(t.source ?? '').startsWith('copy_') ? 'mimic' : 'own', trigger: t.entry_trigger ?? null, triggerReasons: t.prediction?.trigger?.reasons ?? [], mode: t.prediction?.mode ?? 'normal',
  };
}

function recordHistory(pos, trade, notional) {
  state.recentClosed.unshift({
    id: pos.id, symbol: pos.symbol, side: pos.side ?? 'long', source: sourceOf(pos), trader: pos.copy?.trader ?? null,
    entry: pos.entry, exit: trade.exit_price, notional, pnl: trade.final_pnl, pnlPct: trade.final_pnl_pct, reason: trade.exit_reason,
    openedAt: pos.openedAt, closedAt: Date.now(),
    origin: pos.copy ? 'mimic' : 'own', trigger: pos.trigger?.kind ?? null, triggerReasons: pos.trigger?.reasons ?? [], mode: pos.mode ?? 'normal',
  });
  if (state.recentClosed.length > 200) state.recentClosed.length = 200;
}

function historySummary() {
  const all = state.recentClosed;
  const wins = all.filter((t) => t.pnl > 0), losses = all.filter((t) => t.pnl <= 0);
  const sum = (a) => a.reduce((x, t) => x + t.pnl, 0);
  const modeGroup = (m) => { const g = all.filter((t) => (t.mode ?? 'normal') === m && t.origin === 'own'); return { count: g.length, wins: g.filter((t) => t.pnl > 0).length, losses: g.filter((t) => t.pnl <= 0).length, net: sum(g) }; };
  const group = (o) => { const g = all.filter((t) => t.origin === o); return { count: g.length, wins: g.filter((t) => t.pnl > 0).length, losses: g.filter((t) => t.pnl <= 0).length, net: sum(g) }; };
  return {
    byOrigin: { own: group('own'), mimic: group('mimic') },
    byMode: { exploration: modeGroup('exploration'), normal: modeGroup('normal') },
    trades: all.slice(0, 60).map((t) => ({ ...t, result: t.pnl > 0 ? 'win' : 'loss' })),
    stats: {
      count: all.length, wins: wins.length, losses: losses.length, winRate: all.length ? wins.length / all.length : null, net: sum(all),
      avgWin: wins.length ? sum(wins) / wins.length : null, avgLoss: losses.length ? sum(losses) / losses.length : null,
      best: all.length ? Math.max(...all.map((t) => t.pnl)) : null, worst: all.length ? Math.min(...all.map((t) => t.pnl)) : null,
    },
  };
}

// Fill price for leaving a position (long sells lower, short buys back higher) and for entering one.
const exitFillFor = (side, px) => (side === 'short' ? px * (1 + R.slippagePct) : riskLib.exitFill(px));
const entryFillFor = (side, px) => (side === 'short' ? px * (1 - R.slippagePct) : riskLib.entryFill(px));
const favourable = (pos) => (pos.side === 'short' ? pos.entry / pos.highWater - 1 : pos.highWater / pos.entry - 1);

/** Every exit leg (partial or final) is its own row in trade_exit_events, linked to the parent trade_logs row. */
function recordExit(pos, e) {
  if (String(pos.id).startsWith('mem-')) return;                  // memory-only trade: no parent row to link to
  db.insertExitEvent({ trade_id: pos.id, price: e.price, size_usd: e.sizeUsd, realized_pnl: e.pnl, exit_reason: e.reason, iso_timestamp: new Date().toISOString(), is_final: e.final });
}

export async function closePosition(pos, price, reason) {
  if (pos.closing) return;
  pos.closing = true;
  const p = state.portfolio;
  const exitPx = exitFillFor(pos.side, price);
  const gross = pos.qty * (pos.side === 'short' ? pos.entry - exitPx : exitPx - pos.entry);
  const feeExit = riskLib.feeOn(pos.qty * exitPx);
  const legPnl = gross - pos.fee - feeExit;
  const finalPnl = (pos.realized ?? 0) + legPnl;
  const finalPct = finalPnl / (pos.initCost ?? (pos.notional + pos.fee));
  p.cash += pos.notional + gross - feeExit;
  p.realized_pnl += legPnl;
  state.positions.delete(pos.id);
  const mins = (Date.now() - pos.openedAt) / 60000;
  const actual = `${finalPnl >= 0 ? 'Gain' : 'Loss'} of ${pct(finalPct)} (net) over ${mins.toFixed(0)} min on a ${pos.side ?? 'long'}; best excursion ${pct(favourable(pos))}; exit reason: ${reason}.`;
  const trade = {
    id: pos.id, symbol: pos.symbol, side: pos.side ?? 'long', entry_price: pos.entry, exit_price: exitPx, qty: pos.qty, exit_reason: reason, final_pnl: finalPnl,
    final_pnl_pct: finalPct, exit_time: new Date().toISOString(), entry_time: new Date(pos.openedAt).toISOString(), high_water: pos.highWater,
  };
  recordExit(pos, { price: exitPx, sizeUsd: pos.qty * exitPx, pnl: legPnl, reason, final: true });
  state.closedToday.push({ ...trade, exitAt: Date.now() });
  recordHistory(pos, trade, pos.initCost ?? (pos.notional + pos.fee));
  state.closedTotal++;
  if (pos.copy) noteTraderResult(pos.copy.trader);
  await db.updateTrade(pos.id, {
    status: 'closed', exit_time: trade.exit_time, exit_price: exitPx, exit_reason: reason, fee_exit: feeExit, realized_partial: pos.realized ?? 0,
    gross_pnl: gross, final_pnl: finalPnl, final_pnl_pct: finalPct, actual_result: actual, high_water: pos.highWater, trailing_stop: pos.trailing,
  });
  logDecision('exit', pos.symbol, `${reason}: net P&L $${finalPnl.toFixed(2)} (${pct(finalPct)})${pos.copy ? ` [copy of ${pos.copy.trader.slice(0, 8)}]` : ''}`);
  if (reason === 'stop_loss' || reason === 'downtrend_exit' || (reason === 'brain_sell' && finalPnl < 0)) {         // do not buy straight back into a coin that just kept falling
    const until = Date.now() + R.assetCooldownHours * 3600_000;
    if (pos.venue === 'hl') state.copyCooldown.set(pos.coin, until);
    else {
      const coin = [...universe.coins.values()].find((c) => c.symbol === pos.symbol);
      if (coin) { coin.cooldownUntil = until; db.setCooldown(coin.id, new Date(until).toISOString()); }
    }
  }
  checkBreakers();
  persistPortfolio(true);
  reflect(pos, trade, actual).catch((e) => warn('reflection failed', e.message));
}

/* ------------------------------------------------------- per-trader loss streaks */
// Consecutive LOSING copies of the same trader escalate: 1 keep copying · 2 PAUSED 3h + re-score · 3 pause 24h + re-score · 4 stop until review · 5+ removed.
// Derived from closed copy trades (restored from Supabase on start), so it survives restarts. Any win resets it. Exits are never blocked.
const releasedAt = new Map();    // address -> time an operator released the trader (only losses after this count)

export function traderStatus(address, now = Date.now()) {
  const L = config.copy.loserStreak;
  const since = releasedAt.get(address) ?? 0;
  let losses = 0, last = null;
  for (const t of state.recentClosed) {                         // newest first
    if (t.trader !== address || t.closedAt <= since) continue;
    if (t.pnl > 0) break;
    losses++; last ??= t.closedAt;
  }
  const out = { losses, state: 'ok', status: 'ACTIVE', blocked: false, excluded: false, until: null, label: losses ? `${losses} loss in a row` : 'no loss streak' };
  if (losses >= L.removeAt) return { ...out, state: 'removed', status: 'REMOVED', blocked: true, excluded: true, label: `${losses} losses in a row: removed from the active pool` };
  if (losses >= L.reviewAt) return { ...out, state: 'review', status: 'REVIEW', blocked: true, excluded: true, label: `${losses} losses in a row: not copied until manual review` };
  if (losses >= 2) {
    const until = last + (losses >= 3 ? L.pause3Hours : L.pause2Hours) * 3600_000;
    const paused = until > now;
    return { ...out, state: paused ? 'paused' : 'ok', status: paused ? 'PAUSED' : 'ACTIVE', blocked: paused, until: paused ? until : null,
      label: paused ? `${losses} losses in a row: paused until ${new Date(until).toISOString().slice(11, 16)} UTC${losses >= 3 ? ' (re-scoring)' : ''}` : `${losses} losses in a row (pause over, next loss escalates)` };
  }
  return out;
}

function noteTraderResult(address) {
  const s = traderStatus(address);
  if (!s.losses) return;
  if (s.losses >= 2) state.rescore.add(address);   // 2nd straight loss: pause AND re-score right away
  logDecision(s.blocked ? 'skipped' : 'info', '*', `copy trader ${address.slice(0, 8)}: ${s.label}`);
}

export function releaseTrader(address) {
  releasedAt.set(address, Date.now());
  state.rescore.add(address);
  logDecision('info', '*', `trader ${address.slice(0, 8)} released by the operator: loss streak cleared, re-scoring before any new copy`);
}

/** Partial exit (a copied leader scaled out). The remainder stays open; P&L is realised pro-rata. */
export async function reducePosition(pos, fraction, price, reason) {
  if (pos.closing) return;
  if (fraction >= 0.995) return closePosition(pos, price, reason);
  const p = state.portfolio;
  const qtyC = pos.qty * fraction, exitPx = exitFillFor(pos.side, price);
  const gross = qtyC * (pos.side === 'short' ? pos.entry - exitPx : exitPx - pos.entry);
  const feeExit = riskLib.feeOn(qtyC * exitPx), feeShare = pos.fee * fraction, notionalC = pos.notional * fraction;
  const leg = gross - feeShare - feeExit;
  p.cash += notionalC + gross - feeExit;
  p.realized_pnl += leg;
  pos.realized = (pos.realized ?? 0) + leg;
  pos.qty -= qtyC; pos.notional -= notionalC; pos.fee -= feeShare;
  await db.updateTrade(pos.id, { qty: pos.qty, notional: pos.notional, fee_entry: pos.fee, realized_partial: pos.realized });
  recordExit(pos, { price: exitPx, sizeUsd: qtyC * exitPx, pnl: leg, reason, final: false });
  logDecision('exit', pos.symbol, `${reason}: reduced ${(fraction * 100).toFixed(0)}% of the position (leg P&L $${leg.toFixed(2)})`);
  persistPortfolio(true);
}

/**
 * Open a PAPER position that mirrors a tracked trader. Every deterministic safety gate that makes sense for a copied trade applies:
 * circuit breakers, the shared max-3-positions cap, the 30%-of-equity size cap, asset cooldown, fresh-data check, fees + slippage and the hard stop.
 * (The BTC-regime / confluence / R:R filters belong to the LLM strategy and do not apply: the trader's edge is the signal here.)
 */
export async function openCopyPosition(o) {
  if (!config.copy.mirror) return { ok: false, reason: 'copy entries are disabled: the AI trades only its own analysis (tracked traders are a small data input and never open a position)' };
  const p = state.portfolio, now = Date.now();
  const gate = riskLib.tradingGate(p, now);
  if (!gate.allowed) return { ok: false, reason: `circuit breaker: ${gate.reason}` };
  const tg = traderStatus(o.trader, now);
  if (tg.blocked) return { ok: false, reason: `trader ${tg.label}` };
  if (state.positions.size + state.pending.size >= R.maxOpenPositions) return { ok: false, reason: `already ${state.positions.size + state.pending.size} open positions/pending signals (max ${R.maxOpenPositions})` };
  if ([...state.positions.values()].filter((x) => x.copy).length >= config.copy.maxCopyPositions) return { ok: false, reason: `copy trades are limited to ${config.copy.maxCopyPositions} of ${R.maxOpenPositions} slots so one stays free for my own analysis` };
  if ([...state.positions.values()].some((x) => x.venue === (o.venue ?? 'hl') && x.coin === o.coin)) return { ok: false, reason: `already copying a ${o.coin} position` };
  const cd = state.copyCooldown.get(o.coin);
  if (cd && cd > now) return { ok: false, reason: `${o.coin} cooldown after stop-loss until ${new Date(cd).toISOString()}` };
  if ((o.venue ?? 'hl') === 'hl' ? hl.midAgeMs() > R.staleMs : !(o.priceAgeMs <= R.staleMs)) return { ok: false, reason: 'price not verified fresh (>10s)' };
  const equity = markEquity();
  const entryPx = entryFillFor(o.side, o.price);
  const stopPct = Math.min(o.stopPct ?? config.copy.stopPct, config.copy.stopMaxPct);   // 4%, and never wider
  const fin = guard.finalizeEntry({ side: o.side, equity, cash: p.cash, entry: entryPx, stop: o.side === 'short' ? entryPx * (1 + stopPct) : entryPx * (1 - stopPct), wanted: o.notional });
  if (!fin.ok || fin.notional < config.copy.minNotional) return { ok: false, reason: fin.ok ? `risk-based size would be only $${fin.notional.toFixed(2)} (below $${config.copy.minNotional} minimum / insufficient cash)` : fin.reasons.join('; ') };
  const notional = fin.notional, stop = fin.stop;
  const qty = notional / entryPx, fee = riskLib.feeOn(notional);
  const why = `Mirroring ${o.trader.slice(0, 10)}… (${(o.winRate * 100).toFixed(0)}% win rate, ${o.tier}): they ${(o.venue ?? 'hl') === 'hl' ? `went ${o.side}` : 'bought'} ${o.symbol ?? o.coin} at ${o.leaderPx}; we filled at ${entryPx.toPrecision(6)} (${((entryPx / o.leaderPx - 1) * 100).toFixed(2)}% vs theirs, ${((now - o.leaderTime) / 1000).toFixed(1)}s later).`;
  const row = await db.insertTrade({
    symbol: o.symbol ?? o.coin, signal_id: o.signalId ?? null, status: 'open', side: o.side, entry_price: entryPx, qty, notional, target_price: null, stop_price: stop,
    high_water: entryPx, rr: null, confluence_score: null, rationale: why, fee_entry: fee, source: o.source ?? 'copy_hyperliquid', source_trader: o.trader,
    leader_fill_price: o.leaderPx, leader_fill_time: new Date(o.leaderTime).toISOString(), leader_size: o.leaderSize,
    prediction: { mirror: true, k: o.k, trader: o.trader, win_rate: o.winRate, tier: o.tier, ...(o.extra ?? {}) }, evidence_used: why,
    expected_direction: o.side === 'short' ? 'down' : 'up', confidence: o.winRate * 100, market_regime: `BTC 1h ${state.btc.regime}`,
  });
  const id = row?.id ?? `mem-copy-${now}`;
  p.cash -= notional + fee;
  const pos = {
    id, venue: o.venue ?? 'hl', coin: o.coin, symbol: o.symbol ?? o.coin, extra: o.extra ?? null, side: o.side, qty, entry: entryPx, notional, fee, initCost: notional + fee, realized: 0,
    stop, target: null, trailing: null, highWater: entryPx, openedAt: now, rationale: why, lastPrice: o.price, leaderSize: o.leaderSize, stopPct,
    copy: { trader: o.trader, winRate: o.winRate, tier: o.tier, leaderPx: o.leaderPx, leaderTime: o.leaderTime, k: o.k, latencyMs: now - o.leaderTime },
    ctx: { conf: { notes: {}, technical: 0, rvol: 0, research: 0, derivatives: 0, total: 0 }, sig: { evidenceSummary: why, supporting: [], conflicting: [], confidence: o.winRate * 100 }, patterns: {}, btc: state.btc.regime },
  };
  state.positions.set(id, pos);
  persistPortfolio(true);
  logDecision('entered', o.symbol ?? o.coin, `PAPER ${o.side.toUpperCase()} ${qty.toPrecision(5)} @ ${entryPx.toPrecision(6)} ($${notional.toFixed(0)}, ${pct(notional / equity)} of equity) copying ${o.trader.slice(0, 8)}; hard stop ${stop.toPrecision(6)}`);
  return { ok: true, pos };
}

/** The leader added to their position: add proportionally (same caps, weighted-average entry). */
export async function addToCopyPosition(pos, addNotional, price, priceAgeMs = 0) {
  const p = state.portfolio;
  const gate = riskLib.tradingGate(p);
  if (!gate.allowed) return { ok: false, reason: `circuit breaker: ${gate.reason}` };
  const tg = traderStatus(pos.copy.trader);
  if (tg.blocked) return { ok: false, reason: `trader ${tg.label}` };
  if (pos.venue === 'hl' ? hl.midAgeMs() > R.staleMs : !(priceAgeMs <= R.staleMs)) return { ok: false, reason: 'price not verified fresh (>10s)' };
  const equity = markEquity();
  let add = Math.min(addNotional, guard.maxNotionalFor(equity, pos.stopPct ?? config.copy.stopPct) - pos.notional);
  if (add * (1 + R.feePct) > p.cash) add = p.cash / (1 + R.feePct);
  if (add < config.copy.minNotional) return { ok: false, reason: 'add would be below minimum size or exceed the 1%-risk / 30% cap' };
  const px = entryFillFor(pos.side, price), q = add / px, fee = riskLib.feeOn(add);
  p.cash -= add + fee;
  pos.entry = (pos.qty * pos.entry + q * px) / (pos.qty + q);
  pos.qty += q; pos.notional += add; pos.fee += fee; pos.initCost += add + fee;
  const sp = pos.stopPct ?? config.copy.stopPct;
  pos.stop = guard.keepStopTight(pos.side, pos.stop, pos.side === 'short' ? pos.entry * (1 + sp) : pos.entry * (1 - sp));   // averaging in must never widen the stop
  await db.updateTrade(pos.id, { qty: pos.qty, notional: pos.notional, entry_price: pos.entry, fee_entry: pos.fee, stop_price: pos.stop });
  logDecision('entered', pos.symbol, `added $${add.toFixed(0)} to the copied ${pos.side} (leader added); new avg entry ${pos.entry.toPrecision(6)}`);
  persistPortfolio(true);
  return { ok: true };
}

/** Price update for a Hyperliquid-venue position: track the best price and enforce the hard stop. */
export function onHlPrice(pos, price) {
  if (pos.closing) return;
  pos.lastPrice = price;
  if (pos.side === 'short' ? price < pos.highWater : price > pos.highWater) pos.highWater = price;
  if (pos.side === 'short' ? price >= pos.stop : price <= pos.stop) closePosition(pos, price, 'stop_loss');
}

/* ------------------------------------------------------------------ breakers */

function freeze(reason) {
  const p = state.portfolio;
  const until = Date.now() + R.freezeHours * 3600_000;
  if (p.freeze_until && new Date(p.freeze_until).getTime() >= until - 1000) return;
  p.freeze_until = new Date(until).toISOString(); p.freeze_reason = reason;
  logDecision('breaker', '*', `FREEZE ${R.freezeHours}h: ${reason}`);
  persistPortfolio(true);
}

/** Conditions that call for a freeze, each keyed by the trade that completed it. */
function breakerTriggers() {
  const out = [];
  const stops = state.closedToday.filter((t) => t.exit_reason === 'stop_loss');
  if (stops.length >= R.freezeStopLossesPerDay) out.push({ key: `stops:${stops[stops.length - 1].id}`, reason: `${stops.length} stop-loss hits today` });
  const last2 = state.closedToday.slice(-2);
  if (last2.length === 2 && last2.every((t) => t.final_pnl < 0) && last2[1].exitAt - last2[0].exitAt <= R.consecutiveLossWindowMin * 60_000) out.push({ key: `pair:${last2[1].id}`, reason: '2 consecutive losses within 60 minutes' });
  return out;
}

function checkBreakers() {
  const p = state.portfolio, now = Date.now();
  const today = utcDay(now);
  if (p.daily_date !== today) {
    const breached = p.halted_for_day;
    p.consecutive_loss_days = breached ? p.consecutive_loss_days + 1 : 0;
    if (p.consecutive_loss_days >= R.maxConsecutiveLossDays && !p.manual_review_required) {
      p.manual_review_required = true;
      logDecision('breaker', '*', `${p.consecutive_loss_days} consecutive -5% days: trading suspended until manual re-evaluation`);
    }
    p.daily_date = today; p.daily_start_equity = markEquity(); p.halted_for_day = false;
    state.closedToday = state.closedToday.filter((t) => utcDay(t.exitAt) === today);
    persistPortfolio(true);
  }
  const equity = markEquity();
  if (!p.halted_for_day && equity / p.daily_start_equity - 1 <= -R.dailyLossCapPct) {
    p.halted_for_day = true;
    logDecision('breaker', '*', `DAILY LOSS CAP: equity ${pct(equity / p.daily_start_equity - 1)} today, closing all positions and freezing until next UTC day`);
    for (const pos of [...state.positions.values()]) closePosition(pos, priceOf(pos), 'circuit_breaker_daily_loss');
    for (const pend of [...state.pending.values()]) failSignal(pend, 'skipped', 'daily loss cap hit');
    persistPortfolio(true);
  }
  for (const t of breakerTriggers()) {
    if (state.freezeKeys.has(t.key)) continue;
    state.freezeKeys.add(t.key);
    freeze(t.reason);
  }
}

export function clearManualReview() {
  const p = state.portfolio;
  p.manual_review_required = false; p.consecutive_loss_days = 0;
  logDecision('info', '*', 'manual review cleared by the operator: trading may resume');
  persistPortfolio(true);
}

/* ---------------------------------------------------------------- reflection */

/**
 * Post-mortem built from the decision's recorded inputs and the measured outcome: which evidence was right, which was wrong, how far price went for and against us.
 * Deterministic, so every trade (win or loss) always gets one; the LLM may add narrative on top but never replaces the measured facts.
 */
function postMortem(pos, trade, m) {
  const b = pos.ctx?.brain, win = trade.final_pnl > 0, r = (x) => `${(x * 100).toFixed(1)}%`;
  const right = [], wrong = [], why = [], patterns = [`exit:${trade.exit_reason}`, win ? 'win' : 'loss'];
  if (!b) {
    why.push(`${win ? 'won' : 'lost'} via ${trade.exit_reason}`);
    return { right, wrong, why, patterns, lesson: `${win ? 'Winning' : 'Losing'} trade on ${pos.symbol} exited via ${trade.exit_reason}; no structured entry evidence was stored for this position.` };
  }
  const tDist = pos.target ? pos.target / pos.entry - 1 : null, progress = tDist ? m.mfe / tDist : null;
  patterns.push(`setup:${b.setup?.name}`, `regime:${b.evidence?.regime}`);
  const strong = Object.entries(b.factors ?? {}).filter(([, v]) => v >= 0.4).map(([k, v]) => `${k} ${v}`);
  const weak = Object.entries(b.factors ?? {}).filter(([, v]) => v <= -0.2).map(([k, v]) => `${k} ${v}`);
  why.push(`price went ${r(m.mfe)} in favour and ${r(m.mae)} against over ${m.hours.toFixed(1)}h${progress != null ? `; the best point was ${(progress * 100).toFixed(0)}% of the way to the target` : ''}`);
  if (win) {
    right.push(`${b.setup?.label} read was right: ${strong.length ? `strong inputs held (${strong.join(', ')})` : 'edge was modest'}`);
    if (trade.exit_reason === 'trailing_stop') why.push('the Chandelier trail locked in the gain after the partial target');
  } else {
    if (strong.length) wrong.push(`inputs that looked strong but did not carry the trade: ${strong.join(', ')}`);
    if (weak.length) wrong.push(`inputs that were already weak at entry: ${weak.join(', ')}`);
    if (trade.exit_reason === 'stop_loss' && m.hours < 0.75) { wrong.push(`stopped within ${(m.hours * 60).toFixed(0)} min: buyers did not follow through after the confirmation candle`); patterns.push('fast-stop'); }
    if (progress != null && progress >= 0.5) { wrong.push(`price reached ${(progress * 100).toFixed(0)}% of the target before reversing: the move was real but the exit logic gave it back`); patterns.push('gave-back'); }
    if (pos.ctx.btc && pos.ctx.btc !== state.btc.regime) { wrong.push(`BTC 1h regime flipped from ${pos.ctx.btc} to ${state.btc.regime} during the trade`); patterns.push('btc-flip'); }
    if (trade.exit_reason === 'brain_sell') wrong.push(`structure broke after entry: ${pos.brain?.reasons?.join('; ') ?? 'see exit log'}`);
    if (b.evidence?.momentum?.overextended || (b.evidence?.momentum?.ext1h ?? 0) > 1.5) { wrong.push('price was already stretched above its 1h mean at entry'); patterns.push('stretched-entry'); }
  }
  const news = (b.evidence?.news?.events ?? []).slice(0, 3).map((e) => `${e.label} (${e.direction}, priced in: ${e.pricedIn})`);
  const lesson = `${win ? 'Worked' : 'Failed'}: ${b.setup?.label} in a ${String(b.evidence?.regime ?? '?').replace(/_/g, ' ')} market, score ${b.score}, R:R ${b.rr}. ${win ? `Reached ${r(m.mfe)} in ${m.hours.toFixed(1)}h.` : wrong[0] ?? `Lost ${r(Math.abs(trade.final_pnl_pct))} via ${trade.exit_reason}.`} (Measured, not narrated; the rule-learner only acts on patterns that repeat and validate.)`;
  return { right, wrong, why, patterns, news, lesson };
}

async function reflect(pos, trade, actual) {
  const win = trade.final_pnl > 0;
  const lessons = state.reflections.slice(0, 5).map((l) => ({ outcome: l.outcome, symbol: l.symbol, lesson: l.lesson }));
  const hours = (Date.now() - pos.openedAt) / 3600_000;
  const m = { mfe: favourable(pos), mae: pos.side === 'short' ? 0 : (pos.lowWater ?? pos.entry) / pos.entry - 1, hours };
  const pm = postMortem(pos, trade, m);
  if (pos.decisionId) learning.closeTrade(pos.id, { exitReason: trade.exit_reason, pnl: trade.final_pnl, pnlPct: trade.final_pnl_pct, R: pos.riskUsd > 0 ? trade.final_pnl / pos.riskUsd : undefined, rr: pos.rrEntry, mfe: m.mfe, mae: m.mae, hours, why: pm.why.join('; ') });
  let r = null;
  if (llmUsable() && pos.ctx?.brain) {
    r = await reflectOnTrade({ ...trade, holdMinutes: +(hours * 60).toFixed(1) }, { decision: { setup: pos.ctx.brain.setup, score: pos.ctx.brain.score, pUp: pos.ctx.brain.pUp, factors: pos.ctx.brain.factors, reasons: pos.ctx.brain.reasons, evidence: pos.ctx.brain.evidence }, measured: { ...m, why: pm.why, right: pm.right, wrong: pm.wrong }, entryRationale: pos.rationale }, lessons);
  }
  if (!r && pos.copy) {
    r = {
      actual_result: actual, indicators_correct: win ? [`trader's ${pos.side} call on ${pos.symbol} worked`] : [], indicators_wrong: win ? [] : [`trader's ${pos.side} call on ${pos.symbol} did not work out (exit: ${trade.exit_reason})`],
      news_impact: { mattered: [], irrelevant: [] },
      lesson: `Copied ${pos.copy.trader.slice(0, 8)} (${(pos.copy.winRate * 100).toFixed(0)}% win rate) ${pos.side} ${pos.symbol}: ${win ? 'won' : 'lost'} via ${trade.exit_reason}; entry was ${((pos.entry / pos.copy.leaderPx - 1) * 100).toFixed(2)}% vs the leader after ${(pos.copy.latencyMs / 1000).toFixed(1)}s. (Legacy copy position: copy entries are now disabled.)`,
      patterns: [`copy:${trade.exit_reason}`, win ? 'copy win' : 'copy loss'],
    };
  }
  const own = {
    actual_result: `${actual} ${pm.why.join('; ')}.`, indicators_correct: pm.right, indicators_wrong: pm.wrong,
    news_impact: { mattered: win ? pm.news ?? [] : [], irrelevant: win ? [] : pm.news ?? [] }, lesson: pm.lesson, patterns: pm.patterns,
  };
  const out = r ? { ...own, lesson: r.lesson || own.lesson, news_impact: r.news_impact?.mattered?.length || r.news_impact?.irrelevant?.length ? r.news_impact : own.news_impact, indicators_correct: [...new Set([...own.indicators_correct, ...(r.indicators_correct ?? [])])].slice(0, 12), indicators_wrong: [...new Set([...own.indicators_wrong, ...(r.indicators_wrong ?? [])])].slice(0, 12), patterns: [...new Set([...own.patterns, ...(r.patterns ?? [])])] } : own;
  const b = pos.ctx?.brain;
  const row = {
    trade_id: pos.id.startsWith('mem-') ? null : pos.id, symbol: pos.symbol, outcome: win ? 'win' : 'loss',
    prediction: pos.copy ? `Mirror ${pos.copy.trader.slice(0, 10)}'s ${pos.side} on ${pos.symbol} (their win rate ${(pos.copy.winRate * 100).toFixed(0)}%), hard stop ${pos.stop.toPrecision(6)}`
      : b ? `${b.setup?.label}: expected up toward ${pos.target?.toPrecision(6)} with stop ${pos.stop.toPrecision(6)} within ~${b.holdHours}h (edge score ${b.score}, P(target first) ${(b.pUp * 100).toFixed(0)}%)` : `Expected up toward ${pos.target?.toPrecision(6)} with stop ${pos.stop.toPrecision(6)}`,
    evidence_used: b ? b.reasons.join(' | ') : pos.rationale, expected_direction: pos.side === 'short' ? 'down' : 'up', confidence: b ? b.pUp * 100 : Number(pos.ctx?.sig?.confidence ?? 0),
    actual_result: out.actual_result || actual, indicators_correct: out.indicators_correct, indicators_wrong: out.indicators_wrong, news_impact: out.news_impact,
    candle_pattern: pos.copy ? `copy of ${pos.copy.trader.slice(0, 8)}` : (b?.evidence?.candles ?? []).join(', ') || 'none', market_regime: b ? `${b.evidence?.regime}; BTC 1h ${pos.ctx.btc}` : `BTC 1h ${pos.ctx?.btc}`, final_pnl: trade.final_pnl, lesson: out.lesson, patterns: out.patterns,
  };
  const saved = row.trade_id ? await db.insertReflection(row) : null;
  state.reflections.unshift({ ...(saved ?? row), created_at: saved?.created_at ?? new Date().toISOString() });
  if (state.reflections.length > 100) state.reflections.length = 100;
  logDecision('reflection', pos.symbol, `post-mortem recorded (${row.outcome}): ${out.lesson}`);
  learning.learnRules();
}

/* ------------------------------------------------------------- learning cycle */

/** Measure matured outcomes (traded and counterfactual), re-validate the rules walk-forward, and review the biggest moves the AI missed. */
async function learningCycle() {
  const now = Date.now();
  await learning.resolveOutcomes((sym) => { const c = state.coins.get(sym)?.coin; if (!c?.product) throw new Error('unknown product'); return fetchCandles(c.product, 900); }, now);
  learning.resolveNews((sym) => state.coins.get(sym)?.h1series ?? null, (sym) => state.coins.get(sym)?.ta?.['1h']?.atrPct ?? 0.01, now);   // what did price actually do after each headline?
  learning.learnRules(now);
  if (now - (learning.journal.missedAt || 0) >= config.brain.missedEveryMs) {
    const all = [...state.coins.values()];
    const withBars = all.filter((cs) => cs.coin?.tradable && cs.h1series?.length).map((cs) => ({ symbol: cs.symbol, h1: cs.h1series }));
    // tradable coins the radar saw rip over 24h but that never had candles analysed: "not analysed" is itself a miss worth reporting
    const coarse = all.filter((cs) => cs.coin?.tradable && !cs.h1series?.length && (cs.coin.chg24h ?? 0) >= config.brain.missedMovePct * 1.25).map((cs) => ({ symbol: cs.symbol, gain: cs.coin.chg24h }));
    learning.findMissed(withBars, now, coarse);
  }
  learning.save();
}

/* ------------------------------------------------------------- housekeeping */

async function housekeeping() {
  const now = Date.now();
  for (const p of [...state.pending.values()]) {
    const z = p.plan, px = feed.price(p.product);
    if (z && px != null && px > z.hi + config.brain.cancelBeyond * (z.atr ?? 0)) { failSignal(p, 'skipped', `price moved materially away from the planned entry (${px} vs zone top ${z.hi.toPrecision(6)}): cancelled and recalculated rather than chased`); continue; }
    if (now - p.createdAt > config.confirmWindowMs) {
      const intact = px != null && p.decision?.stop != null && px > p.decision.stop && (!z || (px >= z.lo && px <= z.hi + config.brain.zoneTolerance * (z.atr ?? 0)));
      if (!p.reassessed && intact) { p.reassessed = true; p.createdAt = now; logDecision('info', p.symbol, 'confirmation window elapsed but the structure is intact and price is still in the zone: reassessed, waiting one more window'); }
      else failSignal(p, 'confirmation_failed', `no candle confirmation within ${config.confirmWindowMs / 60000} minutes${p.reassessed ? ' (and one reassessment)' : ''}`);
    }
  }
  // Stale-price fallback for open positions: never leave a position unmonitored.
  for (const pos of state.positions.values()) {
    if (pos.venue) continue;
    if (feed.tickAgeMs(pos.product) > R.staleMs && now - (pos.lastRest ?? 0) > 5000) {
      pos.lastRest = now;
      const fp = await feed.freshPrice(pos.product, R.staleMs);
      if (fp.price != null) onTick(pos.product, fp.price);
      else if (now - (pos.lastStaleWarn ?? 0) > 60_000) { pos.lastStaleWarn = now; logDecision('info', pos.symbol, 'price data stale: position cannot be verified right now'); }
    }
  }
  checkBreakers();
}

export function dataHealth() {
  const age = feed.feedAgeMs();
  return { wsConnected: feed.connected, feedAgeMs: Number.isFinite(age) ? age : null, feedStale: age > R.staleMs, sources: state.sources, universeAt: universe.updatedAt, cmcAvailable: universe.cmcAvailable, universeError: universe.lastError, llm: llmAvailable(), supabase: !!config.keys.supabaseKey };
}

/* --------------------------------------------------------------------- start */

export async function start() {
  learning.load(); learning.learnRules(); discovery.loadDiscovered();
  const saved = await db.loadPortfolio();
  state.portfolio = saved ?? {
    id: 1, starting_capital: R.startingCapital, cash: R.startingCapital, equity: R.startingCapital, realized_pnl: 0,
    daily_date: utcDay(), daily_start_equity: R.startingCapital, halted_for_day: false, consecutive_loss_days: 0,
    manual_review_required: false, freeze_until: null, freeze_reason: null,
  };
  for (const k of ['cash', 'equity', 'realized_pnl', 'starting_capital', 'daily_start_equity']) state.portfolio[k] = Number(state.portfolio[k]);
  if (!saved) await db.savePortfolio(state.portfolio);

  const [reflections, signals, open, today, recent] = await Promise.all([
    db.recentReflections(100), db.recentSignals(80), db.openTrades(), db.closedTradesSince(utcDay() + 'T00:00:00Z'), db.recentTrades(300),
  ]);
  state.recentClosed = (recent ?? []).filter((t) => t.status === 'closed' && t.exit_time).map(historyFromDb).sort((a, b) => b.closedAt - a.closedAt).slice(0, 200);
  state.reflections = reflections ?? [];
  state.closedTotal = (await db.countClosedTrades()) ?? state.recentClosed.length;
  for (const a of new Set(state.recentClosed.map((t) => t.trader).filter(Boolean))) {
    const s = traderStatus(a);
    if (s.losses >= 2) state.rescore.add(a);
    if (s.blocked) logDecision('info', '*', `copy trader ${a.slice(0, 8)}: ${s.label}`);
  }
  for (const s of (signals ?? []).slice().reverse()) {
    if (s.status === 'skipped' || s.status === 'confirmation_failed') state.decisions.unshift({ at: new Date(s.created_at).getTime(), type: 'skipped', symbol: s.symbol, message: s.skip_reason ?? s.status });
  }
  state.closedToday = (today ?? []).map((t) => ({ ...t, final_pnl: Number(t.final_pnl), exitAt: new Date(t.exit_time).getTime() }));

  for (const t of breakerTriggers()) state.freezeKeys.add(t.key);

  for (const t of open ?? []) {
    const isCopy = String(t.source ?? '').startsWith('copy_');
    state.positions.set(t.id, {
      id: t.id, symbol: t.symbol, signalId: t.signal_id, side: t.side ?? 'long', qty: Number(t.qty), entry: Number(t.entry_price), notional: Number(t.notional),
      fee: Number(t.fee_entry), initCost: Number(t.notional) + Number(t.fee_entry), realized: Number(t.realized_partial ?? 0),
      stop: Number(t.stop_price), target: t.target_price ? Number(t.target_price) : null, trailing: t.trailing_stop ? Number(t.trailing_stop) : null,
      highWater: Number(t.high_water ?? t.entry_price), openedAt: new Date(t.entry_time).getTime(), rationale: t.rationale, lastPrice: null,
      ...(isCopy
        ? { venue: t.source === 'copy_zerion' ? 'onchain' : 'hl', extra: t.prediction ?? null, coin: t.source === 'copy_zerion' ? (t.prediction?.assetKey ?? t.symbol) : t.symbol, leaderSize: Number(t.leader_size ?? 0), copy: { trader: t.source_trader, winRate: Number(t.confidence ?? 0) / 100, tier: t.prediction?.tier ?? 'minimum', leaderPx: Number(t.leader_fill_price), leaderTime: new Date(t.leader_fill_time).getTime(), k: Number(t.prediction?.k ?? 0), latencyMs: 0 } }
        : { product: t.prediction?.product ?? `${t.symbol}-USD`, mode: t.prediction?.mode ?? 'normal', xkind: t.prediction?.xkind ?? null, rrEntry: Number(t.rr) || undefined, riskUsd: Number(t.prediction?.riskUsd) || undefined, decisionId: t.prediction?.decisionId ?? null, lowWater: Number(t.entry_price), horizonHours: clampN(Number(t.prediction?.timeframe_hours) || 24, 1, 72), trigger: { kind: t.entry_trigger ?? 'scan', reasons: t.prediction?.trigger?.reasons ?? [] } }),
      ctx: { conf: { notes: {}, technical: 0, rvol: 0, research: 0, derivatives: 0, total: Number(t.confluence_score ?? 0) }, sig: { evidenceSummary: t.evidence_used ?? '', supporting: [], conflicting: [], confidence: Number(t.confidence ?? 0) }, patterns: {}, btc: String(t.market_regime ?? '').split('BTC 1h ')[1] ?? t.market_regime,
        brain: !isCopy && t.prediction?.setup ? { setup: { name: t.prediction.setup, label: t.prediction.setup.replace(/_/g, ' ') }, score: Number(t.confluence_score ?? 0), pUp: Number(t.prediction.p_up ?? 0), ev: t.prediction.ev, rr: Number(t.rr ?? 0), holdHours: t.prediction.timeframe_hours, factors: t.prediction.factors ?? {}, reasons: String(t.evidence_used ?? '').split(' | '), evidence: t.prediction.evidence ?? {}, id: t.prediction.decisionId } : null },
    });
  }
  if (state.positions.size) log(`Resumed ${state.positions.size} open paper position(s) from Supabase`);

  feed.on('tick', onTick);
  feed.on('candle', (product, candle) => { onCandleClosed(product, candle); onMomentumCheck(product); });
  feed.setProducts([...state.positions.values()].map((p) => p.product).filter(Boolean));
  feed.start();
  for (const pos of state.positions.values()) if (pos.product) feed.backfill1m(pos.product);   // a resumed position needs candle history for its exit rules straight away
  setInterval(() => housekeeping().catch((e) => warn('housekeeping', e.message)), 1000);
  setInterval(() => moverWatch().catch((e) => warn('mover watch', e.message)), config.movers.fastCheckMs);
  setInterval(() => hotRefresh().catch((e) => warn('hot refresh', e.message)), Z.hotEveryMs);          // independent of the scan and of the full sweep
  setInterval(() => tailRefresh().catch((e) => warn('tradable refresh', e.message)), Z.tradableEveryMs);
  setInterval(() => persistPortfolio(), 15_000);
  setInterval(() => learning.save(), 30_000);
  setInterval(() => learningCycle().catch((e) => warn('learning cycle', e.message)), 10 * 60_000);
  setTimeout(() => learningCycle().catch((e) => warn('learning cycle', e.message)), 3 * 60_000);

  (async () => {
    for (;;) {
      await runScan();
      await sleep(config.scanIntervalMs);
    }
  })();
}

/* ----------------------------------------------------------------- snapshot */

export const isReady = () => !!state.portfolio;

const lrCache = { at: 0, v: null };
const learningReport = () => { if (Date.now() - lrCache.at > 10_000) lrCache.v = learning.report(), lrCache.at = Date.now(); return lrCache.v; };

/** What could hurt right now, from the same inputs the Brain used (regime, macro, news, risk controls, data and model health). Sorted by severity. */
function buildRisks() {
  const r = [], b = state.brain, p = state.portfolio, add = (severity, kind, text) => r.push({ severity: +severity.toFixed(2), kind, text });
  if (b.regime) {
    if (b.regime.label === 'risk_off_downtrend') add(0.9, 'market', 'BTC is in a downtrend on both the 4h and 1h: the AI will not open longs');
    else if (b.regime.score < -0.25) add(0.5, 'market', `bearish regime (${b.regime.label.replace(/_/g, ' ')}): longs are still judged on their own merits, but at a ${(b.regime.probShiftLong * 100).toFixed(1)}pt probability shift and ${b.regime.riskMult}x size`);
    if (b.breadth != null && b.breadth < 0.25) add(0.5, 'market', `weak breadth: only ${(b.breadth * 100).toFixed(0)}% of analysed coins are in a 1h uptrend`);
  }
  for (const x of b.market?.risks ?? []) add(x.severity, x.kind, `${x.text} [${x.source}]`);
  const danger = new Map();                                                    // one line per distinct event, listing the coins it blocks
  for (const d of [...(b.avoid ?? []), ...(b.watch ?? []), ...(b.opportunities ?? [])]) { const v = [...(d.cautions ?? []), ...d.vetoes].find((x) => x.startsWith('negative news') || x.startsWith('catastrophic')); if (v) danger.set(v, [...(danger.get(v) ?? []), d.symbol]); }
  for (const [v, syms] of danger) { const u = [...new Set(syms)]; add(0.55, 'news', `${v} (blocks ${u.slice(0, 6).join(', ')}${u.length > 6 ? ` +${u.length - 6} more` : ''})`); }
  const gate = riskLib.tradingGate(p); if (!gate.allowed) add(0.95, 'risk-control', `trading is blocked: ${gate.reason}`);
  const eq = markEquity(), dd = eq / p.daily_start_equity - 1;
  if (dd <= -0.03) add(0.6, 'risk-control', `today's equity is ${(dd * 100).toFixed(1)}% (trading halts at -5%)`);
  const exposure = [...state.positions.values()].reduce((a, x) => a + x.notional, 0) / eq;
  if (exposure > 0.5) add(0.4, 'risk-control', `${(exposure * 100).toFixed(0)}% of equity is deployed in open positions`);
  for (const pos of state.positions.values()) if (pos.brain?.sell) add(0.7, 'position', `${pos.symbol}: structure is breaking (${pos.brain.reasons[0]}); a second confirming scan exits the trade`);
  const down = Object.entries(state.sources).filter(([, v]) => !v.ok).map(([k]) => k);
  if (down.length) add(0.35, 'data', `data sources unavailable: ${down.slice(0, 5).join(', ')}: the Brain is reading less of the picture`);
  const lr = learningReport();
  if (lr.measured < 60) add(0.5, 'model', `the Brain's probabilities are an unvalidated prior until 60+ outcomes are measured (${lr.measured} so far): treat scores as a ranking, not a promise`);
  if (!llmAvailable()) add(0.15, 'ai', 'no LLM key: the optional second-look reviewer is off (the Brain itself does not need it)');
  return r.sort((a, b2) => b2.severity - a.severity).slice(0, 12);
}

function brainSnapshot() {
  const b = state.brain, Bc = config.brain;
  return {
    at: b.at, regime: b.regime, market: b.market ? { effect: b.market.effect, eventCount: b.market.eventCount, risks: b.market.risks } : null, counts: b.counts, analysed: b.analysed, breadth: b.breadth ?? null,
    opportunities: b.opportunities, watch: b.watch, avoid: b.avoid, events: (b.events ?? []).slice(0, 14),
    positions: [...state.positions.values()].filter((x) => !x.copy && !x.venue).map((x) => ({ symbol: x.symbol, action: x.brain?.action ?? 'HOLD', reasons: x.brain?.reasons ?? ['waiting for the first structure read after the entry'], setup: x.ctx?.brain?.setup?.label ?? null, invalidation: x.brain?.invalidation ?? null })),
    funnel: state.funnel ?? null, mkt: state.mkt ?? null, shortsExecuted: config.brain.allowShortTrades,
    risks: buildRisks(), learning: (() => { const lr = learningReport(); return { ...lr, exploration: { ...lr.exploration, paused: explorationPause(), open: [...state.positions.values()].filter((x) => x.mode === 'exploration').length } }; })(),
    rules: { minComposite: Bc.minComposite, weights: Bc.composite, chaseWarn: Bc.chaseWarn, chaseVeto: Bc.chaseVeto, minEV: Bc.minEV, evSeK: Bc.evSeK, dataMinN: Bc.dataMinN, discovered: discovery.discoveredRules().length, minRR: R.minRR, copyTrading: 'data input only (1% weight): can never open, size or veto a trade' },
  };
}

export function snapshotForUi() {
  const now = Date.now();
  const equity = markEquity();
  const p = state.portfolio;
  const rows = [...universe.coins.values()].sort((a, b) => a.rank - b.rank).map((coin) => {
    const cs = state.coins.get(coin.symbol);
    const f = coin.product ? feed.forming1m(coin.product) : null;
    const pos = [...state.positions.values()].find((x) => x.symbol === coin.symbol);
    const pend = [...state.pending.values()].find((x) => x.symbol === coin.symbol);
    let signal = '—';
    if (pos) signal = 'IN POSITION';
    else if (pend) signal = 'AWAITING CONFIRM';
    else if (cs?.brain) signal = `${cs.brain.action} · ${cs.brain.cls}`;
    return {
      rank: coin.rank, cgRank: coin.cgRank, cmcRank: coin.cmcRank, volume24h: coin.volume24h ?? 0, thin: (coin.volume24h ?? 0) < U.minVolume24hUsd, discrepancy: coin.discrepancyNote, symbol: coin.symbol, name: coin.name, product: coin.product,
      price: (coin.product && feed.price(coin.product)) || coin.price, candle: f ? { o: f.o, h: f.h, l: f.l, c: f.c } : null,
      signal, cls: cs?.brain?.cls ?? null, pUp: cs?.brain?.pUp ?? null, score: cs?.brain?.score ?? null, rvol: cs?.rvol ?? null,
      funding: cs?.deriv?.ok ? cs.deriv.data.fundingRatePct : null, sentiment: cs?.sentiment?.score ?? null, sentimentCount: cs?.sentiment?.count ?? 0,
      tradable: coin.tradable, excluded: coin.excludedReason, health: cs?.health?.ok ? 'ok' : cs?.health?.reason ?? 'pending',
      cooldownUntil: coin.cooldownUntil && coin.cooldownUntil > now ? coin.cooldownUntil : null,
      stale: coin.product ? feed.tickAgeMs(coin.product) > R.staleMs : null,
      ...(cs ? rowActivity(cs) : {}),
    };
  });
  const positions = [...state.positions.values()].map((x) => {
    const px = priceOf(x), ex = exitFillFor(x.side, px);
    const net = (x.realized ?? 0) + x.qty * (x.side === 'short' ? x.entry - ex : ex - x.entry) - riskLib.feeOn(x.qty * ex) - x.fee;
    return {
      id: x.id, mode: x.mode ?? 'normal', symbol: x.symbol, side: x.side ?? 'long', source: x.copy ? 'copy' : 'strategy', origin: x.copy ? 'mimic' : 'own', trigger: x.trigger ?? null, venue: x.venue ?? 'coinbase', trader: x.copy?.trader ?? null, traderWinRate: x.copy?.winRate ?? null,
      leaderPx: x.copy?.leaderPx ?? null, entry: x.entry, price: px, target: x.target, stop: x.stop, trailing: x.trailing,
      rr: x.target ? (x.target - x.entry) / (x.entry - x.stop) : null, qty: x.qty, notional: x.notional, pnl: net, pnlPct: net / (x.initCost ?? (x.notional + x.fee)), openedAt: x.openedAt, why: x.rationale,
    };
  });
  return {
    now, paper: true,
    portfolio: { ...p, equity, dailyPnlPct: equity / p.daily_start_equity - 1, gate: riskLib.tradingGate(p) },
    btc: state.btc, scan: state.scan, health: dataHealth(), rows, positions,
    history: historySummary(),
    tradeCount: state.closedTotal,
    radar: {
      monitored: radarState.rows.size, tradable: universe.coins.size, watchOnly: Math.max(0, radarState.rows.size - universe.coins.size),
      sweepAt: radarState.at || null, sweeping: radarState.running, partial: radarState.partial, error: radarState.error,
      hotAt: radarState.hotAt || null, tailAt: radarState.tailAt || null, nextSweepAt: radarState.at ? radarState.at + (radarState.partial ? Z.retryMs : Z.everyMs) : null, coingecko: cgStats(),
      shortlistSize: state.shortlist.size, shortlistTarget: Z.shortlistSize, researchMax: Z.researchMax,
      research: { ...llmStats, rate: llmStats.signals ? llmStats.signalsOk / llmStats.signals : null, providers: llmProviders(), resumeAt: llmResumeAt() }, shortlist: state.shortlist.top, researchQueue: state.researchQueue, rejected: state.rejected, watchMovers: watchOnlyMovers(10),
    },
    newsFeed: state.newsFeed,
    decisions: state.decisions.slice(0, 100), reflections: state.reflections.slice(0, 40),
    pending: [...state.pending.values()].map((x) => ({ symbol: x.symbol, refPrice: x.refPrice, createdAt: x.createdAt, score: x.decision?.score ?? null })),
    brain: brainSnapshot(),
    limits: { minConfluence: R.minConfluence, minRR: R.minRR, maxPositions: R.maxOpenPositions },
  };
}
export const __test = { chandelierStop, onTick, onMomentumCheck };
