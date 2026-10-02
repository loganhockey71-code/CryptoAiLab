// SELF-LEARNING from outcomes, not from stories. Every notable decision is journaled WITH the evidence that produced it; its outcome is measured later from real candles
// (max favourable / adverse excursion, target-or-stop-first, return) for traded AND not-traded calls (counterfactuals: what would the WATCH / vetoed setup have done?).
// General rules are learned per FEATURE BUCKET (setup type, regime, trend alignment, volume, extension...), never per trade or per coin, and a rule only becomes active when it
// passes walk-forward validation: it must show the same sign and a meaningful size on an EARLIER (train) and a LATER (test) slice of time, with enough samples in both.
// Learned rules move the score by at most +-config.brain.learnBound points. They can never touch risk limits, circuit breakers, stops, sizing or the vetoes themselves.
// It also answers: "a coin went up 10%: why didn't the AI detect it earlier?" (findMissed) and reports honestly when there is not yet enough data.
import fs from 'node:fs';
import path from 'node:path';
import { config, warn, log } from './config.js';

const B = config.brain;
const FILE = path.join(config.root, 'logs', 'brain-journal.json');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const COST = 2 * (config.risk.feePct + config.risk.slippagePct);

export const journal = { entries: [], ring: new Map(), missed: [], missedAt: 0, rules: [], rulesAt: 0, dirty: false, loaded: false };

/* ---------------------------------------------------------------- persistence */
export function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    journal.entries = j.entries ?? []; journal.missed = j.missed ?? [];
    for (const [s, a] of Object.entries(j.ring ?? {})) journal.ring.set(s, a);
    log(`Brain journal restored: ${journal.entries.length} decisions (${journal.entries.filter((e) => e.outcome).length} with measured outcomes)`);
  } catch { /* first run */ }
  journal.loaded = true;
}
export function save() {
  if (!journal.dirty) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ entries: journal.entries.slice(-3000), missed: journal.missed.slice(-60), ring: Object.fromEntries(journal.ring), savedAt: Date.now() }));
    journal.dirty = false;
  } catch (e) { warn('brain journal save failed:', e.message); }
}

/* -------------------------------------------------------------- feature buckets */
/** The general features a decision is described by. Buckets are coarse on purpose: a rule must apply to MANY situations to be learnable. */
export function featureKeys(d) {
  const ev = d.evidence ?? {}, tr = ev.trend ?? {}, up = (s) => s === 'up' || s === 'strong_up', keys = [];
  const sName = typeof d.setup === 'string' ? d.setup : d.setup?.name;               // decisions carry an object, journal entries just the name
  if (sName) keys.push([`setup:${sName}`, `${(typeof d.setup === 'object' && d.setup.label) || sName.replace(/_/g, ' ')} setups`]);
  if (ev.regime) keys.push([`regime:${ev.regime}`, `market regime "${String(ev.regime).replace(/_/g, ' ')}"`]);
  keys.push([`align:${up(tr['4h']) && up(tr['1h']) ? '4h+1h up' : up(tr['1h']) ? '1h up only' : tr['1h'] === 'range' ? '1h sideways' : '1h down'}`, `trend alignment (${up(tr['4h']) && up(tr['1h']) ? '4h and 1h up' : up(tr['1h']) ? '1h up only' : tr['1h'] === 'range' ? '1h sideways' : '1h down'})`]);
  const rv = Math.max(ev.volume?.rvol15 ?? 0, ev.volume?.rvol1h ?? 0);
  keys.push([`volume:${rv >= 1.5 ? 'high' : rv >= 0.8 ? 'normal' : 'low'}`, `${rv >= 1.5 ? 'high' : rv >= 0.8 ? 'normal' : 'low'} relative volume`]);
  keys.push([`extension:${ev.momentum?.overextended ? 'overextended' : (ev.momentum?.ext1h ?? 0) > 1.5 ? 'stretched' : 'near_mean'}`, `price ${ev.momentum?.overextended ? 'overextended' : (ev.momentum?.ext1h ?? 0) > 1.5 ? 'stretched above' : 'near'} its 1h mean`]);
  keys.push([`flow:${ev.flow?.h1shift && ev.flow.h1shift !== 'none' ? ev.flow.h1shift : ev.flow?.h1 ?? 'balanced'}`, `1h buyer/seller state (${(ev.flow?.h1shift && ev.flow.h1shift !== 'none' ? ev.flow.h1shift : ev.flow?.h1 ?? 'balanced').replace(/_/g, ' ')})`]);
  keys.push([`rr:${(d.rr ?? 0) >= 4 ? '4+' : (d.rr ?? 0) >= 3 ? '3-4' : '<3'}`, `planned R:R ${(d.rr ?? 0) >= 4 ? '4+' : (d.rr ?? 0) >= 3 ? '3-4' : 'under 3'}`]);
  keys.push([`news:${(ev.news?.effect ?? 0) > 0.15 ? 'positive' : (ev.news?.effect ?? 0) < -0.15 ? 'negative' : 'none'}`, `${(ev.news?.effect ?? 0) > 0.15 ? 'positive' : (ev.news?.effect ?? 0) < -0.15 ? 'negative' : 'no'} news effect`]);
  return keys.map(([key, desc]) => ({ key, desc }));
}

