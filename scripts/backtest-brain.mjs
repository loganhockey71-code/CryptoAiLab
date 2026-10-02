// Walk-forward backtest of the Brain on REAL Coinbase history (public endpoints, read-only, no keys). Replays every hour: analyse every coin the way the live scan does,
// ask the Brain for a decision, and score each BUY by walking forward on 5m candles (stop first if a bar touches both). Outcomes are in R (net of fees + slippage).
// Usage:  node scripts/backtest-brain.mjs [days=30] [--refresh] [--json]
// It reports (1) results by score bucket and setup, (2) the SAME entries split chronologically into train/test (the test half was not used to choose anything),
// (3) baselines: what the old-style "technical flags only" entry and "buy anyway in a downtrend" would have done with the same stop/target rules.
import fs from 'node:fs';
import path from 'node:path';
process.env.PAPER_TRADING ??= 'true';
const { config } = await import('../src/config.js');
const { analyzeAll } = await import('../src/structure.js');
const brain = await import('../src/brain.js');
const risk = await import('../src/risk.js');
const { aggregate } = await import('../src/indicators.js');

const DAYS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 30;
const REFRESH = process.argv.includes('--refresh'), JSON_OUT = process.argv.includes('--json');
const REST = 'https://api.exchange.coinbase.com';
const CACHE = path.join(config.root, 'logs', 'backtest-cache');
fs.mkdirSync(CACHE, { recursive: true });
const SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'UNI', 'ATOM', 'NEAR', 'APT', 'ARB', 'OP', 'INJ', 'SUI', 'SEI', 'TIA', 'FET', 'AAVE', 'HBAR', 'ETC', 'FIL', 'ICP', 'IMX', 'PEPE', 'SHIB', 'BONK', 'WIF', 'ENA', 'JUP', 'ONDO', 'RENDER', 'TAO', 'CRV', 'MKR', 'STX'];
const RR_COST = 2 * (config.risk.feePct + config.risk.slippagePct);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, n = 0) {
  const res = await fetch(url, { headers: { 'User-Agent': 'crypto-ai-lab-backtest/1.0' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429 && n < 4) { await sleep(1500 * (n + 1)); return get(url, n + 1); }
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}
async function fetchRange(product, gran, s0, s1) {
  const out = new Map();
  for (let s = s0; s < s1; s += 300 * gran) {
    const e = Math.min(s + 300 * gran, s1);
    const rows = await get(`${REST}/products/${product}/candles?granularity=${gran}&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`);
    for (const [t, l, h, o, c, v] of rows) out.set(t, { t, o, h, l, c, v });
    await sleep(170);
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
async function load(sym, endSec) {
  const f = path.join(CACHE, `${sym}-${DAYS}d.json`);
  if (!REFRESH && fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 6 * 3600_000) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const product = `${sym}-USD`, start = endSec - DAYS * 86400;
  try {
    const data = { h1: await fetchRange(product, 3600, start - 320 * 3600, endSec), m15: await fetchRange(product, 900, start - 80 * 3600, endSec), m5: await fetchRange(product, 300, start - 30 * 3600, endSec), d1: await fetchRange(product, 86400, start - 320 * 86400, endSec) };
    if (data.h1.length < 400) return null;
    fs.writeFileSync(f, JSON.stringify(data));
    return data;
  } catch (e) { console.error(`skip ${sym}: ${e.message}`); return null; }
}

const upto = (arr, gran, T, n = 300) => {        // completed candles at time T, plus a pseudo-forming candle at the latest known price
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t + gran <= T) lo = m + 1; else hi = m; }
  return arr.slice(Math.max(0, lo - n), lo);
};
const withForming = (done, price, t) => (done.length ? [...done, { t, o: price, h: price, l: price, c: price, v: 0 }] : done);

const end = Math.floor(Date.now() / 3600_000) * 3600 - 3600 * 0, endSec = end;
console.error(`loading ${SYMS.length} coins x ${DAYS} days (cached after the first run)…`);
const data = {};
for (const s of SYMS) { const d = await load(s, endSec); if (d) data[s] = d; }
const syms = Object.keys(data);
console.error(`${syms.length} coins loaded`);

const T0 = endSec - DAYS * 86400, T1 = endSec - 3 * 3600;          // leave 3h of future for the last entries
const outcomes = [];
function walk(sym, T, entry, stop, target, maxH) {
  const m5 = data[sym].m5; let i = 0, hi = m5.length;
  while (i < hi) { const m = (i + hi) >> 1; if (m5[m].t < T) i = m + 1; else hi = m; }
  let mfe = 0, mae = 0;
  const limit = T + maxH * 3600;
  for (; i < m5.length && m5[i].t < limit; i++) {
    const c = m5[i];
    mfe = Math.max(mfe, c.h / entry - 1); mae = Math.min(mae, c.l / entry - 1);
    if (c.l <= stop) return { exit: stop, reason: 'stop', mfe, mae, hours: (c.t - T) / 3600 };
    if (c.h >= target) return { exit: target, reason: 'target', mfe, mae, hours: (c.t - T) / 3600 };
  }
  const lastC = m5[Math.min(i, m5.length) - 1] ?? { c: entry };
  return { exit: lastC.c, reason: 'timeout', mfe, mae, hours: maxH };
}
const R_of = (entry, stop, exit) => ((exit / entry - 1) - RR_COST) / ((entry - stop) / entry + RR_COST);

const rows = [];       // one feature row per coin-hour with forward returns: input for scripts/research-factors.mjs
function forward(sym, T, p0) {
  const m5 = data[sym].m5; let i = 0, hi = m5.length;
  while (i < hi) { const m = (i + hi) >> 1; if (m5[m].t < T) i = m + 1; else hi = m; }
  if (!m5[i] || m5[m5.length - 1].t < T + 24 * 3600 - 600) return null;
  const at = (h) => { const t = T + h * 3600 - 300; let j = i; while (j < m5.length - 1 && m5[j].t < t) j++; return m5[j].c / p0 - 1; };
  let label = null, mfe = 0, mae = 0;
  for (let j = i; j < m5.length && m5[j].t < T + 24 * 3600; j++) {
    const c = m5[j]; mfe = Math.max(mfe, c.h / p0 - 1); mae = Math.min(mae, c.l / p0 - 1);
    if (label == null) { if (c.l <= p0 * 0.98) label = 0; else if (c.h >= p0 * 1.04) label = 1; }
  }
  return { r2: at(2), r6: at(6), r12: at(12), r24: at(24), mfe, mae, up4dn2: label };
}
let steps = 0;
for (let T = T0; T <= T1; T += 3600) {
  steps++;
  const ta = {}, px = {};
  for (const s of syms) {
    const d = data[s], m5 = upto(d.m5, 300, T, 300);
    if (m5.length < 100) continue;
    const price = m5[m5.length - 1].c; px[s] = price;
    const h1 = upto(d.h1, 3600, T), m15 = upto(d.m15, 900, T), d1 = upto(d.d1, 86400, T);
    if (h1.length < 120 || m15.length < 100) continue;
    ta[s] = analyzeAll({ d1: withForming(d1, price, T), h1: withForming(h1, price, T), m15: withForming(m15, price, T), m5: withForming(m5, price, T) });
  }
  const live = Object.keys(ta);
  const breadth = live.filter((s) => ta[s]['1h']?.trend.score >= 0.25).length / Math.max(1, live.length);
  const btcT = ta.BTC?.['1h'];
  const btcGate = !!btcT && btcT.ema20 > btcT.ema50 && btcT.price > btcT.ema50;      // the live risk rule: BTC 1h EMA20 > EMA50 and price above the EMA50
  const regime = brain.marketRegime({ btc: ta.BTC, eth: ta.ETH, breadth, btcGate });
  const chg = (s, hrs) => { const h1 = upto(data[s].h1, 3600, T, hrs + 2); return h1.length > hrs ? px[s] / h1[h1.length - 1 - hrs].c - 1 : 0; };
  for (const s of live) {
    if (s === 'BTC' && false) continue;
    const t = ta[s];
    const dec = brain.decide({ symbol: s, ta: t, regime, news: null, market: null, book: null, chg24h: chg(s, 24), btcChg24h: chg('BTC', 24), smart: null, adj: [],
      shape: (e, st, tg) => risk.shapeTrade(e, st, tg, { symbol: s, rank: syms.indexOf(s) + 1 }) });
    const rec = { sym: s, T, action: dec.action, cls: dec.cls, score: dec.score, pUp: dec.pUp, setup: dec.setup?.name ?? null, vetoes: dec.vetoes.map((v) => v.code), hard: dec.vetoes.filter((v) => v.hard).map((v) => v.code), rr: dec.rr, btcGate };
    if (dec.stop && dec.target && dec.setup) {            // EVERY candidate setup is scored (not only BUYs) so thresholds and vetoes can be judged on evidence
      const entry = px[s] * (1 + config.risk.slippagePct), w = walk(s, T, entry, dec.stop, dec.target, Math.min(dec.holdHours * 2, 72));
      Object.assign(rec, { kind: 'brain', R: R_of(entry, dec.stop, w.exit), reason: w.reason, mfe: w.mfe, mae: w.mae, hours: w.hours, stopDist: dec.stopDist });
    }
    const fw = forward(s, T, px[s]);
    if (fw) {
      const h1 = t['1h'], m15 = t['15m'], h4 = t['4h'], d1 = t['1d'];
      rows.push({ sym: s, T, score: dec.score, action: dec.action, setup: dec.setup?.name ?? null, hard: rec.hard, vetoes: rec.vetoes, f: dec.factors, regime: regime.score, btcGate,
        x: { d1: d1?.trend.score ?? 0, h4: h4.trend.score, h1: h1.trend.score, m15: m15.trend.score, m5: t['5m'].trend.score, flow1: h1.flow.recent, flow15: m15.flow.recent, rvol15: m15.volume.rvol ?? 1, rvol1: h1.volume.rvol ?? 1, rsi1: h1.momentum.rsi ?? 50, ext1: h1.momentum.extensionAtr, ext15: m15.momentum.extensionAtr, roc6: h1.momentum.roc6, roc24: h1.momentum.roc24, atrPct: h1.atrPct, rs: chg(s, 24) - chg('BTC', 24), chg24: chg(s, 24), chg4: chg(s, 4),
          boxPos: h1.box?.pos ?? -1, supDist: h1.levels.support ? (px[s] - h1.levels.support.price) / h1.atr : 9, resDist: h1.levels.resistance ? (h1.levels.resistance.price - px[s]) / h1.atr : 9, candle15: m15.candles.score, candle1: h1.candles.score, bullBreak1: h1.trend.bullBreak ? 1 : 0, demandShift1: h1.flow.shift === 'demand_takeover' ? 1 : h1.flow.shift === 'supply_takeover' ? -1 : 0 },
        fw });
    }
    // baselines on identical stop/target geometry (3% stop, 7.5% target = 2.5R before costs): old-style flags-only entry, and "buy anyway" inside a downtrend
    const flagsUp = (k) => t[k] && t[k].trend.score >= 0.25 && t[k].aboveEma20;
    const base = (kind) => { const entry = px[s] * (1 + config.risk.slippagePct), stop = px[s] * 0.97, tg = px[s] * 1.075, w = walk(s, T, entry, stop, tg, 48); outcomes.push({ sym: s, T, kind, R: R_of(entry, stop, w.exit), reason: w.reason, btcGate }); };
    if (btcGate && flagsUp('5m') && flagsUp('15m') && flagsUp('1h') && (T / 3600) % 3 === 0) base('baseline_flags_only');
    if (btcGate && (t['4h'].trend.score <= -0.25 || t['1h'].trend.score <= -0.25) && t['15m'].trend.score >= 0.25 && (T / 3600) % 3 === 0) base('baseline_buy_in_downtrend');
    if (rec.kind) outcomes.push(rec);
    else if (JSON_OUT) outcomes.push(rec);
  }
}

const stat = (rows) => {
  const n = rows.length; if (!n) return { n: 0 };
  const wins = rows.filter((r) => r.R > 0).length, sumR = rows.reduce((a, r) => a + r.R, 0);
  const gp = rows.filter((r) => r.R > 0).reduce((a, r) => a + r.R, 0), gl = -rows.filter((r) => r.R <= 0).reduce((a, r) => a + r.R, 0);
  return { n, win: +(wins / n).toFixed(2), tgt: +(rows.filter((r) => r.reason === 'target').length / n).toFixed(2), stop: +(rows.filter((r) => r.reason === 'stop').length / n).toFixed(2), avgR: +(sumR / n).toFixed(2), pf: gl > 0 ? +(gp / gl).toFixed(2) : null, totalR: +sumR.toFixed(1) };
};
const cands = outcomes.filter((o) => o.kind === 'brain').sort((a, b) => a.T - b.T);
const buys = cands.filter((o) => o.action === 'BUY');
const group = (rows, keyFn) => { const g = {}; for (const r of rows) for (const k of [].concat(keyFn(r))) (g[k] ??= []).push(r); return g; };
const table = (title, g) => { console.log(title); for (const [k, v] of Object.entries(g).sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(k).padEnd(26)}`, JSON.stringify(stat(v))); };
console.log(`BACKTEST: ${syms.length} coins, ${DAYS} days, ${steps} hourly steps`);
console.log('BRAIN BUYs (every gate passed):', JSON.stringify(stat(buys)));
console.log('ALL candidate setups (stop/target from structure, any veto):', JSON.stringify(stat(cands)));
table('By setup (all candidates):', group(cands, (r) => r.setup));
table('By score bucket (all candidates):', group(cands, (r) => (r.score >= 80 ? '80+' : r.score >= 70 ? '70-80' : r.score >= 60 ? '60-70' : r.score >= 50 ? '50-60' : '<50')));
table('By HARD veto (a candidate with a hard veto is one the brain refuses):', group(cands, (r) => (r.hard.length ? r.hard : ['none'])));
table('By SOFT veto present:', group(cands, (r) => r.vetoes.filter((v) => !r.hard.includes(v)).concat(r.vetoes.length ? [] : ['none'])));
table('No hard veto, by score bucket:', group(cands.filter((r) => !r.hard.length), (r) => (r.score >= 80 ? '80+' : r.score >= 70 ? '70-80' : r.score >= 60 ? '60-70' : '<60')));
table('No hard veto, BTC gate open, by score bucket:', group(cands.filter((r) => !r.hard.length && r.btcGate), (r) => (r.score >= 80 ? '80+' : r.score >= 70 ? '70-80' : r.score >= 60 ? '60-70' : '<60')));
const elig = cands.filter((r) => !r.hard.length && r.rr >= config.risk.minRR);
const half = (rows) => { const c = Math.floor(rows.length * config.brain.learnTrainFrac); return [rows.slice(0, c), rows.slice(c)]; };
console.log('ELIGIBLE = no hard veto AND net R:R >= ' + config.risk.minRR + ' (the real entry criteria, before the score/probability thresholds):', JSON.stringify(stat(elig)));
for (const [name, set] of [['all eligible', elig], ['eligible, BTC gate open', elig.filter((r) => r.btcGate)], ['eligible, score>=70', elig.filter((r) => r.score >= 70)], ['eligible, score>=60 gate open', elig.filter((r) => r.score >= 60 && r.btcGate)]]) { const [a, b] = half(set); console.log(`  ${name.padEnd(30)} train ${JSON.stringify(stat(a))}
  ${''.padEnd(30)} test  ${JSON.stringify(stat(b))}`); }
for (const k of Object.keys(group(elig, (r) => r.setup))) { const set = elig.filter((r) => r.setup === k), [a, b] = half(set); console.log(`  setup ${k.padEnd(22)} train ${JSON.stringify(stat(a))}  test ${JSON.stringify(stat(b))}`); }
table('By stop distance (all candidates):', group(cands, (r) => (r.stopDist < 0.02 ? '<2%' : r.stopDist < 0.03 ? '2-3%' : '3-4%+')));
const cut = Math.floor(buys.length * config.brain.learnTrainFrac);
console.log('\nWALK-FORWARD (chronological): the first part is "train", the later part was never looked at to choose anything');
console.log('  train:', JSON.stringify(stat(buys.slice(0, cut))));
console.log('  test :', JSON.stringify(stat(buys.slice(cut))));
console.log('\nBASELINES (same entries every 3h, 3% stop / 7.5% target):');
console.log('  old-style flags only (5m+15m+1h trend flags, BTC gate):', JSON.stringify(stat(outcomes.filter((o) => o.kind === 'baseline_flags_only'))));
console.log('  buying 15m strength INSIDE a 1h/4h downtrend           :', JSON.stringify(stat(outcomes.filter((o) => o.kind === 'baseline_buy_in_downtrend'))));
const recs = outcomes.filter((o) => o.action);
if (JSON_OUT) fs.writeFileSync(path.join(CACHE, `decisions-${DAYS}d.json`), JSON.stringify(recs));
fs.writeFileSync(path.join(CACHE, `features-${DAYS}d.json`), JSON.stringify(rows));
console.log(`features: ${rows.length} coin-hour rows saved for research-factors.mjs`);
const all = {}; for (const r of recs) all[r.action] = (all[r.action] ?? 0) + 1;
console.log('\nDecision mix (JSON mode only):', JSON.stringify(all));
console.log('Veto frequency:'); const vc = {}; for (const r of recs) for (const v of r.vetoes) vc[v] = (vc[v] ?? 0) + 1; console.log(' ', JSON.stringify(Object.fromEntries(Object.entries(vc).sort((a, b) => b[1] - a[1]))));
const sc = recs.map((r) => r.score).sort((a, b) => a - b);
if (sc.length) console.log('Score distribution (all coin-hours): p50', sc[Math.floor(sc.length * 0.5)], 'p90', sc[Math.floor(sc.length * 0.9)], 'p99', sc[Math.floor(sc.length * 0.99)], 'max', sc[sc.length - 1]);
process.exit(0);
