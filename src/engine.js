// Scan -> validate -> analyze -> candidate -> candle confirm -> risk filter -> enter -> monitor -> trail -> exit -> P&L -> post-mortem -> lessons -> resume.
// PAPER ONLY: this module never talks to any order endpoint. Positions are simulated in memory + Supabase.
import { config, log, warn } from './config.js';
import { db } from './db.js';
import { feed, fetchCandles, loadProducts } from './exchange.js';
import { hl } from './hyperliquid.js';
import { onchainPx } from './onchainprices.js';
import { refreshUniverse, restoreCooldowns, universe } from './universe.js';
import { snapshot, aggregate, rvol as calcRvol, atr, ema, rsi, candlePattern } from './indicators.js';
import * as src from './sources.js';
import { generateSignal, reflectOnTrade, llmAvailable } from './research.js';
import * as riskLib from './risk.js';

const R = config.risk;
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
  newsFeed: { at: null, feeds: [], items: [] },   // everything the app read this scan (News & Politics panel)
  copyCooldown: new Map(),     // coin -> until (2h lockout after a copied position hits its stop)
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
    else if (priceDiff > 0.05) cs.health = { ok: false, reason: `contradictory price: exchange ${last5.c} vs CoinGecko ${coin.price}` };
    else cs.health = { ok: true, reason: null, checkedAt: Date.now() };
    cs.snaps = { '1d': snapshot(d1), '4h': snapshot(aggregate(h1, 4 * 3600)), '1h': snapshot(h1), '15m': snapshot(m15), '5m': snapshot(m5) };
    cs.rvol = calcRvol(m15);
    cs.atr15 = atr(m15);
    cs.patterns = { '5m': candlePattern(m5), '1h': candlePattern(h1) };
    cs.priceUp = m15.length > 2 && m15[m15.length - 1].c > m15[m15.length - 3].c;
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
      for (const id of changes.added) { const c = universe.coins.get(id); logDecision('info', c.symbol, `entered the tradable Top 100 (market-cap rank #${c.cgRank})`); }
      for (const id of changes.removed) logDecision('info', id, 'dropped out of the tradable Top 100');
    }
    if (!universe.coins.size) throw new Error(`no universe available (${universe.lastError ?? 'unknown'})`);
    await restoreCooldowns();

    const tradable = [...universe.coins.values()].filter((c) => c.tradable);
    const products = new Set(tradable.map((c) => c.product));
    for (const pos of state.positions.values()) if (pos.product) products.add(pos.product);
    feed.setProducts([...products]);

    // BTC first so the regime gate is current before anything else is evaluated.
    tradable.sort((a, b) => (a.symbol === 'BTC' ? -1 : b.symbol === 'BTC' ? 1 : a.cgRank - b.cgRank));
    let i = 0;
    for (const coin of tradable) {
      s.progress = `fetching candles ${++i}/${tradable.length} (${coin.symbol})`;
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

async function evaluateCandidates(ctxSources) {
  const gate = riskLib.tradingGate(state.portfolio);
  const open = state.positions.size + state.pending.size;
  for (const cs of state.coins.values()) { const p = partialScore(cs); cs.partialScore = p; if (!cs.signalFresh) cs.score = p ? p.total : null; }

  if (!state.btc.bullish) {
    logDecision('skipped', 'BTC', `BTC 1h regime is ${state.btc.regime}: all long entries suspended this scan`);
    return;
  }
  if (!gate.allowed) { logDecision('skipped', '*', `trading blocked: ${gate.reason}`); return; }
  if (open >= R.maxOpenPositions) { logDecision('skipped', '*', `${open} positions/pending signals already (max ${R.maxOpenPositions})`); return; }
  if (!llmAvailable()) { logDecision('info', '*', 'No LLM key configured (GEMINI_API_KEY / OPENROUTER_API_KEY): Research Brain offline, staying in cash'); return; }

  // Mathematical feasibility: technical+RVOL max 50, derivatives max 25, research max 25. Need >= 80 overall.
  const derivAvailable = true; // Coinglass, or the OKX public fallback; per-coin availability is checked below
  const needPartial = R.minConfluence - 25 - (derivAvailable ? 25 : 0);
  if (!derivAvailable) {
    logDecision('skipped', '*', `Derivatives data unavailable (COINGLASS_API_KEY not set): confluence is capped at 75 < ${R.minConfluence}, so no entries are possible`);
    return;
  }
  const now = Date.now();
  const shortlist = [...state.coins.values()]
    .filter((cs) => cs.coin?.tradable && cs.health.ok && cs.partialScore && cs.partialScore.total >= Math.max(needPartial, 30))
    .filter((cs) => !(cs.coin.cooldownUntil && cs.coin.cooldownUntil > now))
    .filter((cs) => ![...state.positions.values()].some((p) => p.symbol === cs.symbol) && ![...state.pending.values()].some((p) => p.symbol === cs.symbol))
    .sort((a, b) => b.partialScore.total - a.partialScore.total)
    .slice(0, config.maxResearchPerScan);

  const lessons = state.reflections.slice(0, 5);
  const stats = patternStats();
  for (const cs of shortlist) {
    if (state.positions.size + state.pending.size >= R.maxOpenPositions) break;
    const product = cs.coin.product;
    const fp = await feed.freshPrice(product, R.staleMs);
    if (fp.price == null) { await recordSkipped(cs, `price stream not verified fresh (age ${Math.round(fp.ageMs / 1000)}s): data unreliable`); continue; }

    const deriv = await src.derivatives(cs.symbol); noteSource(deriv); cs.deriv = deriv;
    const d = riskLib.derivativesScore(deriv, cs.priceUp);
    if (!d.available || cs.partialScore.total + d.score + 25 < R.minConfluence) {
      await recordSkipped(cs, `confluence cannot reach ${R.minConfluence}: technical+RVOL ${cs.partialScore.total.toFixed(1)} + derivatives ${d.score.toFixed(1)} + max research 25 (${d.note})`);
      continue;
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
    const sig = await generateSignal({
      symbol: cs.symbol, name: cs.coin.name, price: fp.price, btcRegime: state.btc.regime, timeframes: tfSummary, rvol: cs.rvol,
      derivatives: deriv.data, macro: ctxSources.macro.data, legislation: ctxSources.bills.data, onchain: ctxSources.onchain.data, politics: compactPolitics(ctxSources.politics),
      news: cs.sentiment ? { coin: cs.sentiment, market: (ctxSources.news.data || []).slice(0, 8) } : { market: (ctxSources.news.data || []).slice(0, 8) },
      provenance,
    }, lessons.map((l) => ({ outcome: l.outcome, symbol: l.symbol, lesson: l.lesson })));
    if (!sig) { await recordSkipped(cs, 'Research Brain returned no valid signal', {}); continue; }

    const mult = historyMultiplier(cs.symbol);
    sig.confidence = Math.min(100, sig.confidence * mult);
    const conf = riskLib.confluence({ snaps: cs.snaps, rvol: cs.rvol, signal: sig, derivatives: deriv, priceUp: cs.priceUp });
    cs.score = conf.total; cs.signalFresh = Date.now();
    const evidence = { provenance, supporting: sig.supporting, conflicting: sig.conflicting, keyRisks: sig.keyRisks, provider: sig.provider, historyMultiplier: mult, patternStats: stats };
    const base = { direction: sig.direction, confidence: sig.confidence, confluence: conf, evidence };

    cs.signal = { direction: sig.direction, confidence: sig.confidence, at: Date.now(), status: 'evaluated' };
    if (sig.direction !== 'bullish') { await recordSkipped(cs, `Research bias is ${sig.direction} (long-only v1)`, base); cs.signal.status = 'skipped'; continue; }
    if (conf.total < R.minConfluence) { await recordSkipped(cs, `confluence ${conf.total} < ${R.minConfluence}`, base); cs.signal.status = 'skipped'; continue; }

    const row = await db.insertSignal({
      symbol: cs.symbol, source_timestamp: new Date().toISOString(), direction: sig.direction, confidence: sig.confidence,
      reference_price: fp.price, target_price: sig.target, stop_price: sig.stop, evidence_summary: sig.evidenceSummary,
      evidence, confluence: conf, confluence_score: conf.total, btc_regime: state.btc.regime,
      prediction: { expected_direction: 'up', confidence: sig.confidence, target: sig.target, stop: sig.stop, timeframe_hours: sig.timeframeHours, made_at: new Date().toISOString(), reference_price: fp.price },
      status: 'awaiting_confirmation',
    });
    const id = row?.id ?? `mem-${Date.now()}-${cs.symbol}`;
    state.pending.set(id, { id, symbol: cs.symbol, product, refPrice: fp.price, createdAt: Date.now(), sig, conf, evidence, seen: 0, ctx: { patterns: cs.patterns, sentiment: cs.sentiment } });
    cs.signal.status = 'awaiting_confirmation';
    logDecision('candidate', cs.symbol, `bullish candidate (confluence ${conf.total}, confidence ${sig.confidence.toFixed(0)}%): waiting for candle confirmation`);
    feed.backfill1m(product);
  }
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
    const shaped = riskLib.shapeTrade(live, p.sig.stop, p.sig.target);
    const reasons = riskLib.entryFilters({
      signal: p.sig, entry: live, shaped, score: p.conf.total, btc, portfolio: state.portfolio,
      openCount: state.positions.size, cooldownUntil: cs?.coin?.cooldownUntil, dataFresh: fp.price != null,
    });
    if (live <= shaped.stop) reasons.push('price already at/below the stop level');
    if (reasons.length) {
      await db.updateSignal(p.id, { status: 'skipped', skip_reason: reasons.join(' | '), rr: shaped.rr });
      if (cs?.signal) cs.signal.status = 'skipped';
      logDecision('skipped', p.symbol, `blocked after confirmation: ${reasons.join(' | ')}`);
      return;
    }
    const equity = markEquity();
    const { pct: sizePct, notional: wanted } = riskLib.positionSize({ equity, cash: state.portfolio.cash, score: p.conf.total });
    if (wanted < 10) { logDecision('skipped', p.symbol, 'insufficient cash'); await db.updateSignal(p.id, { status: 'skipped', skip_reason: 'insufficient cash' }); return; }
    const entryPx = riskLib.entryFill(live);
    const qty = wanted / entryPx, notional = qty * entryPx, fee = riskLib.feeOn(notional);
    const why = `Confluence ${p.conf.total}/100 (tech ${p.conf.technical}, RVOL ${p.conf.rvol}, research ${p.conf.research}, derivatives ${p.conf.derivatives}); BTC 1h ${btc.regime}; net R:R ${shaped.rr.toFixed(2)}; candle confirmed. ${p.sig.evidenceSummary}`;
    const row = await db.insertTrade({
      symbol: p.symbol, signal_id: p.id.startsWith('mem-') ? null : p.id, status: 'open', entry_price: entryPx, qty, notional,
      target_price: shaped.target, stop_price: shaped.stop, high_water: entryPx, rr: shaped.rr, confluence_score: p.conf.total, rationale: why,
      fee_entry: fee, prediction: { expected_direction: 'up', target: p.sig.target, stop: p.sig.stop, confirmation }, evidence_used: `${p.sig.evidenceSummary} | notes: ${JSON.stringify(p.conf.notes)}`,
      expected_direction: 'up', confidence: p.sig.confidence, candle_pattern: `5m: ${p.ctx.patterns?.['5m']}; 1h: ${p.ctx.patterns?.['1h']}; 1m confirm close ${confirmation.c}`, market_regime: `BTC 1h ${btc.regime}`,
    });
    const id = row?.id ?? `mem-trade-${Date.now()}`;
    state.portfolio.cash -= notional + fee;
    state.positions.set(id, {
      id, symbol: p.symbol, product: p.product, signalId: p.id, qty, entry: entryPx, notional, fee, stop: shaped.stop, target: shaped.target,
      trailing: null, highWater: entryPx, openedAt: Date.now(), rationale: why, lastPrice: live, sizePct,
      ctx: { conf: p.conf, sig: p.sig, patterns: p.ctx.patterns, sentiment: p.ctx.sentiment, btc: btc.regime, confirmation },
    });
    await db.updateSignal(p.id, { status: 'entered', trade_id: row?.id ?? null, rr: shaped.rr });
    if (cs?.signal) cs.signal.status = 'entered';
    persistPortfolio(true);
    feed.backfill1m(p.product);
    logDecision('entered', p.symbol, `PAPER LONG ${qty.toPrecision(5)} @ ${entryPx.toPrecision(6)} ($${notional.toFixed(0)}, ${pct(sizePct)} of equity) stop ${shaped.stop.toPrecision(6)} target ${shaped.target.toPrecision(6)}`);
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
    if (price >= pos.entry * (1 + R.trailActivatePct)) {
      const cs = state.coins.get(pos.symbol);
      const base = clampN(cs?.atr15 ? (1.5 * cs.atr15) / price : 0.02, 0.01, 0.03);
      const trailPct = price >= pos.target ? Math.max(0.0075, base * 0.6) : base; // tighten once the target zone is reached, but never cap the upside
      const next = pos.highWater * (1 - trailPct);
      if (next > (pos.trailing ?? 0)) {
        pos.trailing = next;
        if (!pos.syncAt || Date.now() - pos.syncAt > 5000) { pos.syncAt = Date.now(); db.updateTrade(pos.id, { trailing_stop: next, high_water: pos.highWater }); }
      }
    }
    const level = Math.max(pos.stop, pos.trailing ?? 0);
    if (price <= level) closePosition(pos, price, pos.trailing && level === pos.trailing ? 'trailing_stop' : 'stop_loss');
  }
}
const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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
    if (price > pos.entry && last2Below && r < 45) closePosition(pos, price, 'momentum_reversal');
  }
}