/* ---------------------------------------------------------------------- record */
let seq = 0;
/** Journal a decision (called for every BUY and for the strongest WATCH / vetoed candidates each scan). Returns the entry id. */
export function record(d, now = Date.now()) {
  if (!d?.setup && d?.action !== 'BUY') return null;
  const last = [...journal.entries].reverse().find((e) => e.symbol === d.symbol && now - e.at < 55 * 60_000 && e.action === d.action);
  if (last && d.action !== 'BUY') return last.id;             // one record per coin per hour per action: the outcome clock must not be flooded by repeats
  const e = {
    id: `d${now.toString(36)}${(seq++).toString(36)}`, at: now, symbol: d.symbol, action: d.action, cls: d.cls, score: d.score, pUp: d.pUp, ev: d.ev, setup: d.setup?.name ?? null,
    price: d.evidence?.price ?? d.entry, entry: d.entry, stop: d.stop, target: d.target, rr: d.rr, holdHours: d.holdHours, factors: d.factors,
    vetoes: d.vetoes.map((v) => v.code), hard: d.vetoes.filter((v) => v.hard).map((v) => v.code), reasons: d.reasons.slice(0, 8), evidence: d.evidence, keys: featureKeys(d).map((k) => k.key), outcome: null,
  };
  journal.entries.push(e); journal.dirty = true;
  if (journal.entries.length > 3500) journal.entries.splice(0, journal.entries.length - 3000);
  return e.id;
}

/** Sparse per-coin history (one compact row per coin per ringEveryMs): lets us answer "what did the AI think of this coin BEFORE it moved?". */
export function noteScan(symbol, d, now = Date.now()) {
  let a = journal.ring.get(symbol);
  if (!a) journal.ring.set(symbol, a = []);
  if (a.length && now - a[a.length - 1].t < B.ringEveryMs) return;
  a.push({ t: now, a: d.action, c: d.cls, s: d.score, su: d.setup?.name ?? null, v: d.vetoes.map((v) => v.code).slice(0, 5), p: d.evidence?.price ?? null });
  if (a.length > B.ringPerSymbol) a.shift();
  journal.dirty = true;
}

