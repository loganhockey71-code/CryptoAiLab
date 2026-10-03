// SETUP DISCOVERY: the Brain's named setups are not the end of the list. This module mines history for feature combinations that predicted forward returns BETTER THAN THE MARKET
// after costs, validates them out of sample, and lets the Brain use survivors as 'discovered' setups. Pure functions; `scripts/discover-setups.mjs` runs it on the research data and
// writes logs/discovered-setups.json, which the engine loads.
//
// The bar is deliberately high because searching thousands of combinations on noisy data ALWAYS finds something that looks good by chance: a rule must (1) look good on the earlier 60% of time
// (t >= 2), (2) hold on the unseen later 40% with a large t-statistic (>= 3, using an effective sample size that discounts overlapping windows), (3) beat the cross-sectional average by more than costs,
// (4) have a positive net raw return, and (5) be positive in at least 3 of 4 consecutive time chunks. Finding nothing is a valid, expected result.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.root, 'logs', 'discovered-setups.json');
const COST = 2 * (config.risk.feePct + config.risk.slippagePct);
export const FEATURES = ['d1', 'h4', 'h1', 'flow1', 'flow4', 'demandShift', 'rvol1', 'rsi1', 'rsi4', 'ext1', 'ext4', 'roc6', 'roc24', 'atrPct', 'candle1', 'candle4', 'bullBreak1', 'boxPos', 'supDist', 'resDist', 'aboveE50', 'macdUp'];

/** The same feature vector the research data used, computed live from the structure engine output. */
export function featuresOf(T, chg24h = 0) {
  const h1 = T['1h'], h4 = T['4h'], d1 = T['1d'];
  if (!h1 || !h4) return null;
  const price = h1.price;
  return {
    d1: d1?.trend.score ?? 0, h4: h4.trend.score, h1: h1.trend.score, flow1: h1.flow.recent, flow4: h4.flow.recent, demandShift: h1.flow.shift === 'demand_takeover' ? 1 : h1.flow.shift === 'supply_takeover' ? -1 : 0,
    rvol1: h1.volume.rvol ?? 1, rsi1: h1.momentum.rsi ?? 50, rsi4: h4.momentum.rsi ?? 50, ext1: h1.momentum.extensionAtr, ext4: h4.momentum.extensionAtr, roc6: h1.momentum.roc6, roc24: chg24h,
    atrPct: h1.atrPct, candle1: h1.candles.score, candle4: h4.candles.score, bullBreak1: h1.trend.bullBreak ? 1 : 0, boxPos: h1.box?.pos ?? 0.5,
    supDist: h1.levels.support ? (price - h1.levels.support.price) / h1.atr : 9, resDist: h1.levels.resistance ? (h1.levels.resistance.price - price) / h1.atr : 9, aboveE50: h1.aboveEma50 ? 1 : 0, macdUp: h1.momentum.macdRising ? 1 : 0,
  };
}

export const matches = (rule, x) => !!x && rule.conds.every((c) => (c.op === '>=' ? x[c.f] >= c.v : x[c.f] <= c.v));
const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
export const describe = (conds) => conds.map((c) => `${c.f} ${c.op} ${fmt(c.v)}`).join(' AND ');

let loaded = [];
export function loadDiscovered() { try { loaded = JSON.parse(fs.readFileSync(FILE, 'utf8')).rules ?? []; } catch { loaded = []; } return loaded; }
export const discoveredRules = () => loaded;
export function saveDiscovered(obj) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj)); loaded = obj.rules ?? []; }

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/**
 * rows: [{ T, x: {feature...}, fw: { r24 }, ex: { r24 } }] (ex = return minus the same-hour average of all coins). Returns { rules, tested, trainRows, testRows }.
 * opts.minTrain / opts.minTest are sample floors; opts.tTest is the out-of-sample t-statistic required.
 */
