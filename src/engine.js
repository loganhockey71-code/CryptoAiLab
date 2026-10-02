// Scan -> validate -> analyze -> candidate -> candle confirm -> risk filter -> enter -> monitor -> trail -> exit -> P&L -> post-mortem -> lessons -> resume.
// PAPER ONLY: this module never talks to any order endpoint. Positions are simulated in memory + Supabase.
import { config, log, warn } from './config.js';
import { db } from './db.js';
import { feed, fetchCandles, loadProducts } from './exchange.js';
import { hl } from './hyperliquid.js';
import { onchainPx } from './onchainprices.js';
import { refreshUniverse, restoreCooldowns, universe, cgTrending, radar as radarState, watchOnlyMovers } from './universe.js';
import * as radarLib from './radar.js';
import { snapshot, aggregate, rvol as calcRvol, atr, ema, rsi, candlePattern } from './indicators.js';
import * as src from './sources.js';
import { generateSignal, reflectOnTrade, llmAvailable } from './research.js';
import * as riskLib from './risk.js';
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
  if (!c) { c = { symbol, snaps: {}, rvol: null, atr15: null, deriv: null, sentiment: null, health: { ok: false, reason: 'not scanned yet' }, partialScore: null, score: null, signal: null, patterns: {} }; state.coins.set(symbol, c); }
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

/* ------------------------------------------------------------ self-learning */

// Bounded, symbol-specific nudge to research confidence. It can NEVER touch risk limits or breakers.
function historyMultiplier(symbol) {
  const recent = state.reflections.filter((r) => r.symbol === symbol).slice(0, 5);
  if (recent.length < 3) return 1;
  const wins = recent.filter((r) => r.outcome === 'win').length, losses = recent.length - wins;
  if (losses >= 3 && losses > wins) return 0.9;
  if (wins >= 4) return 1.05;
  return 1;
}

