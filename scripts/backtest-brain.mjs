// Online, look-ahead-free backtest of the Brain on REAL Coinbase history (public endpoints, read-only, no keys). Replays every hour: analyse every coin like the live scan, ask the Brain for LONG and SHORT
// evaluations, and walk every candidate setup forward on 5m candles (stop first if a bar touches both). The empirical probability model at hour T only knows outcomes whose 48h had already elapsed.
// Reports: the anti-chasing study (does entering late really do worse?), probability calibration (predicted vs actual on unseen data), realistic R per setup, and the full pipeline's online result.
// Usage:  node scripts/backtest-brain.mjs [days=30] [--refresh] [--calibrate]   (--calibrate writes logs/calibration.json, which the live Brain reads)
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
  if (!REFRESH && fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 24 * 3600_000) return JSON.parse(fs.readFileSync(f, 'utf8'));
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

const { observe, LEVELS, buildModel, saveHistorical, priorReach } = await import('../src/empirical.js');
const endSec = Math.floor(Date.now() / 3600_000) * 3600;
console.error(`loading ${SYMS.length} coins x ${DAYS} days (cached after the first run)…`);
const data = {};
for (const s of SYMS) { const d = await load(s, endSec); if (d) data[s] = d; }
const syms = Object.keys(data);
console.error(`${syms.length} coins loaded`);

const T0 = endSec - DAYS * 86400, T1 = endSec - 3 * 3600;
const HORIZON_H = 48, SLIP = config.risk.slippagePct;
const idx5 = (sym, T) => { const m5 = data[sym].m5; let lo = 0, hi = m5.length; while (lo < hi) { const m = (lo + hi) >> 1; if (m5[m].t < T) lo = m + 1; else hi = m; } return lo; };
const after = (sym, T, hours) => { const m5 = data[sym].m5, i = idx5(sym, T), out = []; for (let j = i; j < m5.length && m5[j].t < T + hours * 3600; j++) out.push(m5[j]); return out; };
const complete = (sym, T, hours) => { const m5 = data[sym].m5; return m5.length && m5[m5.length - 1].t >= T + hours * 3600 - 600; };

/** first touch of target / stop for either direction (stop wins ties); R net of costs */
function firstTouch(cs, entry, stop, target, dir, maxH) {
  const sg = dir === 'short' ? -1 : 1, risk = Math.abs(entry - stop) / entry + RR_COST;
  let last = entry, hit = 'timeout', n = 0;
  for (const c of cs) {
    if (n++ * 300 >= maxH * 3600) break;
    last = c.c;
    if (dir === 'long' ? c.l <= stop : c.h >= stop) { hit = 'stop'; last = stop; break; }
    if (dir === 'long' ? c.h >= target : c.l <= target) { hit = 'target'; last = target; break; }
  }
  return { hit, R: +((sg * (last / entry - 1) - RR_COST) / risk).toFixed(2) };
}

// ---- ONLINE replay: the probability model at hour T only knows observations whose 48h had already elapsed (no look-ahead)
const tables = {}, pending = [], cands = [];
let model = buildModel({}, []);
let steps = 0;
for (let T = T0; T <= T1; T += 3600) {
  steps++;
  let changed = false;
  while (pending.length && pending[0].T + HORIZON_H * 3600 <= T) {
    const o = pending.shift();
    if (o.use) { const t = (tables[`${o.side}:${o.setup}`] ??= { n: 0, hits: LEVELS.map(() => 0) }); t.n++; o.reach.forEach((r, i) => { if (r) t.hits[i]++; }); changed = true; }
  }
  if (changed) model = buildModel(tables, []);

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
  const btcGate = !!btcT && btcT.ema20 > btcT.ema50 && btcT.price > btcT.ema50;
  const regime = brain.marketRegime({ btc: ta.BTC, eth: ta.ETH, breadth, btcGate });
  const chg = (s, hrs) => { const h1 = upto(data[s].h1, 3600, T, hrs + 2); return h1.length > hrs ? px[s] / h1[h1.length - 1 - hrs].c - 1 : 0; };
  const med = (a) => { const x = a.slice().sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : 0; };
  const c1 = Object.fromEntries(live.map((s) => [s, chg(s, 1)])), c24 = Object.fromEntries(live.map((s) => [s, chg(s, 24)]));
  const rsEnv = { mkt1: med(Object.values(c1)), mkt24: med(Object.values(c24)), btc24: c24.BTC ?? 0, eth24: c24.ETH ?? 0 };
  for (const s of live) {
    const dec = brain.decide({ symbol: s, ta: ta[s], regime, news: null, market: null, book: null, chg1h: c1[s], chg24h: c24[s], rs: rsEnv, smart: null, adj: [], empirical: model, full: true,
      selected: [], shape: (e, st, tg) => risk.shapeTrade(e, st, tg, { symbol: s, rank: syms.indexOf(s) + 1 }) });
    for (const side of ['long', 'short']) {
      const c = dec._both[side];
      if (!c || !c.setup || c.entry == null || !c.stop || !c.target) continue;
      const entry = px[s] * (1 + (side === 'long' ? 1 : -1) * SLIP), cs5 = after(s, T, 72);
      if (!cs5.length || !complete(s, T, 6)) continue;
      const ft = firstTouch(cs5, entry, c.stop, c.target, side, Math.min(c.holdHours * 2, 72));
      const obs = observe(cs5, entry, c.stop, side, T, HORIZON_H * 3600, 300);
      const rec = { sym: s, T, side, setup: c.setup.name, score: c.score, scores: c.scores, chase: c.chase && { verdict: c.chase.verdict, score: c.chase.score, atLevel: c.chase.atLevel }, vetoes: c.vetoes.map((v) => v.code), hard: c.vetoes.filter((v) => v.hard).map((v) => v.code),
        floor: c.floor, action: c.action, pUp: c.pUp, pSample: c.pSample, targetR: c.targetR, rr: c.rr, stopDist: c.stopDist, regime: regime.label, severe: regime.severe, ft, reach: obs?.reach ?? null, maxR: obs?.maxR ?? null, matured: complete(s, T, HORIZON_H) };
      cands.push(rec);
      // The probability model is calibrated on the population the Brain would ACTUALLY take: candidates that pass every gate except the EV test itself. Calibrating on all setups (including the ones it
      // would never take) is adverse-selection blind: the gates pick a different, here worse, population than the average setup.
      if (obs && rec.matured) pending.push({ T, side, setup: rec.setup, reach: obs.reach, use: rec.vetoes.every((v) => v === 'low_ev') });
    }
  }
}