/* ---------------------------------------------------------------- trade history */

const sourceOf = (pos) => (pos.copy ? (pos.venue === 'onchain' ? 'copy_zerion' : 'copy_hyperliquid') : 'strategy');

function historyFromDb(t) {
  return {
    id: t.id, symbol: t.symbol, side: t.side ?? 'long', source: t.source ?? 'strategy', trader: t.source_trader ?? null,
    entry: Number(t.entry_price), exit: Number(t.exit_price), notional: Number(t.final_pnl_pct) ? Math.abs(Number(t.final_pnl) / Number(t.final_pnl_pct)) : Number(t.notional), pnl: Number(t.final_pnl), pnlPct: Number(t.final_pnl_pct),
    reason: t.exit_reason, openedAt: new Date(t.entry_time).getTime(), closedAt: new Date(t.exit_time).getTime(),
  };
}

function recordHistory(pos, trade, notional) {
  state.recentClosed.unshift({
    id: pos.id, symbol: pos.symbol, side: pos.side ?? 'long', source: sourceOf(pos), trader: pos.copy?.trader ?? null,
    entry: pos.entry, exit: trade.exit_price, notional, pnl: trade.final_pnl, pnlPct: trade.final_pnl_pct, reason: trade.exit_reason,
    openedAt: pos.openedAt, closedAt: Date.now(),
  });
  if (state.recentClosed.length > 200) state.recentClosed.length = 200;
}