function patternStats() {
  const m = new Map();
  for (const r of state.reflections) for (const p of r.patterns || []) {
    const s = m.get(p) || { pattern: p, wins: 0, total: 0 };
    s.total++; if (r.outcome === 'win') s.wins++;
    m.set(p, s);
  }
  return [...m.values()].filter((s) => s.total >= 3).map((s) => ({ ...s, winRate: +(s.wins / s.total).toFixed(2) }));
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
    else if (priceDiff > ((Date.now() - (coin.priceAt ?? 0)) < 10 * 60_000 ? 0.05 : 0.25)) cs.health = { ok: false, reason: `contradictory price: exchange ${last5.c} vs CoinGecko ${coin.price}` };
    else cs.health = { ok: true, reason: null, checkedAt: Date.now() };
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

function partialScore(cs) {
  if (!cs.health.ok) return null;
  const t = riskLib.technicalScore(cs.snaps), v = riskLib.rvolScore(cs.rvol);
  return { technical: t.score, rvol: v.score, total: t.score + v.score };
}

function recordSkipped(cs, reason, extra = {}) {
  logDecision('skipped', cs.symbol, reason);
  return db.insertSignal({
    symbol: cs.symbol, direction: extra.direction ?? null, confidence: extra.confidence ?? null,
    reference_price: feed.price(cs.coin.product), btc_regime: state.btc.regime, status: 'skipped', skip_reason: reason,
    confluence: extra.confluence ?? null, confluence_score: extra.confluence?.total ?? null, evidence: extra.evidence ?? null,
  });
}

const compactPolitics = (p) => (p?.ok ? p.data.slice(0, 40).map((i) => ({ source: i.source, tier: i.tier, kind: i.kind, ageHours: i.publishedAt ? +((Date.now() - i.publishedAt) / 3600_000).toFixed(1) : null, title: i.title.slice(0, 200) })) : []);

async function runScan() {
  const s = state.scan;
  s.running = true; s.startedAt = Date.now(); s.lastError = null; s.progress = 'refreshing universe';
  try {
    if (Date.now() - state.productsAt > 3600_000 || !state.productSet.size) {
      state.productSet = await loadProducts(); state.productsAt = Date.now();
    }
    const changes = await refreshUniverse(state.productSet);
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

    // BTC first so the regime gate is current before anything else is evaluated.
    tradable.sort((a, b) => (a.symbol === 'BTC' ? -1 : b.symbol === 'BTC' ? 1 : a.cgRank - b.cgRank));
    for (const c of tradable) coinState(c.symbol).coin = c;
    const prio = new Map(tradable.map((c) => [c.symbol, priorityOf(state.coins.get(c.symbol))]));
    const ranked = [...prio.entries()].sort((a, b) => b[1].score - a[1].score);
    const shortlist = new Set(ranked.slice(0, Z.shortlistSize).map(([sym]) => sym));
    for (const pos of state.positions.values()) shortlist.add(pos.symbol);
    state.shortlist = { size: shortlist.size, top: ranked.slice(0, 25).map(([sym, p]) => ({ symbol: sym, score: +p.score.toFixed(0), reasons: p.reasons })) };
    // The shortlist is refreshed with candles every scan; everyone else every tailEvery-th scan (staggered) and on first sight, so any coin can move up the queue.
    const todo = tradable.filter((c, idx) => c.symbol === 'BTC' || shortlist.has(c.symbol) || !state.coins.get(c.symbol)?.snaps?.['1h'] || (idx + s.count) % U.tailEvery === 0)
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

    state.trending = await cgTrending();
    state.ctx = { news, macro, bills, onchain, politics };
    s.progress = 'evaluating setups';
    await evaluateCandidates({ news, macro, bills, onchain, politics });
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
function priorityOf(cs) {
  if (!cs?.coin) return { score: 0, reasons: [] };
  const sm = smartMoneyProvider ? smartMoneyProvider(cs.symbol) : null;
  return radarLib.radarPriority(cs.coin, { rvol: cs.rvol, smartMoney: sm, sentiment: cs.sentiment, partial: cs.partialScore?.total, partialDelta: cs.partialDelta });
}

/** Illiquid, tiny, manipulated-looking or data-poor coins are rejected outright. Returns { code, text } or null. */
function rejectFor(cs) {
  const r = radarLib.rejectReason(cs?.coin);
  if (r) return r;
  const sn = cs.snaps ?? {};
  if (!sn['1h'] || !sn['15m'] || !sn['5m']) return { code: 'insufficient_data', text: 'insufficient candle history (need 55+ candles on 1h, 15m and 5m)' };
  return null;
}

const rowActivity = (cs) => { const a = activity(cs); return { chg1h: a.h1, chg24h: a.h24, hot: a.hot, hotReasons: a.reasons, dump: a.dump }; };

/* ------------------------------------------------------------ evaluation */

/**
 * Full independent check of ONE asset. It only becomes a candidate if it passes, on its own merits:
 * technical + volume, smart money, research, and the 80/100 confluence; candle confirmation and every risk filter come after.
 * A trending move helps an asset get looked at; it never lowers any of these bars.
 */
async function evaluateCoin(cs, trigger, ctxSources, lessons, stats) {
  if (cs.evaluating) return;
  cs.evaluating = true;
  try { return await evaluateCoinInner(cs, trigger, ctxSources, lessons, stats); } finally { cs.evaluating = false; }
}

async function evaluateCoinInner(cs, trigger, ctxSources, lessons, stats) {
  const product = cs.coin.product;
  const fp = await feed.freshPrice(product, R.evalStaleMs);     // evaluation tolerates 30s; the execution price is re-verified at 10s right before any entry (tryEnter)
  if (fp.price == null) { await recordSkipped(cs, `price stream not verified fresh (age ${Math.round(fp.ageMs / 1000)}s > ${R.evalStaleMs / 1000}s): data unreliable`, { evidence: { trigger } }); return; }
  if (!cs.partialScore || cs.partialScore.total < 30) { await recordSkipped(cs, `technical + volume too weak (${cs.partialScore ? cs.partialScore.total.toFixed(1) : 'n/a'}/50): confluence cannot reach ${R.minConfluence}`, { evidence: { trigger } }); return; }

  // Smart money = derivatives positioning (funding / open interest) + what our >=75%-win-rate tracked traders hold in this coin right now.
  const sm = smartMoneyProvider ? smartMoneyProvider(cs.symbol) : null;
  const smB = riskLib.smartMoneyBonus(sm);
  const deriv = await src.derivatives(cs.symbol); noteSource(deriv); cs.deriv = deriv;
  const d = riskLib.derivativesScore(deriv, cs.priceUp);
  const smartScore = Math.max(0, Math.min(25, d.score + smB.bonus));
  if (sm && sm.net < 0) { await recordSkipped(cs, `smart-money requirement failed: ${smB.note}`, { evidence: { trigger, smartMoney: sm } }); return; }
  if (smartScore < R.minComponent) { await recordSkipped(cs, `smart-money requirement not met: ${smartScore.toFixed(1)}/25 < ${R.minComponent} (${d.note}; ${smB.note})`, { evidence: { trigger, smartMoney: sm } }); return; }
  if (cs.partialScore.total + smartScore + 25 < R.minConfluence) {
    await recordSkipped(cs, `confluence cannot reach ${R.minConfluence}: technical+RVOL ${cs.partialScore.total.toFixed(1)} + smart money ${smartScore.toFixed(1)} + max research 25`, { evidence: { trigger } });
    return;
  }

  const provenance = {
    candles: { source: 'coinbase-exchange', tier: 1, at: cs.health.checkedAt }, priceAgeMs: fp.ageMs,
    derivatives: { source: deriv.source, tier: 2, at: deriv.fetchedAt },
    macro: { source: 'fred', tier: 3, ok: ctxSources.macro.ok, at: ctxSources.macro.fetchedAt },
    legislation: { source: 'congress.gov', tier: 3, ok: ctxSources.bills.ok, at: ctxSources.bills.fetchedAt },
    politics: { source: 'white house, federal register, fed, sec, cftc, bbc, npr, cnbc, google news, truth social mirror', tier: '3/4', ok: ctxSources.politics.ok, at: ctxSources.politics.fetchedAt },
    onchain: { source: 'etherscan', tier: 4, ok: ctxSources.onchain.ok, at: ctxSources.onchain.fetchedAt },
    news: { source: 'coindesk+cointelegraph rss', tier: 4, ok: ctxSources.news.ok, at: ctxSources.news.fetchedAt },
  };
  const tfSummary = Object.fromEntries(Object.entries(cs.snaps).map(([k, v]) => [k, v && { trendUp: v.trendUp, rsi: v.rsi && +v.rsi.toFixed(1), macdHist: v.macdHist, ema20: v.ema20, ema50: v.ema50 }]));
  const act = activity(cs);
  const sig = await generateSignal({
    symbol: cs.symbol, name: cs.coin.name, stopBand: riskLib.stopBand(cs.symbol, cs.coin.rank), targetBand: R.targetBands[riskLib.stopBand(cs.symbol, cs.coin.rank).tier], price: fp.price, btcRegime: state.btc.regime, timeframes: tfSummary, rvol: cs.rvol,
    derivatives: deriv.data, macro: ctxSources.macro.data, legislation: ctxSources.bills.data, onchain: ctxSources.onchain.data, politics: compactPolitics(ctxSources.politics),
    news: cs.sentiment ? { coin: cs.sentiment, market: (ctxSources.news.data || []).slice(0, 8) } : { market: (ctxSources.news.data || []).slice(0, 8) },
    activity: { whySelected: trigger.kind === 'mover' ? 'unusually active / trending' : 'regular scan', flags: act.reasons, change1h: pct(act.h1), change24h: act.h24 == null ? null : pct(act.h24) },
    smartMoney: sm ? { trackedTradersLong: sm.longs, trackedTradersShort: sm.shorts, detail: sm.traders.map((t) => ({ side: t.side, winRate: +t.winRate.toFixed(2) })) } : 'no tracked trader currently holds this coin',
    provenance,
  }, lessons.map((l) => ({ outcome: l.outcome, symbol: l.symbol, lesson: l.lesson })));
  if (!sig) { await recordSkipped(cs, 'Research Brain unavailable or returned no usable signal after retries: the setup was NOT judged, will be retried', { evidence: { trigger } }); return 'ai_failed'; }
  cs.lastLlmAt = Date.now();

  const mult = historyMultiplier(cs.symbol);
  sig.confidence = Math.min(100, sig.confidence * mult);
  const conf = riskLib.confluence({ snaps: cs.snaps, rvol: cs.rvol, signal: sig, derivatives: deriv, priceUp: cs.priceUp, smartMoney: sm });
  cs.score = conf.total; cs.signalFresh = Date.now();
  const gates = riskLib.requirements(conf, sm);
  conf.gates = gates;
  const evidence = { provenance, trigger, smartMoney: sm, supporting: sig.supporting, conflicting: sig.conflicting, keyRisks: sig.keyRisks, provider: sig.provider, historyMultiplier: mult, patternStats: stats };
  const base = { direction: sig.direction, confidence: sig.confidence, confluence: conf, evidence };

  cs.signal = { direction: sig.direction, confidence: sig.confidence, at: Date.now(), status: 'evaluated' };
  if (sig.direction !== 'bullish') { await recordSkipped(cs, `Research bias is ${sig.direction} (long-only v1)`, base); cs.signal.status = 'skipped'; return; }
  if (gates.fails.length) { await recordSkipped(cs, `requirements not met: ${gates.fails.join('; ')}`, base); cs.signal.status = 'skipped'; return; }
  if (conf.total < R.minConfluence) { await recordSkipped(cs, `confluence ${conf.total} < ${R.minConfluence}`, base); cs.signal.status = 'skipped'; return; }

  const row = await db.insertSignal({
    symbol: cs.symbol, source_timestamp: new Date().toISOString(), direction: sig.direction, confidence: sig.confidence,
    reference_price: fp.price, target_price: sig.target, stop_price: sig.stop, evidence_summary: sig.evidenceSummary,
    evidence, confluence: conf, confluence_score: conf.total, btc_regime: state.btc.regime,
    prediction: { expected_direction: 'up', confidence: sig.confidence, target: sig.target, stop: sig.stop, timeframe_hours: sig.timeframeHours, made_at: new Date().toISOString(), reference_price: fp.price, trigger },
    status: 'awaiting_confirmation',
  });
  const id = row?.id ?? `mem-${Date.now()}-${cs.symbol}`;
  state.pending.set(id, { id, symbol: cs.symbol, product, refPrice: fp.price, createdAt: Date.now(), sig, conf, evidence, trigger, seen: 0, ctx: { patterns: cs.patterns, sentiment: cs.sentiment } });
  cs.signal.status = 'awaiting_confirmation';
  logDecision('candidate', cs.symbol, `OWN IDEA${trigger.kind === 'mover' ? ` (${trigger.reasons.join(', ')})` : ''}: bullish candidate, confluence ${conf.total}, confidence ${sig.confidence.toFixed(0)}%: waiting for candle confirmation`);
  feed.backfill1m(product);
}

async function evaluateCandidates(ctxSources) {
  const gate = riskLib.tradingGate(state.portfolio);
  const open = state.positions.size + state.pending.size;
  for (const cs of state.coins.values()) { const p = partialScore(cs); cs.partialDelta = p && cs.partialScore ? p.total - cs.partialScore.total : 0; cs.partialScore = p; if (!cs.signalFresh) cs.score = p ? p.total : null; }

  if (!state.btc.bullish) {
    logDecision('skipped', 'BTC', `BTC 1h regime is ${state.btc.regime}: all long entries suspended this scan`);
    return;
  }
  if (!gate.allowed) { logDecision('skipped', '*', `trading blocked: ${gate.reason}`); return; }
  if (open >= R.maxOpenPositions) { logDecision('skipped', '*', `${open} positions/pending signals already (max ${R.maxOpenPositions})`); return; }
  if (!llmAvailable()) { logDecision('info', '*', 'No LLM key configured (GEMINI_API_KEY / OPENROUTER_API_KEY): Research Brain offline, staying in cash'); return; }

  const now = Date.now();
  // Stage 2 of the funnel. The whole universe has been scanned cheaply; only coins that pass the screens AND still could reach 80/100 are candidates,
  // and only the strongest researchMax by priority get the expensive work. A coin needs no trending flag and no top-100 rank to qualify.
  const rejected = {};
  const candidates = [...state.coins.values()]
    .filter((cs) => cs.coin?.tradable && cs.health.ok && cs.partialScore && cs.partialScore.total >= 30)
    .filter((cs) => !(cs.coin.cooldownUntil && cs.coin.cooldownUntil > now))
    .filter((cs) => now - (cs.lastLlmAt ?? 0) > 20 * 60_000)
    .filter((cs) => ![...state.positions.values()].some((p) => p.symbol === cs.symbol) && ![...state.pending.values()].some((p) => p.symbol === cs.symbol))
    .filter((cs) => { const r = rejectFor(cs); if (r) rejected[r.code] = (rejected[r.code] ?? 0) + 1; return !r; });
  state.rejected = rejected;
  const hotAll = [...state.coins.values()].filter((cs) => cs.coin?.tradable && cs.health.ok && activity(cs).hot);
  const ranked = candidates.map((cs) => ({ cs, a: activity(cs), p: priorityOf(cs) })).sort((x, y) => y.p.score - x.p.score);
  const lineup = ranked.slice(0, Z.researchMax).map(({ cs, a, p }) => ({
    cs, trigger: { kind: a.hot && !a.dump ? 'mover' : 'scan', reasons: p.reasons.length ? p.reasons : [`technical + volume ${cs.partialScore.total.toFixed(0)}/50`], priority: +p.score.toFixed(0), h1: a.h1, h24: a.h24, rvol: cs.rvol },
  }));
  state.researchQueue = lineup.map(({ cs, trigger }) => ({ symbol: cs.symbol, priority: trigger.priority, reasons: trigger.reasons }));
  const rejSummary = Object.entries(rejected).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
  logDecision('info', '*', `radar: ${radarState.rows.size} coins monitored, ${state.coins.size} tradable, shortlist ${state.shortlist.size}; ${candidates.length} candidate(s) passed the screens${rejSummary ? ` (rejected: ${rejSummary})` : ''}; ${hotAll.length} trending/unusually active; deep-researching ${lineup.length}: ${lineup.slice(0, 6).map((x) => x.cs.symbol).join(', ') || 'none'}`);

  const lessons = state.reflections.slice(0, 5);
  const stats = patternStats();
  const aiFailed = [];
  for (const { cs, trigger } of lineup) {
    if (state.positions.size + state.pending.size >= R.maxOpenPositions) break;
    if (await evaluateCoin(cs, trigger, ctxSources, lessons, stats) === 'ai_failed') aiFailed.push({ cs, trigger });
  }
  // An AI outage or formatting failure must not reject an otherwise valid setup: give those coins one more try after the models have had time to recover.
  if (aiFailed.length) {
    logDecision('info', '*', `${aiFailed.length} setup(s) could not be judged because the AI failed (${aiFailed.map((x) => x.cs.symbol).join(', ')}): retrying`);
    await sleep(15_000);
    for (const { cs, trigger } of aiFailed) {
      if (state.positions.size + state.pending.size >= R.maxOpenPositions) break;
      await evaluateCoin(cs, trigger, ctxSources, lessons, stats);
    }
  }
}

/** Between full scans: if something is suddenly ripping (e.g. +8% in an hour), analyse it now instead of waiting up to 5 minutes. */
async function moverWatch() {
  if (state.scan.running || !state.ctx || !state.btc.bullish || !llmAvailable()) return;
  if (!riskLib.tradingGate(state.portfolio).allowed) return;
  if (state.positions.size + state.pending.size >= R.maxOpenPositions) return;
  const now = Date.now();
  const hit = [...state.coins.values()]
    .filter((cs) => cs.coin?.tradable && cs.health?.ok && !cs.evaluating && !rejectFor(cs) && !(cs.coin.cooldownUntil && cs.coin.cooldownUntil > now))
    .filter((cs) => now - (cs.lastFast ?? 0) > MOVER.fastCooldownMs && now - (cs.lastLlmAt ?? 0) > MOVER.fastCooldownMs)
    .filter((cs) => ![...state.positions.values()].some((p) => p.symbol === cs.symbol) && ![...state.pending.values()].some((p) => p.symbol === cs.symbol))
    .map((cs) => ({ cs, a: activity(cs) }))
    .filter((x) => x.a.h1 >= MOVER.fastTrigger1h)
    .sort((a, b) => b.a.h1 - a.a.h1)[0];
  if (!hit) return;
  const { cs } = hit;
  cs.lastFast = now;
  logDecision('info', cs.symbol, `FAST SCAN: up ${pct(hit.a.h1)} in the last hour. Re-analysing now instead of waiting for the next scan`);
  await analyzeCoin(cs.coin);
  if (!cs.health.ok) return;
  cs.partialScore = partialScore(cs);
  const a = activity(cs);
  await evaluateCoin(cs, { kind: 'mover', fast: true, reasons: a.reasons.length ? a.reasons : [`1h ${pct(hit.a.h1)}`], h1: a.h1, h24: a.h24, rvol: cs.rvol }, state.ctx, state.reflections.slice(0, 5), patternStats());
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
    const bullish = candle.c > candle.o, aboveRef = candle.c > p.refPrice * 1.0005, volOk = avgVol === 0 || candle.v >= avgVol * 0.8;
    const confirmation = { candle_time: new Date(candle.t * 1000).toISOString(), o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v, bullish, above_reference: aboveRef, volume_ok: volOk, candles_seen: p.seen };
    if (bullish && aboveRef && volOk) {
      confirmation.passed = true;
      state.pending.delete(p.id);
      db.updateSignal(p.id, { status: 'confirmed', confirmed_at: new Date().toISOString(), confirmation });
      logDecision('confirmed', p.symbol, `candle confirmation passed (close ${candle.c} > ref ${p.refPrice}): running risk filters`);
      tryEnter(p, confirmation);
    } else if (p.seen >= 3) {
      confirmation.passed = false;
      failSignal(p, 'confirmation_failed', `candle confirmation failed after ${p.seen} candles (last: ${bullish ? 'green' : 'red'}, ${aboveRef ? 'above' : 'not above'} reference, ${volOk ? 'volume ok' : 'volume weak'})`, confirmation);
    }
  }
}

async function tryEnter(p, confirmation) {
  const cs = state.coins.get(p.symbol);
  try {
    const fp = await feed.freshPrice(p.product, R.staleMs);
    // Re-verify the BTC regime with fresh candles right before entering.
    let btc = state.btc;
    try { btc = riskLib.btcRegime(snapshot(await fetchCandles('BTC-USD', 3600))); state.btc = { ...btc, at: Date.now() }; } catch { /* keep scan regime */ }
    const live = fp.price ?? p.refPrice;
    // Execution-price validation: a price that is stale (>10s) or has moved materially since the setup was confirmed is never traded.
    const execReasons = [];
    if (fp.price == null) execReasons.push(`execution price stale (last trade ${Number.isFinite(fp.ageMs) ? Math.round(fp.ageMs / 1000) + 's' : 'unknown'} ago, max ${R.staleMs / 1000}s)`);
    else if (confirmation?.c > 0 && Math.abs(fp.price / confirmation.c - 1) > R.maxEntryDriftPct) execReasons.push(`execution price ${fp.price} is ${(Math.abs(fp.price / confirmation.c - 1) * 100).toFixed(2)}% away from the confirmed price ${confirmation.c} (max ${R.maxEntryDriftPct * 100}%)`);
    const shaped = riskLib.shapeTrade(live, p.sig.stop, p.sig.target, { symbol: p.symbol, rank: cs?.coin?.rank ?? 100 });
    const reasons = riskLib.entryFilters({
      signal: p.sig, entry: live, shaped, score: p.conf.total, btc, portfolio: state.portfolio,
      openCount: state.positions.size, cooldownUntil: cs?.coin?.cooldownUntil, dataFresh: fp.price != null,
    });
    if (live <= shaped.stop) reasons.push('price already at/below the stop level');
    const rj = rejectFor(cs); if (rj) reasons.push(rj.text);
    reasons.push(...execReasons);
    if (reasons.length) {
      await db.updateSignal(p.id, { status: 'skipped', skip_reason: reasons.join(' | '), rr: shaped.rr });
      if (cs?.signal) cs.signal.status = 'skipped';
      logDecision('skipped', p.symbol, `blocked after confirmation: ${reasons.join(' | ')}`);
      return;
    }
    const equity = markEquity();
    const entryPx = riskLib.entryFill(live);
    // Size comes from the stop distance, not from conviction: (equity x 1%) / (stop% + fees/slippage%), capped by the global position cap.
    const fin = guard.finalizeEntry({ side: 'long', equity, cash: state.portfolio.cash, entry: entryPx, stop: shaped.stop });
    if (!fin.ok || fin.notional < 10) {
      const why = !fin.ok ? fin.reasons.join('; ') : `risk-based size $${fin.notional.toFixed(2)} is below the $10 minimum order (or insufficient cash)`;
      logDecision('skipped', p.symbol, why); await db.updateSignal(p.id, { status: 'skipped', skip_reason: why }); return;
    }
    const sizePct = fin.notional / equity, stopPx = fin.stop;
    const qty = fin.notional / entryPx, notional = qty * entryPx, fee = riskLib.feeOn(notional);
    const why = `OWN IDEA${p.trigger?.kind === 'mover' ? ` (trending/unusual: ${p.trigger.reasons.join(', ')})` : ' (regular scan)'}. Confluence ${p.conf.total}/100 (tech ${p.conf.technical}, RVOL ${p.conf.rvol}, research ${p.conf.research}, derivatives ${p.conf.derivatives}); BTC 1h ${btc.regime}; net R:R ${shaped.rr.toFixed(2)}; candle confirmed. ${p.sig.evidenceSummary}`;
    const row = await db.insertTrade({
      symbol: p.symbol, signal_id: p.id.startsWith('mem-') ? null : p.id, status: 'open', entry_price: entryPx, qty, notional,
      target_price: shaped.target, stop_price: stopPx, high_water: entryPx, rr: shaped.rr, confluence_score: p.conf.total, rationale: why,
      fee_entry: fee, entry_trigger: p.trigger?.kind ?? 'scan', prediction: { expected_direction: 'up', target: p.sig.target, stop: p.sig.stop, timeframe_hours: p.sig.timeframeHours ?? null, confirmation, trigger: p.trigger ?? null }, evidence_used: `${p.sig.evidenceSummary} | notes: ${JSON.stringify(p.conf.notes)}`,
      expected_direction: 'up', confidence: p.sig.confidence, candle_pattern: `5m: ${p.ctx.patterns?.['5m']}; 1h: ${p.ctx.patterns?.['1h']}; 1m confirm close ${confirmation.c}`, market_regime: `BTC 1h ${btc.regime}`,
    });
    const id = row?.id ?? `mem-trade-${Date.now()}`;
    state.portfolio.cash -= notional + fee;
    state.positions.set(id, {
      id, symbol: p.symbol, product: p.product, signalId: p.id, qty, entry: entryPx, notional, fee, stop: stopPx, stopPct: fin.stopPct, riskUsd: fin.riskUsd, target: shaped.target, band: shaped.band, partialTaken: false, horizonHours: clampN(p.sig.timeframeHours ?? 24, 1, 72),
      trailing: null, highWater: entryPx, openedAt: Date.now(), rationale: why, lastPrice: live, sizePct, trigger: p.trigger ?? { kind: 'scan', reasons: [] },
      ctx: { conf: p.conf, sig: p.sig, patterns: p.ctx.patterns, sentiment: p.ctx.sentiment, btc: btc.regime, confirmation },
    });
    await db.updateSignal(p.id, { status: 'entered', trade_id: row?.id ?? null, rr: shaped.rr });
    if (cs?.signal) cs.signal.status = 'entered';
    persistPortfolio(true);
    feed.backfill1m(p.product);
    logDecision('entered', p.symbol, `PAPER LONG ${qty.toPrecision(5)} @ ${entryPx.toPrecision(6)} ($${notional.toFixed(0)}, ${pct(sizePct)} of equity) stop ${stopPx.toPrecision(6)} (${pct(fin.stopPct)}) risk $${fin.riskUsd.toFixed(2)} (${pct(fin.riskUsd / equity)} of equity) target ${shaped.target.toPrecision(6)}`);
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
    origin: String(t.source ?? '').startsWith('copy_') ? 'mimic' : 'own', trigger: t.entry_trigger ?? null, triggerReasons: t.prediction?.trigger?.reasons ?? [],
  };
}

function recordHistory(pos, trade, notional) {
  state.recentClosed.unshift({
    id: pos.id, symbol: pos.symbol, side: pos.side ?? 'long', source: sourceOf(pos), trader: pos.copy?.trader ?? null,
    entry: pos.entry, exit: trade.exit_price, notional, pnl: trade.final_pnl, pnlPct: trade.final_pnl_pct, reason: trade.exit_reason,
    openedAt: pos.openedAt, closedAt: Date.now(),
    origin: pos.copy ? 'mimic' : 'own', trigger: pos.trigger?.kind ?? null, triggerReasons: pos.trigger?.reasons ?? [],
  });
  if (state.recentClosed.length > 200) state.recentClosed.length = 200;
}

function historySummary() {
  const all = state.recentClosed;
  const wins = all.filter((t) => t.pnl > 0), losses = all.filter((t) => t.pnl <= 0);
  const sum = (a) => a.reduce((x, t) => x + t.pnl, 0);
  const group = (o) => { const g = all.filter((t) => t.origin === o); return { count: g.length, wins: g.filter((t) => t.pnl > 0).length, losses: g.filter((t) => t.pnl <= 0).length, net: sum(g) }; };
  return {
    byOrigin: { own: group('own'), mimic: group('mimic') },
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
  if (reason === 'stop_loss') {
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

async function reflect(pos, trade, actual) {
  const win = trade.final_pnl > 0;
  const lessons = state.reflections.slice(0, 5).map((l) => ({ outcome: l.outcome, symbol: l.symbol, lesson: l.lesson }));
  const ctx = { copiedTrader: pos.copy ?? null, side: pos.side ?? 'long', confluence: pos.ctx.conf, researchSummary: pos.ctx.sig.evidenceSummary, supporting: pos.ctx.sig.supporting, conflicting: pos.ctx.sig.conflicting, patterns: pos.ctx.patterns, sentiment: pos.ctx.sentiment, btcRegime: pos.ctx.btc, entryRationale: pos.rationale };
  let r = null;
  if (llmAvailable()) r = await reflectOnTrade({ ...trade, holdMinutes: +((Date.now() - pos.openedAt) / 60000).toFixed(1) }, ctx, lessons);
  if (!r && pos.copy) {
    r = {
      actual_result: actual, indicators_correct: win ? [`trader's ${pos.side} call on ${pos.symbol} worked`] : [], indicators_wrong: win ? [] : [`trader's ${pos.side} call on ${pos.symbol} did not work out (exit: ${trade.exit_reason})`],
      news_impact: { mattered: [], irrelevant: [] },
      lesson: `Copied ${pos.copy.trader.slice(0, 8)} (${(pos.copy.winRate * 100).toFixed(0)}% win rate) ${pos.side} ${pos.symbol}: ${win ? 'won' : 'lost'} via ${trade.exit_reason}; entry was ${((pos.entry / pos.copy.leaderPx - 1) * 100).toFixed(2)}% vs the leader after ${(pos.copy.latencyMs / 1000).toFixed(1)}s. (Auto-generated: LLM reflection unavailable.)`,
      patterns: [`copy:${trade.exit_reason}`, win ? 'copy win' : 'copy loss'],
    };
  }
  if (!r) {
    // Deterministic fallback so every trade still gets a post-mortem.
    const c = pos.ctx.conf, strong = [], weak = [];
    for (const k of ['technical', 'rvol', 'research', 'derivatives']) (c[k] >= 17.5 ? strong : weak).push(`${k} component (${c[k]}/25): ${c.notes[k]}`);
    r = {
      actual_result: actual,
      indicators_correct: win ? strong : weak.length ? [] : strong,
      indicators_wrong: win ? [] : strong.length ? strong.map((s) => `${s} (scored high but the trade did not work)`) : weak,
      news_impact: { mattered: [], irrelevant: pos.ctx.sentiment?.headlines ?? [] },
      lesson: `${win ? 'Winning' : 'Losing'} trade on ${pos.symbol} exited via ${trade.exit_reason}; the available evidence suggests ${win ? 'momentum and volume persisted long enough for the trail to lock in gains' : 'the setup lost follow-through soon after entry'}. (Auto-generated: LLM reflection unavailable.)`,
      patterns: [`${trade.exit_reason}`, win ? 'confirmed-breakout win' : 'confirmed-breakout loss'],
    };
  }
  const row = {
    trade_id: pos.id.startsWith('mem-') ? null : pos.id, symbol: pos.symbol, outcome: win ? 'win' : 'loss',
    prediction: pos.copy ? `Mirror ${pos.copy.trader.slice(0, 10)}'s ${pos.side} on ${pos.symbol} (their win rate ${(pos.copy.winRate * 100).toFixed(0)}%), hard stop ${pos.stop.toPrecision(6)}` : `Expected up toward ${pos.target.toPrecision(6)} with stop ${pos.stop.toPrecision(6)} (confidence ${pos.ctx.sig.confidence.toFixed(0)}%)`,
    evidence_used: pos.ctx.sig.evidenceSummary, expected_direction: pos.side === 'short' ? 'down' : 'up', confidence: pos.ctx.sig.confidence,
    actual_result: r.actual_result || actual, indicators_correct: r.indicators_correct, indicators_wrong: r.indicators_wrong, news_impact: r.news_impact,
    candle_pattern: pos.copy ? `copy of ${pos.copy.trader.slice(0, 8)}` : `5m: ${pos.ctx.patterns?.['5m']}`, market_regime: `BTC 1h ${pos.ctx.btc}`, final_pnl: trade.final_pnl, lesson: r.lesson, patterns: r.patterns,
  };
  const saved = row.trade_id ? await db.insertReflection(row) : null;
  state.reflections.unshift({ ...(saved ?? row), created_at: saved?.created_at ?? new Date().toISOString() });
  if (state.reflections.length > 100) state.reflections.length = 100;
  logDecision('reflection', pos.symbol, `post-mortem recorded (${row.outcome}): ${r.lesson}`);
}

/* ------------------------------------------------------------- housekeeping */

async function housekeeping() {
  const now = Date.now();
  for (const p of [...state.pending.values()]) {
    if (now - p.createdAt > config.confirmWindowMs) failSignal(p, 'confirmation_failed', `no candle confirmation within ${config.confirmWindowMs / 60000} minutes`);
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
        : { product: `${t.symbol}-USD`, horizonHours: clampN(Number(t.prediction?.timeframe_hours) || 24, 1, 72), trigger: { kind: t.entry_trigger ?? 'scan', reasons: t.prediction?.trigger?.reasons ?? [] } }),
      ctx: { conf: { notes: {}, technical: 0, rvol: 0, research: 0, derivatives: 0, total: Number(t.confluence_score ?? 0) }, sig: { evidenceSummary: t.evidence_used ?? '', supporting: [], conflicting: [], confidence: Number(t.confidence ?? 0) }, patterns: {}, btc: t.market_regime },
    });
  }
  if (state.positions.size) log(`Resumed ${state.positions.size} open paper position(s) from Supabase`);

  feed.on('tick', onTick);
  feed.on('candle', (product, candle) => { onCandleClosed(product, candle); onMomentumCheck(product); });
  feed.setProducts([...state.positions.values()].map((p) => p.product).filter(Boolean));
  feed.start();
  setInterval(() => housekeeping().catch((e) => warn('housekeeping', e.message)), 1000);
  setInterval(() => moverWatch().catch((e) => warn('mover watch', e.message)), config.movers.fastCheckMs);
  setInterval(() => persistPortfolio(), 15_000);

  (async () => {
    for (;;) {
      await runScan();
      await sleep(config.scanIntervalMs);
    }
  })();
}

/* ----------------------------------------------------------------- snapshot */

export const isReady = () => !!state.portfolio;

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
    else if (cs?.signal && now - cs.signal.at < 2 * 3600_000) signal = `${cs.signal.direction} (${cs.signal.confidence.toFixed(0)}%) · ${cs.signal.status}`;
    return {
      rank: coin.rank, cgRank: coin.cgRank, cmcRank: coin.cmcRank, volume24h: coin.volume24h ?? 0, thin: (coin.volume24h ?? 0) < U.minVolume24hUsd, discrepancy: coin.discrepancyNote, symbol: coin.symbol, name: coin.name, product: coin.product,
      price: (coin.product && feed.price(coin.product)) || coin.price, candle: f ? { o: f.o, h: f.h, l: f.l, c: f.c } : null,
      signal, score: cs?.score ?? null, rvol: cs?.rvol ?? null,
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
      id: x.id, symbol: x.symbol, side: x.side ?? 'long', source: x.copy ? 'copy' : 'strategy', origin: x.copy ? 'mimic' : 'own', trigger: x.trigger ?? null, venue: x.venue ?? 'coinbase', trader: x.copy?.trader ?? null, traderWinRate: x.copy?.winRate ?? null,
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
      shortlistSize: state.shortlist.size, shortlistTarget: Z.shortlistSize, researchMax: Z.researchMax,
      shortlist: state.shortlist.top, researchQueue: state.researchQueue, rejected: state.rejected, watchMovers: watchOnlyMovers(10),
    },
    newsFeed: state.newsFeed,
    decisions: state.decisions.slice(0, 100), reflections: state.reflections.slice(0, 40),
    pending: [...state.pending.values()].map((x) => ({ symbol: x.symbol, refPrice: x.refPrice, createdAt: x.createdAt, score: x.conf.total })),
    limits: { minConfluence: R.minConfluence, minRR: R.minRR, maxPositions: R.maxOpenPositions },
  };
}
export const __test = { chandelierStop, onTick, onMomentumCheck };
