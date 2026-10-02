// EMPIRICAL probabilities: P(price reaches +R before the stop) per setup and direction, measured from history instead of assumed.
// One observation = one hypothetical trade (entry, stop = 1R, direction) walked forward on completed candles; we record how far it ran in R before the stop was hit, and when.
// Pure functions + a small file of historical observations written by scripts/backtest-brain.mjs. No look-ahead: an observation only uses candles AFTER its entry, and
// the walk-forward split (fit on the earlier part, score on the later part) is reported by the backtest and by learning.report().
//
// The prior is the zero-drift gambler's ruin P(+R before -1R) = 1/(1+R) minus a cost drag, i.e. "no edge". Data has to earn any deviation from it, with shrinkage (k pseudo-observations),
// so a handful of lucky results cannot create a claimed edge.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const LEVELS = [0.5, 1, 1.5, 2, 2.5, 3, 4];
const FILE = path.join(config.root, 'logs', 'calibration.json');
const COST = 2 * (config.risk.feePct + config.risk.slippagePct);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Zero-drift prior for reaching +R before -1R, reduced by the round-trip cost expressed in R (cost / stop distance is unknown here, so a flat 3% stop is assumed). */
export const priorReach = (R) => clamp(1 / (1 + R) - COST / 0.03 * 0.15, 0.02, 0.95);

/**
 * Walk one hypothetical trade forward. candles: completed bars { t (s), h, l, c }. dir 'long' | 'short'. Stop wins ties inside one bar (conservative).
 * Returns { reach: bool[] per LEVELS, tReach: hours|null per level, maxR, mfeR, maeR, tStop, bars } or null when no bars follow the entry.
 */
export function observe(candles, entry, stop, dir, startS, horizonS, barS = 900) {
  const risk = dir === 'short' ? stop - entry : entry - stop;
  if (!(risk > 0)) return null;
  const reach = LEVELS.map(() => false), tReach = LEVELS.map(() => null);
  let maxR = 0, maeR = 0, tStop = null, bars = 0, stopped = false;
  for (const c of candles) {
    if (c.t + barS <= startS) continue;
    if (c.t > startS + horizonS) break;
    bars++;
    const fav = (dir === 'short' ? entry - c.l : c.h - entry) / risk, adv = (dir === 'short' ? c.h - entry : entry - c.l) / risk;
    if (adv >= 1 && !stopped) { stopped = true; tStop = (c.t - startS) / 3600; break; }       // stop first: nothing in this bar counts as reached
    maeR = Math.max(maeR, adv);
    if (fav > maxR) { maxR = fav; LEVELS.forEach((L, i) => { if (!reach[i] && fav >= L) { reach[i] = true; tReach[i] = +((c.t - startS) / 3600).toFixed(2); } }); }
  }
  if (!bars) return null;
  return { reach, tReach, maxR: +maxR.toFixed(2), mfeR: +maxR.toFixed(2), maeR: +Math.min(maeR, 1.5).toFixed(2), tStop: tStop != null ? +tStop.toFixed(2) : null, stopped, bars };
}

/** Counts per level for a list of observations. */
export function tally(obs) {
  const hits = LEVELS.map(() => 0);
  for (const o of obs) o.reach.forEach((r, i) => { if (r) hits[i]++; });
  return { n: obs.length, hits };
}

/** Linear interpolation of a per-level probability array at an arbitrary R (monotone non-increasing is enforced). */
function atR(ps, R) {
  const m = []; ps.forEach((p, i) => m.push(i && p > m[i - 1] ? m[i - 1] : p));       // P(reach 2R) can never exceed P(reach 1R)
  if (R <= LEVELS[0]) return m[0] + (1 - m[0]) * ((LEVELS[0] - R) / LEVELS[0]) * 0.5;
  for (let i = 1; i < LEVELS.length; i++) if (R <= LEVELS[i]) { const f = (R - LEVELS[i - 1]) / (LEVELS[i] - LEVELS[i - 1]); return m[i - 1] + (m[i] - m[i - 1]) * f; }
  return m[m.length - 1] * Math.pow(0.7, R - LEVELS[LEVELS.length - 1]);
}

let hist = null;
export function loadHistorical() {
  try { hist = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { hist = null; }
  return hist;
}
export const historicalMeta = () => (hist ? { builtAt: hist.builtAt, rows: hist.rows, days: hist.days, walkForward: hist.walkForward ?? null, keys: Object.keys(hist.tables ?? {}).length } : null);
export function saveHistorical(obj) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj)); hist = obj; }

/** Build a model from raw tables: { 'dir:setup': { n, hits[] } } (historical file) plus live observations [{ dir, setup, reach[] }]. */
export function buildModel(tables = hist?.tables ?? {}, live = [], opts = {}) {
  // Out-of-sample haircut: on the unseen test part of the walk-forward the fitted model over-predicted (regimes change). Published probabilities are scaled by actual / predicted measured there.
  const haircut = opts.haircut ?? (tables === hist?.tables ? hist?.walkForward?.haircut : null) ?? 1;
  const T = new Map(Object.entries(tables).map(([k, v]) => [k, { n: v.n, hits: [...v.hits] }]));
  for (const o of live) {
    const k = `${o.dir}:${o.setup}`, t = T.get(k) ?? T.set(k, { n: 0, hits: LEVELS.map(() => 0) }).get(k);
    t.n++; o.reach.forEach((r, i) => { if (r) t.hits[i]++; });
  }
  const pooled = (dir) => { const acc = { n: 0, hits: LEVELS.map(() => 0) }; for (const [k, t] of T) if (k.startsWith(dir + ':')) { acc.n += t.n; t.hits.forEach((h, i) => { acc.hits[i] += h; }); } return acc; };
  const KP = 25, KS = 15;       // pseudo-observations pulling pooled toward the no-edge prior, and a setup toward its pooled direction
  const poolP = {};
  for (const dir of ['long', 'short']) { const p = pooled(dir); poolP[dir] = { n: p.n, ps: LEVELS.map((L, i) => (p.hits[i] + KP * priorReach(L)) / (p.n + KP)) }; }
  return {
    n: (setup, dir) => T.get(`${dir}:${setup}`)?.n ?? 0,
    /** P(reach +R before the stop) for this setup and direction, with its effective sample size. */
    pReach(setup, dir, R) {
      const t = T.get(`${dir}:${setup}`), base = poolP[dir];
      const ps = LEVELS.map((L, i) => ((t?.hits[i] ?? 0) + KS * base.ps[i]) / ((t?.n ?? 0) + KS));
      const n = t?.n ?? 0;
      return { p: +clamp(atR(ps, R) * haircut, 0.02, 0.95).toFixed(3), haircut, n, nPooled: base.n, source: n >= 30 ? `empirical (n=${n}${haircut < 0.995 ? `, x${haircut} out-of-sample haircut` : ''})` : n > 0 ? `empirical, thin sample (n=${n}), shrunk toward all-setup history (n=${base.n})` : base.n >= 30 ? `no sample for this setup: all-setup history (n=${base.n})` : 'no measured history yet: zero-drift prior (no claimed edge)' };
    },
    /** The largest R this setup has historically reached at least `minP` of the time (the target logic must respect this). */
    realisticR(setup, dir, minP = 0.35) {
      let best = LEVELS[0];
      for (let R = 0.5; R <= 4.01; R += 0.25) if (this.pReach(setup, dir, R).p >= minP) best = R;
      return +best.toFixed(2);
    },
    pooled: poolP,
  };
}