function historySummary() {
  const all = state.recentClosed;
  const wins = all.filter((t) => t.pnl > 0), losses = all.filter((t) => t.pnl <= 0);
  const sum = (a) => a.reduce((x, t) => x + t.pnl, 0);
  return {
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
  state.closedToday.push({ ...trade, exitAt: Date.now() });
  recordHistory(pos, trade, pos.initCost ?? (pos.notional + pos.fee));
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
  if (state.positions.size + state.pending.size >= R.maxOpenPositions) return { ok: false, reason: `already ${state.positions.size + state.pending.size} open positions/pending signals (max ${R.maxOpenPositions})` };
  if ([...state.positions.values()].some((x) => x.venue === (o.venue ?? 'hl') && x.coin === o.coin)) return { ok: false, reason: `already copying a ${o.coin} position` };
  const cd = state.copyCooldown.get(o.coin);
  if (cd && cd > now) return { ok: false, reason: `${o.coin} cooldown after stop-loss until ${new Date(cd).toISOString()}` };
  if ((o.venue ?? 'hl') === 'hl' ? hl.midAgeMs() > R.staleMs : !(o.priceAgeMs <= R.staleMs)) return { ok: false, reason: 'price not verified fresh (>10s)' };
  const equity = markEquity();
  let notional = Math.min(o.notional, R.maxPositionPct * equity);
  if (notional * (1 + R.feePct) > p.cash) notional = p.cash / (1 + R.feePct);
  if (notional < config.copy.minNotional) return { ok: false, reason: `position would be only $${notional.toFixed(2)} (below $${config.copy.minNotional} minimum / insufficient cash)` };
  const entryPx = entryFillFor(o.side, o.price);
  const qty = notional / entryPx, fee = riskLib.feeOn(notional);
  const stop = o.side === 'short' ? entryPx * (1 + config.copy.stopPct) : entryPx * (1 - config.copy.stopPct);
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
    stop, target: null, trailing: null, highWater: entryPx, openedAt: now, rationale: why, lastPrice: o.price, leaderSize: o.leaderSize,
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
  if (pos.venue === 'hl' ? hl.midAgeMs() > R.staleMs : !(priceAgeMs <= R.staleMs)) return { ok: false, reason: 'price not verified fresh (>10s)' };
  const equity = markEquity();
  let add = Math.min(addNotional, R.maxPositionPct * equity - pos.notional);
  if (add * (1 + R.feePct) > p.cash) add = p.cash / (1 + R.feePct);
  if (add < config.copy.minNotional) return { ok: false, reason: 'add would be below minimum size or exceed the 30% cap' };
  const px = entryFillFor(pos.side, price), q = add / px, fee = riskLib.feeOn(add);
  p.cash -= add + fee;
  pos.entry = (pos.qty * pos.entry + q * px) / (pos.qty + q);
  pos.qty += q; pos.notional += add; pos.fee += fee; pos.initCost += add + fee;
  pos.stop = pos.side === 'short' ? pos.entry * (1 + config.copy.stopPct) : pos.entry * (1 - config.copy.stopPct);
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
  const stops = state.closedToday.filter((t) => t.exit_reason === 'stop_loss').length;
  if (stops >= R.freezeStopLossesPerDay) freeze(`${stops} stop-loss hits today`);
  const last2 = state.closedToday.slice(-2);
  if (last2.length === 2 && last2.every((t) => t.final_pnl < 0) && last2[1].exitAt - last2[0].exitAt <= R.consecutiveLossWindowMin * 60_000) freeze('2 consecutive losses within 60 minutes');
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
  for (const s of (signals ?? []).slice().reverse()) {
    if (s.status === 'skipped' || s.status === 'confirmation_failed') state.decisions.unshift({ at: new Date(s.created_at).getTime(), type: 'skipped', symbol: s.symbol, message: s.skip_reason ?? s.status });
  }
  state.closedToday = (today ?? []).map((t) => ({ ...t, final_pnl: Number(t.final_pnl), exitAt: new Date(t.exit_time).getTime() }));

  for (const t of open ?? []) {
    const isCopy = String(t.source ?? '').startsWith('copy_');
    state.positions.set(t.id, {
      id: t.id, symbol: t.symbol, signalId: t.signal_id, side: t.side ?? 'long', qty: Number(t.qty), entry: Number(t.entry_price), notional: Number(t.notional),
      fee: Number(t.fee_entry), initCost: Number(t.notional) + Number(t.fee_entry), realized: Number(t.realized_partial ?? 0),
      stop: Number(t.stop_price), target: t.target_price ? Number(t.target_price) : null, trailing: t.trailing_stop ? Number(t.trailing_stop) : null,
      highWater: Number(t.high_water ?? t.entry_price), openedAt: new Date(t.entry_time).getTime(), rationale: t.rationale, lastPrice: null,
      ...(isCopy
        ? { venue: t.source === 'copy_zerion' ? 'onchain' : 'hl', extra: t.prediction ?? null, coin: t.source === 'copy_zerion' ? (t.prediction?.assetKey ?? t.symbol) : t.symbol, leaderSize: Number(t.leader_size ?? 0), copy: { trader: t.source_trader, winRate: Number(t.confidence ?? 0) / 100, tier: t.prediction?.tier ?? 'minimum', leaderPx: Number(t.leader_fill_price), leaderTime: new Date(t.leader_fill_time).getTime(), k: Number(t.prediction?.k ?? 0), latencyMs: 0 } }
        : { product: `${t.symbol}-USD` }),
      ctx: { conf: { notes: {}, technical: 0, rvol: 0, research: 0, derivatives: 0, total: Number(t.confluence_score ?? 0) }, sig: { evidenceSummary: t.evidence_used ?? '', supporting: [], conflicting: [], confidence: Number(t.confidence ?? 0) }, patterns: {}, btc: t.market_regime },
    });
  }
  if (state.positions.size) log(`Resumed ${state.positions.size} open paper position(s) from Supabase`);

  feed.on('tick', onTick);
  feed.on('candle', (product, candle) => { onCandleClosed(product, candle); onMomentumCheck(product); });
  feed.setProducts([...state.positions.values()].map((p) => p.product).filter(Boolean));
  feed.start();
  setInterval(() => housekeeping().catch((e) => warn('housekeeping', e.message)), 1000);
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
      rank: coin.rank, cgRank: coin.cgRank, cmcRank: coin.cmcRank, discrepancy: coin.discrepancyNote, symbol: coin.symbol, name: coin.name, product: coin.product,
      price: (coin.product && feed.price(coin.product)) || coin.price, candle: f ? { o: f.o, h: f.h, l: f.l, c: f.c } : null,
      signal, score: cs?.score ?? null, rvol: cs?.rvol ?? null,
      funding: cs?.deriv?.ok ? cs.deriv.data.fundingRatePct : null, sentiment: cs?.sentiment?.score ?? null, sentimentCount: cs?.sentiment?.count ?? 0,
      tradable: coin.tradable, excluded: coin.excludedReason, health: cs?.health?.ok ? 'ok' : cs?.health?.reason ?? 'pending',
      cooldownUntil: coin.cooldownUntil && coin.cooldownUntil > now ? coin.cooldownUntil : null,
      stale: coin.product ? feed.tickAgeMs(coin.product) > R.staleMs : null,
    };
  });
  const positions = [...state.positions.values()].map((x) => {
    const px = priceOf(x), ex = exitFillFor(x.side, px);
    const net = (x.realized ?? 0) + x.qty * (x.side === 'short' ? x.entry - ex : ex - x.entry) - riskLib.feeOn(x.qty * ex) - x.fee;
    return {
      id: x.id, symbol: x.symbol, side: x.side ?? 'long', source: x.copy ? 'copy' : 'strategy', venue: x.venue ?? 'coinbase', trader: x.copy?.trader ?? null, traderWinRate: x.copy?.winRate ?? null,
      leaderPx: x.copy?.leaderPx ?? null, entry: x.entry, price: px, target: x.target, stop: x.stop, trailing: x.trailing,
      rr: x.target ? (x.target - x.entry) / (x.entry - x.stop) : null, qty: x.qty, notional: x.notional, pnl: net, pnlPct: net / (x.initCost ?? (x.notional + x.fee)), openedAt: x.openedAt, why: x.rationale,
    };
  });
  return {
    now, paper: true,
    portfolio: { ...p, equity, dailyPnlPct: equity / p.daily_start_equity - 1, gate: riskLib.tradingGate(p) },
    btc: state.btc, scan: state.scan, health: dataHealth(), rows, positions,
    history: historySummary(),
    newsFeed: state.newsFeed,
    decisions: state.decisions.slice(0, 100), reflections: state.reflections.slice(0, 40),
    pending: [...state.pending.values()].map((x) => ({ symbol: x.symbol, refPrice: x.refPrice, createdAt: x.createdAt, score: x.conf.total })),
    limits: { minConfluence: R.minConfluence, minRR: R.minRR, maxPositions: R.maxOpenPositions },
  };
}