/* -------------------------------------------------------------------- outcomes */
/** First-touch outcome of a trade plan on candles AFTER the decision. Stop wins ties (conservative). 15m candles: { t (s), o, h, l, c }. */
export function measure(entry, candles, plan, now = Date.now()) {
  const p0 = plan.entry ?? plan.price, startS = Math.floor(entry.at / 1000);
  const stop = plan.stop ?? p0 * 0.98, target = plan.target ?? p0 * 1.04;
  const horizonS = Math.max(4, Math.min(entry.holdHours ?? 24, 48)) * 3600;
  let mfe = 0, mae = 0, hit = null, hitAt = null, lastC = p0, n = 0;
  for (const c of candles) {
    if (c.t + 900 <= startS) continue;
    if (c.t > startS + horizonS) break;
    n++; lastC = c.c; mfe = Math.max(mfe, c.h / p0 - 1); mae = Math.min(mae, c.l / p0 - 1);
    if (!hit) { if (c.l <= stop) { hit = 'stop'; hitAt = c.t; } else if (c.h >= target) { hit = 'target'; hitAt = c.t; } }
  }
  const complete = candles.length && candles[candles.length - 1].t + 900 >= startS + horizonS;
  if (!hit && !complete) return null;                         // not matured yet
  const risk = (p0 - stop) / p0 + COST;
  const exit = hit === 'stop' ? stop : hit === 'target' ? target : lastC;
  const R = risk > 0 ? ((exit / p0 - 1) - COST) / risk : 0;
  return { measuredAt: now, hit: hit ?? 'timeout', R: +R.toFixed(2), mfe: +mfe.toFixed(4), mae: +mae.toFixed(4), ret: +(lastC / p0 - 1).toFixed(4), hoursToHit: hitAt ? +((hitAt - startS) / 3600).toFixed(1) : null, source: 'candles', bars: n };
}

/** Measure every matured, unmeasured journal entry (counterfactual for non-trades). fetch15m(symbol) -> candles. At most `budget` coins per call (API courtesy). */
export async function resolveOutcomes(fetch15m, now = Date.now(), budget = 6) {
  const pending = journal.entries.filter((e) => !e.outcome && !e.tradeId && now - e.at >= Math.max(4, Math.min(e.holdHours ?? 24, 48)) * 3600_000 && now - e.at < 70 * 3600_000);
  const bySym = new Map(); for (const e of pending) (bySym.get(e.symbol) ?? bySym.set(e.symbol, []).get(e.symbol)).push(e);
  let done = 0;
  for (const [sym, list] of bySym) {
    if (done >= budget) break; done++;
    try {
      const candles = await fetch15m(sym);
      for (const e of list) { const m = measure(e, candles, e, now); if (m) { e.outcome = m; journal.dirty = true; } }
    } catch (err) { warn('outcome fetch', sym, err.message); }
  }
  // entries too old for 15m history that never got measured are closed out as unmeasurable (never counted)
  for (const e of journal.entries) if (!e.outcome && !e.tradeId && now - e.at >= 70 * 3600_000) { e.outcome = { hit: 'unmeasured', R: null, source: 'expired' }; journal.dirty = true; }
}

/** A real paper trade opened from decision `id`: its outcome is the real trade's, not a counterfactual. */
export function attachTrade(id, tradeId) { const e = journal.entries.find((x) => x.id === id); if (e) { e.tradeId = tradeId; journal.dirty = true; } }
export function closeTrade(tradeId, r) {
  const e = journal.entries.find((x) => x.tradeId === tradeId); if (!e) return null;
  const risk = e.entry && e.stop ? (e.entry - e.stop) / e.entry + COST : null;
  e.outcome = { measuredAt: Date.now(), hit: r.exitReason, R: risk ? +(r.pnlPct / risk).toFixed(2) : null, pnl: r.pnl, pnlPct: +r.pnlPct.toFixed(4), mfe: +r.mfe.toFixed(4), mae: +r.mae.toFixed(4), hoursHeld: +r.hours.toFixed(1), source: 'trade', why: r.why };
  journal.dirty = true; return e;
}

/* ------------------------------------------------------------ walk-forward rules */
const resolved = () => journal.entries.filter((e) => e.outcome && e.outcome.R != null && e.setup).sort((a, b) => a.at - b.at);

/**
 * Learn bucket rules with chronological walk-forward validation. For each bucket key: average R of the earlier 60% (train) and the later 40% (test) of ITS samples, compared with the
 * overall average. Active only when both halves have enough samples, agree in sign, and both differ from the overall average by >= 0.1R. delta (points) is small and bounded.
 */