export function discover(rows, opts = {}) {
  const { minTrain = 300, minTest = 150, tTrain = 2, tTest = 3, minEx = Math.max(0.003, COST), overlap = 12, maxRules = 5 } = opts;
  rows = rows.slice().sort((a, b) => a.T - b.T);
  const Ts = [...new Set(rows.map((r) => r.T))], cutT = Ts[Math.floor(Ts.length * config.brain.learnTrainFrac)];
  const train = rows.filter((r) => r.T < cutT), test = rows.filter((r) => r.T >= cutT);
  const preds = [];
  for (const f of FEATURES) {
    const vals = train.map((r) => r.x[f]).sort((a, b) => a - b), seen = new Set();
    for (const q of [0.2, 0.4, 0.6, 0.8]) {
      const v = quantile(vals, q);
      for (const op of ['>=', '<=']) { const key = `${f}${op}${v}`; if (seen.has(key)) continue; seen.add(key); preds.push({ f, op, v }); }
    }
  }
  const test1 = (p, r) => (p.op === '>=' ? r.x[p.f] >= p.v : r.x[p.f] <= p.v);
  const mask = (set) => preds.map((p) => { const m = new Uint8Array(set.length); for (let i = 0; i < set.length; i++) m[i] = test1(p, set[i]) ? 1 : 0; return m; });
  const mTrain = mask(train);
  const stat = (set, ms, key) => {
    let n = 0, s = 0, s2 = 0, raw = 0;
    for (let i = 0; i < set.length; i++) { if (ms(i)) { const e = set[i].ex.r24; n++; s += e; s2 += e * e; raw += set[i].fw.r24; } }
    if (!n) return { n: 0, mean: 0, t: 0, raw: 0 };
    const mean = s / n, sd = Math.sqrt(Math.max(1e-12, s2 / n - mean * mean));
    return { n, mean, raw: raw / n - COST, t: mean / (sd / Math.sqrt(Math.max(1, n / overlap))) };
  };
  const cands = []; let tested = 0;
  const consider = (conds, ms) => {
    tested++;
    const a = stat(train, ms);
    if (a.n >= minTrain && a.t >= tTrain && a.mean >= minEx && a.raw >= 0) cands.push({ conds, train: a });
  };
  for (let i = 0; i < preds.length; i++) consider([preds[i]], (k) => mTrain[i][k]);
  for (let i = 0; i < preds.length; i++) for (let j = i + 1; j < preds.length; j++) { if (preds[i].f === preds[j].f) continue; consider([preds[i], preds[j]], (k) => mTrain[i][k] & mTrain[j][k]); }
  const chunks = [0, 1, 2, 3].map((q) => { const a = Ts[Math.floor(Ts.length * q / 4)], b = Ts[Math.floor(Ts.length * (q + 1) / 4)] ?? Infinity; return rows.filter((r) => r.T >= a && r.T < b); });
  const survivors = [];
  for (const c of cands) {
    const ok = (r) => c.conds.every((p) => test1(p, r));
    const t = stat(test, (k) => ok(test[k]));
    if (t.n < minTest || t.t < tTest || t.mean < minEx || t.raw < 0) continue;
    const q = chunks.map((ch) => { const m = ch.filter(ok); return m.length >= 30 ? +(m.reduce((a, r) => a + r.ex.r24, 0) / m.length).toFixed(4) : null; });
    if (q.filter((v) => v != null && v > 0).length < 3) continue;
    survivors.push({ id: c.conds.map((p) => `${p.f}${p.op === '>=' ? 'ge' : 'le'}${fmt(p.v)}`).join('_'), conds: c.conds.map((p) => ({ f: p.f, op: p.op, v: +p.v.toFixed(4) })), label: describe(c.conds), horizonHours: 24,
      train: { n: c.train.n, excess: +c.train.mean.toFixed(4), t: +c.train.t.toFixed(2) }, test: { n: t.n, excess: +t.mean.toFixed(4), t: +t.t.toFixed(2), rawNet: +t.raw.toFixed(4) }, quarters: q });
  }
  survivors.sort((a, b) => b.test.t - a.test.t);
  return { rules: survivors.slice(0, maxRules), tested, candidatesPassingTrain: cands.length, trainRows: train.length, testRows: test.length, thresholds: { minTrain, minTest, tTrain, tTest, minEx } };
}
