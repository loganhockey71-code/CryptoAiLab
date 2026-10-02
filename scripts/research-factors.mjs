// Which inputs actually predict forward returns? Reads the coin-hour rows written by backtest-brain.mjs and reports, per feature, the rank correlation (information coefficient)
// with the coin's forward return EXCESS over the same-hour average of all coins (cross-sectional: removes market beta, which is what a coin-picker must beat),
// separately on the earlier 60% of time ("train") and the later 40% ("test"). A feature is only trusted when the sign agrees on both and the test IC is not noise.
// Usage: node scripts/research-factors.mjs [days=30] [--weights]   (--weights fits ridge weights on train and scores them on test)
import fs from 'node:fs';
import path from 'node:path';
process.env.PAPER_TRADING ??= 'true';
const { config } = await import('../src/config.js');
const DAYS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 30;
const rows = JSON.parse(fs.readFileSync(path.join(config.root, 'logs', 'backtest-cache', `features-${DAYS}d.json`), 'utf8')).sort((a, b) => a.T - b.T);

// cross-sectional excess returns
const byT = new Map(); for (const r of rows) (byT.get(r.T) ?? byT.set(r.T, []).get(r.T)).push(r);
for (const g of byT.values()) for (const k of ['r2', 'r6', 'r12', 'r24']) { const m = g.reduce((a, r) => a + r.fw[k], 0) / g.length; for (const r of g) (r.ex ??= {})[k] = r.fw[k] - m; }

const Ts = [...byT.keys()].sort((a, b) => a - b), cutT = Ts[Math.floor(Ts.length * config.brain.learnTrainFrac)];
const train = rows.filter((r) => r.T < cutT), test = rows.filter((r) => r.T >= cutT);
const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const corr = (a, b) => { const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0; };
const ic = (set, get, tgt) => corr(rank(set.map(get)), rank(set.map((r) => r.ex[tgt])));
const feats = {};
for (const k of Object.keys(rows[0].f)) feats[`f.${k}`] = (r) => r.f[k];
for (const k of Object.keys(rows[0].x)) feats[`x.${k}`] = (r) => r.x[k];
feats.score = (r) => r.score; feats.regime = (r) => r.regime;
const se = (n) => 1 / Math.sqrt(n);       // rough noise level of a correlation (obs overlap in time, so real noise is larger: treat |IC| < 2x this as nothing)

console.log(`${rows.length} rows, ${Ts.length} hours, train ${train.length} / test ${test.length}.  noise level ~ +-${(2 * se(test.length / 6)).toFixed(3)} (overlapping windows: be sceptical)`);
for (const tgt of ['r6', 'r24']) {
  console.log(`\nIC vs forward ${tgt} excess return`);
  console.log('feature'.padEnd(18), 'train'.padStart(8), 'test'.padStart(8), ' agree');
  const out = Object.entries(feats).map(([k, g]) => ({ k, a: ic(train, g, tgt), b: ic(test, g, tgt) })).sort((x, y) => Math.abs(y.a) - Math.abs(x.a));
  for (const o of out) console.log(o.k.padEnd(18), o.a.toFixed(3).padStart(8), o.b.toFixed(3).padStart(8), Math.sign(o.a) === Math.sign(o.b) && Math.abs(o.b) > 0.01 ? '  yes' : '  -');
}

// does ranking by the brain's score pick winners? top vs bottom decile each hour
for (const [name, get] of [['score', (r) => r.score], ['f.trend', (r) => r.f.trend], ['x.rs', (r) => r.x.rs]]) {
  for (const [label, set] of [['train', train], ['test', test]]) {
    let top = 0, bot = 0, n = 0, topUp = 0, nUp = 0;
    const gT = new Map(); for (const r of set) (gT.get(r.T) ?? gT.set(r.T, []).get(r.T)).push(r);
    for (const g of gT.values()) { if (g.length < 12) continue; const s = g.slice().sort((a, b) => get(b) - get(a)), k = Math.max(2, Math.floor(g.length * 0.1)); top += s.slice(0, k).reduce((a, r) => a + r.ex.r24, 0) / k; bot += s.slice(-k).reduce((a, r) => a + r.ex.r24, 0) / k; n++; for (const r of s.slice(0, k)) if (r.fw.up4dn2 != null) { topUp += r.fw.up4dn2; nUp++; } }
    console.log(`rank by ${name.padEnd(8)} ${label}: top-decile excess 24h ${(top / n * 100).toFixed(2)}%  bottom ${(bot / n * 100).toFixed(2)}%  spread ${((top - bot) / n * 100).toFixed(2)}%  | top-decile hit +4% before -2%: ${(topUp / nUp * 100).toFixed(0)}% (all coins: ${(rows.filter((r) => r.fw.up4dn2 != null).reduce((a, r) => a + r.fw.up4dn2, 0) / rows.filter((r) => r.fw.up4dn2 != null).length * 100).toFixed(0)}%)`);
  }
}

if (process.argv.includes('--weights')) {
  // ridge regression of forward 12h excess return on the factor columns (z-scored on train), then out-of-sample IC of the fitted score
  const cols = Object.keys(rows[0].f), X = (r) => cols.map((k) => r.f[k]);
  const mu = cols.map((_, j) => train.reduce((a, r) => a + X(r)[j], 0) / train.length), sd = cols.map((_, j) => Math.sqrt(train.reduce((a, r) => a + (X(r)[j] - mu[j]) ** 2, 0) / train.length) || 1);
  const Z = (r) => X(r).map((v, j) => (v - mu[j]) / sd[j]);
  const p = cols.length, A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0), lambda = train.length * 0.5;
  for (const r of train) { const z = Z(r), y = r.ex.r12; for (let i = 0; i < p; i++) { b[i] += z[i] * y; for (let j = 0; j < p; j++) A[i][j] += z[i] * z[j]; } }
  for (let i = 0; i < p; i++) A[i][i] += lambda;
  // solve A w = b (Gauss)
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < p; i++) { let piv = i; for (let k = i + 1; k < p; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k; [M[i], M[piv]] = [M[piv], M[i]]; for (let k = i + 1; k < p; k++) { const f = M[k][i] / M[i][i]; for (let j = i; j <= p; j++) M[k][j] -= f * M[i][j]; } }
  const w = new Array(p).fill(0); for (let i = p - 1; i >= 0; i--) { let s = M[i][p]; for (let j = i + 1; j < p; j++) s -= M[i][j] * w[j]; w[i] = s / M[i][i]; }
  console.log('\nRidge weights fitted on train (per 1 sd of factor, forward-12h excess return):'); cols.forEach((c, j) => console.log(' ', c.padEnd(12), (w[j] * 100).toFixed(3)));
  const pred = (r) => Z(r).reduce((a, z, j) => a + z * w[j], 0);
  for (const [label, set] of [['train', train], ['test', test]]) console.log(`fitted score IC (${label}) vs 12h excess: ${corr(rank(set.map(pred)), rank(set.map((r) => r.ex.r12))).toFixed(3)}   vs 24h: ${corr(rank(set.map(pred)), rank(set.map((r) => r.ex.r24))).toFixed(3)}`);
  console.log('current hand-set score IC (test) vs 12h:', ic(test, (r) => r.score, 'r12').toFixed(3));
}
process.exit(0);