export function learnRules(now = Date.now()) {
  const rs = resolved(), out = [];
  if (!rs.length) { journal.rules = []; journal.rulesAt = now; return []; }
  const overall = rs.reduce((a, e) => a + e.outcome.R, 0) / rs.length;
  const byKey = new Map(), desc = new Map();
  for (const e of rs) {
    const kd = featureKeys(e);
    for (const { key, desc: d } of kd) { desc.set(key, d); (byKey.get(key) ?? byKey.set(key, []).get(key)).push(e); }
  }
  for (const [key, list] of byKey) {
    const cut = Math.floor(list.length * B.learnTrainFrac), tr = list.slice(0, cut), te = list.slice(cut);
    const avg = (a) => (a.length ? a.reduce((s, e) => s + e.outcome.R, 0) / a.length : 0);
    const a = avg(tr) - overall, b = avg(te) - overall;
    let status = 'inactive', why = '';
    if (tr.length < B.learnMinTrain || te.length < B.learnMinTest) why = `needs ${B.learnMinTrain}+ train and ${B.learnMinTest}+ test samples (has ${tr.length}/${te.length})`;
    else if (Math.sign(a) !== Math.sign(b)) why = `train (${a.toFixed(2)}R vs average) and test (${b.toFixed(2)}R) disagree: not a stable rule`;
    else if (Math.abs(a) < 0.1 || Math.abs(b) < 0.1) why = 'effect smaller than 0.1R: ignored';
    else { status = 'active'; why = `${a > 0 ? 'outperforms' : 'underperforms'} the average by ${a.toFixed(2)}R (train, n=${tr.length}) and ${b.toFixed(2)}R (test, n=${te.length})`; }
    const m = (a + b) / 2;
    out.push({ key, desc: desc.get(key), status, why, nTrain: tr.length, nTest: te.length, trainR: +avg(tr).toFixed(2), testR: +avg(te).toFixed(2), delta: status === 'active' ? Math.round(clamp(m * 10, -B.learnBound, B.learnBound)) : 0 });
  }
  out.sort((x, y) => (y.status === 'active') - (x.status === 'active') || Math.abs(y.delta) - Math.abs(x.delta) || y.nTrain + y.nTest - x.nTrain - x.nTest);
  journal.rules = out; journal.rulesAt = now;
  return out;
}

/** Score adjustments that apply to a decision RIGHT NOW (active rules only, each bounded, total bounded again in brain.decide). */
export function adjustmentsFor(d) {
  const act = journal.rules.filter((r) => r.status === 'active' && r.delta);
  if (!act.length) return [];
  const keys = new Set(featureKeys(d).map((k) => k.key));
  return act.filter((r) => keys.has(r.key)).map((r) => ({ key: r.key, delta: r.delta, why: `${r.desc}: ${r.why}` }));
}

/**
 * Learned P(target before stop) per score bucket from MEASURED outcomes, shrunk toward the prior (k pseudo-observations) so a handful of results cannot swing it.
 * Returns null until there are enough measured outcomes; until then the brain reports its prior and labels it unvalidated.
 */
export function learnedPUp(prior) {
  const rs = resolved().filter((e) => e.stop && e.target);
  if (rs.length < 60) return null;
  const k = 20, bucket = (s) => (s >= 80 ? 3 : s >= 70 ? 2 : s >= 60 ? 1 : 0), agg = [0, 1, 2, 3].map(() => ({ n: 0, hit: 0 }));
  for (const e of rs) { const g = agg[bucket(e.score)]; g.n++; if (e.outcome.hit === 'target') g.hit++; }
  return (score) => { const g = agg[bucket(score)]; const p = prior(score); return +clamp((g.hit + k * p) / (g.n + k), 0.05, 0.9).toFixed(3); };
}

/* ------------------------------------------------------------ missed opportunities */
const VETO_TEXT = {
  downtrend_h1: 'the 1h was still in a downtrend (no confirmed structure break yet)', downtrend_h4: 'the 4h was in a downtrend', downtrend_d1: 'the daily trend was strongly down',
  supply_control: 'sellers were in control on the 1h', major_conflict: 'too many major signals pointed down', bad_news: 'a dangerous news event was active', regime: 'the market regime (BTC) did not allow long entries',
  wait_15m_turn: 'the 15m had not turned up yet', mid_range: 'price was in the middle of a range', poor_rr: 'reward-to-risk was too poor at that price (no room to the next resistance)',
  low_score: 'the evidence score was below the entry threshold', low_probability: 'the estimated probability was below the threshold', low_ev: 'expected value was too low', overextended: 'price was already extended', no_setup: 'no defined setup was present',
  no_valid_stop: 'no structural stop fit inside the 4% cap', illiquid_book: 'the order book was too thin', screened_out: 'the coin was screened out as illiquid / manipulated-looking', no_data: 'there was not enough candle history',
};