/* ------------------------------------------------------------------ reports */
const stat = (rows) => {
  const n = rows.length; if (!n) return { n: 0 };
  const w = rows.filter((r) => r.ft.R > 0).length, sumR = rows.reduce((a, r) => a + r.ft.R, 0), mx = rows.filter((r) => r.maxR != null);
  const rc = (L) => { const i = LEVELS.indexOf(L), m = rows.filter((r) => r.reach); return m.length ? +(m.filter((r) => r.reach[i]).length / m.length).toFixed(2) : null; };
  return { n, tgt: +(rows.filter((r) => r.ft.hit === 'target').length / n).toFixed(2), stop: +(rows.filter((r) => r.ft.hit === 'stop').length / n).toFixed(2), win: +(w / n).toFixed(2), avgR: +(sumR / n).toFixed(2), meanMaxR: mx.length ? +(mx.reduce((a, r) => a + r.maxR, 0) / mx.length).toFixed(2) : null, reach1R: rc(1), reach2R: rc(2), reach2_5R: rc(2.5) };
};
const group = (rows, f) => { const g = {}; for (const r of rows) for (const k of [].concat(f(r))) (g[k] ??= []).push(r); return g; };
const table = (title, g) => { console.log(title); for (const [k, v] of Object.entries(g).sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(k).padEnd(30)}`, JSON.stringify(stat(v))); };
const halves = (rows) => { const s = rows.slice().sort((a, b) => a.T - b.T), c = Math.floor(s.length * config.brain.learnTrainFrac); return [s.slice(0, c), s.slice(c)]; };

const longs = cands.filter((c) => c.side === 'long'), shorts = cands.filter((c) => c.side === 'short');
console.log(`BACKTEST (online, no look-ahead): ${syms.length} coins, ${DAYS} days, ${steps} hourly steps. Candidates with a defined setup: ${longs.length} long, ${shorts.length} short.`);
table('\nCandidates by setup (long+short):', group(cands, (r) => `${r.side}:${r.setup}`));

console.log('\n=== ANTI-CHASING STUDY (long candidates; does entering after the move really do worse?) ===');
table('By anti-chasing verdict (all):', group(longs, (r) => r.chase?.verdict ?? '?'));
const [lA, lB] = halves(longs);
table('  earlier 60%:', group(lA, (r) => r.chase?.verdict ?? '?')); table('  later 40% (unseen):', group(lB, (r) => r.chase?.verdict ?? '?'));
table('By timing score:', group(longs, (r) => (r.scores.timing >= 80 ? 'timing 80+' : r.scores.timing >= 65 ? 'timing 65-80' : r.scores.timing >= 50 ? 'timing 50-65' : 'timing <50')));
table('Same for shorts, by anti-chasing verdict:', group(shorts, (r) => r.chase?.verdict ?? '?'));

console.log('\n=== PROBABILITY CALIBRATION, walk-forward (fit on the earlier 60%, scored on the later 40%; each observation x each R level) ===');
const obsAll = cands.filter((c) => c.reach && c.matured && c.vetoes.every((v) => v === 'low_ev')).sort((a, b) => a.T - b.T);      // the selected population (everything but the EV test)
const cut = Math.floor(obsAll.length * config.brain.learnTrainFrac), train = obsAll.slice(0, cut), test = obsAll.slice(cut);
const tabFrom = (rows) => { const t = {}; for (const r of rows) { const x = (t[`${r.side}:${r.setup}`] ??= { n: 0, hits: LEVELS.map(() => 0) }); x.n++; r.reach.forEach((v, i) => { if (v) x.hits[i]++; }); } return t; };
const mTrain = buildModel(tabFrom(train), []);
let bM = 0, bP = 0, bB = 0, nn = 0, sumP = 0, sumY = 0; const baseTr = LEVELS.map((L, i) => train.filter((r) => r.reach[i]).length / Math.max(1, train.length));
const bins = new Map();
for (const r of test) LEVELS.forEach((L, i) => {
  const y = r.reach[i] ? 1 : 0, p = mTrain.pReach(r.setup, r.side, L).p, pr = priorReach(L);
  sumP += p; sumY += y; bM += (p - y) ** 2; bP += (pr - y) ** 2; bB += (baseTr[i] - y) ** 2; nn++;
  const k = Math.min(0.9, Math.floor(p * 10) / 10), b = bins.get(k) ?? { n: 0, pred: 0, hit: 0 }; b.n++; b.pred += p; b.hit += y; bins.set(k, b);
});
const wf = nn ? { haircut: +Math.max(0.5, Math.min(1, sumY / sumP)).toFixed(3), trainObs: train.length, testObs: test.length, brierModel: +(bM / nn).toFixed(4), brierZeroDriftPrior: +(bP / nn).toFixed(4), brierTrainBaseRate: +(bB / nn).toFixed(4), bins: [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => ({ range: `${(k * 100).toFixed(0)}-${(k * 100 + 10).toFixed(0)}%`, n: b.n, predicted: +(b.pred / b.n).toFixed(3), actual: +(b.hit / b.n).toFixed(3) })) } : null;
if (wf) { console.log(`out-of-sample haircut (actual / predicted on the unseen part): ${wf.haircut}`);
  console.log(`train ${wf.trainObs} / test ${wf.testObs} observations.  Brier (lower is better): fitted model ${wf.brierModel}  |  zero-drift prior ${wf.brierZeroDriftPrior}  |  train base rate ${wf.brierTrainBaseRate}`); console.log('  predicted vs actual on the unseen test part:'); for (const b of wf.bins) console.log(`   ${b.range.padEnd(8)} n=${String(b.n).padEnd(6)} predicted ${b.predicted}  actual ${b.actual}`); }
console.log('Realistic R per setup (largest R reached at least ' + config.brain.minPUp * 100 + '% of the time, fitted on ALL matured observations):');
const mAll = buildModel(tabFrom(obsAll), []);
for (const k of Object.keys(tabFrom(obsAll)).sort()) { const [side, setup] = k.split(':'); console.log(`  ${k.padEnd(34)} n=${String(mAll.n(setup, side)).padEnd(5)} P(1R) ${mAll.pReach(setup, side, 1).p}  P(1.5R) ${mAll.pReach(setup, side, 1.5).p}  P(2.5R) ${mAll.pReach(setup, side, 2.5).p}  realistic ~${mAll.realisticR(setup, side, config.brain.minPUp)}R`); }

console.log('\n=== THE FULL PIPELINE, ONLINE (probabilities learned only from already-matured outcomes) ===');
const buys = cands.filter((c) => c.action === 'BUY'), sh = cands.filter((c) => c.action === 'SHORT');
console.log(`LONG entries the Brain would have taken: ${JSON.stringify(stat(buys))}`);
const [bA, bB2] = halves(buys); console.log(`  earlier: ${JSON.stringify(stat(bA))}\n  later  : ${JSON.stringify(stat(bB2))}`);
console.log(`SHORT setups that passed every gate (detected, execution is OFF): ${JSON.stringify(stat(sh))}`);
table('Long candidates that passed direction + timing (no geometry/probability yet):', group(longs.filter((c) => c.scores.direction >= config.brain.minDirection && c.scores.timing >= config.brain.minTiming && !c.hard.length), () => 'dir+timing ok, no hard veto'));
table('Veto frequency among long candidates:', group(longs, (r) => r.vetoes));

if (process.argv.includes('--calibrate')) {
  saveHistorical({ builtAt: Date.now(), days: DAYS, rows: obsAll.length, coins: syms.length, tables: tabFrom(obsAll), walkForward: wf, note: 'observations = hypothetical trades at every defined setup that passes every gate except the EV test (the population the Brain would actually take), walked forward on 5m candles; reach = hit +R before the stop within 48h' });
  console.log(`\ncalibration written to logs/calibration.json (${obsAll.length} observations)`);
}
fs.writeFileSync(path.join(CACHE, `bt-candidates-${DAYS}d.json`), JSON.stringify(cands));
process.exit(0);