/**
 * "A coin went up X% today: why did the AI not detect it earlier?"  coins: [{ symbol, h1: [{t (s), h, l, c}] }] (last ~48 completed 1h bars). For each coin whose best long swing in the
 * last `missedWindowH` hours is >= missedMovePct, find what the brain thought just BEFORE the move began and when (if ever) it first flagged it.
 */
export function findMissed(coins, now = Date.now(), coarse = []) {
  const out = [], winS = now / 1000 - B.missedWindowH * 3600;
  for (const c of coins) {
    const bars = (c.h1 ?? []).filter((b) => b.t >= winS);
    if (bars.length < 6) continue;
    let lowI = 0, best = null;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].l < bars[lowI].l) lowI = i;
      const gain = bars[i].h / bars[lowI].l - 1;
      if (!best || gain > best.gain) best = { gain, lowI, highI: i };
    }
    if (!best || best.gain < B.missedMovePct) continue;
    const startMs = bars[best.lowI].t * 1000, peakMs = bars[best.highI].t * 1000, lowPx = bars[best.lowI].l, highPx = bars[best.highI].h;
    const ring = journal.ring.get(c.symbol) ?? [];
    const before = ring.filter((r) => r.t <= startMs + 30 * 60_000).slice(-1)[0] ?? null;
    const flagged = ring.find((r) => r.t > startMs - 60 * 60_000 && (r.a === 'WATCH' || r.a === 'BUY') && r.s >= B.watchScore);
    const flaggedPct = flagged?.p && lowPx ? flagged.p / lowPx - 1 : null;
    const early = flagged && flaggedPct != null && flaggedPct <= best.gain * 0.35;
    let why;
    if (!before) why = { code: 'not_analyzed', text: 'the coin was not being analysed at that time (outside the shortlist, or the scan had not seen it yet)' };
    else if (before.a === 'BUY') why = { code: 'bought', text: 'the AI had a BUY on this coin' };
    else { const code = before.v.find((v) => VETO_TEXT[v] && !['low_score', 'low_probability', 'low_ev'].includes(v)) ?? before.v[0] ?? 'low_score'; why = { code, text: VETO_TEXT[code] ?? code }; }
    out.push({
      symbol: c.symbol, movePct: +best.gain.toFixed(3), startAt: startMs, peakAt: peakMs, lowPx, highPx,
      before: before ? { at: before.t, action: before.a, cls: before.c, score: before.s, setup: before.su, vetoes: before.v } : null,
      firstFlagged: flagged ? { at: flagged.t, action: flagged.a, score: flagged.s, intoMovePct: flaggedPct != null ? +flaggedPct.toFixed(3) : null } : null, early: !!early,
      why, text: `${c.symbol} rose ${(best.gain * 100).toFixed(1)}% (${lowPx.toPrecision(4)} -> ${highPx.toPrecision(4)}). ${before ? `Just before the move the AI said ${before.a}${before.s != null ? ` (score ${before.s})` : ''}: ${why.text}.` : `Not detected earlier: ${why.text}.`}${flagged ? ` First flagged ${early ? 'early' : 'late'}${flaggedPct != null ? `, ${(flaggedPct * 100).toFixed(1)}% into the move` : ''}.` : ' It never reached WATCH/BUY before the move ended.'}`,
    });
  }
  for (const c of coarse) {
    if (out.some((m) => m.symbol === c.symbol)) continue;
    const why = { code: 'not_analyzed', text: 'the coin was never in the candle-analysed shortlist when it started moving (only the cheap radar saw it)' };
    out.push({ symbol: c.symbol, movePct: +c.gain.toFixed(3), startAt: null, peakAt: null, before: null, firstFlagged: null, early: false, why, text: `${c.symbol} is up ${(c.gain * 100).toFixed(1)}% over 24h (radar). Not detected: ${why.text}.` });
  }
  out.sort((a, b) => b.movePct - a.movePct);
  journal.missed = out.slice(0, 40); journal.missedAt = now; journal.dirty = true;
  return journal.missed;
}

/* ------------------------------------------------------------------- the report */
const stats = (rs) => {
  if (!rs.length) return { n: 0 };
  const w = rs.filter((e) => e.outcome.R > 0);
  return { n: rs.length, winRate: +(w.length / rs.length).toFixed(2), avgR: +(rs.reduce((a, e) => a + e.outcome.R, 0) / rs.length).toFixed(2), targetFirst: +(rs.filter((e) => e.outcome.hit === 'target').length / rs.length).toFixed(2), avgMfe: +(rs.reduce((a, e) => a + (e.outcome.mfe ?? 0), 0) / rs.length).toFixed(4), avgMae: +(rs.reduce((a, e) => a + (e.outcome.mae ?? 0), 0) / rs.length).toFixed(4) };
};

export function report(now = Date.now()) {
  const all = resolved(), trades = all.filter((e) => e.outcome.source === 'trade'), cf = all.filter((e) => e.outcome.source === 'candles');
  const buckets = [['80+', (s) => s >= 80], ['70-80', (s) => s >= 70 && s < 80], ['60-70', (s) => s >= 60 && s < 70], ['<60', (s) => s < 60]].map(([label, f]) => ({ label, ...stats(cf.filter((e) => f(e.score))) }));
  // Do the vetoes earn their keep? For every veto code: what did the setups it blocked actually do, and how many big moves did it sit on?
  const vetoRows = new Map();
  for (const e of cf) for (const v of e.vetoes) { const r = vetoRows.get(v) ?? { code: v, rs: [] }; r.rs.push(e); vetoRows.set(v, r); }
  const missedBy = {}; for (const m of journal.missed) missedBy[m.why.code] = (missedBy[m.why.code] ?? 0) + 1;
  const vetoes = [...vetoRows.values()].filter((r) => r.rs.length >= 5).map((r) => {
    const s = stats(r.rs);
    return { code: r.code, text: VETO_TEXT[r.code] ?? r.code, blocked: s.n, avgR: s.avgR, winRate: s.winRate, missedMoves: missedBy[r.code] ?? 0, verdict: s.n < 20 ? 'not enough data' : s.avgR < -0.05 ? 'protective (blocked setups lost money)' : s.avgR > 0.1 ? 'costly (blocked setups made money): review' : 'neutral' };
  }).sort((a, b) => b.blocked - a.blocked);
  const reasons = {}; for (const m of journal.missed) reasons[m.why.code] = (reasons[m.why.code] ?? 0) + 1;
  const flaggedEarly = journal.missed.filter((m) => m.early).length;
  const need = [];
  if (all.length < 60) need.push(`only ${all.length} measured outcomes so far (60+ needed before the probability map is learned, 8+/5+ per bucket before a rule can go live)`);
  return {
    at: now, journalSize: journal.entries.length, measured: all.length, pending: journal.entries.filter((e) => !e.outcome).length,
    trades: stats(trades), counterfactual: stats(cf), calibration: buckets, rules: journal.rules.slice(0, 14), activeRules: journal.rules.filter((r) => r.status === 'active').length,
    vetoes, missed: { list: journal.missed.slice(0, 12), count: journal.missed.length, early: flaggedEarly, topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, n, text: VETO_TEXT[code] ?? code })), checkedAt: journal.missedAt || null }, sufficiency: need,
    recentTrades: trades.slice(-8).reverse().map((e) => ({ symbol: e.symbol, setup: e.setup, score: e.score, R: e.outcome.R, pnl: e.outcome.pnl, hit: e.outcome.hit, mfe: e.outcome.mfe, mae: e.outcome.mae, why: e.outcome.why })),
  };
}
