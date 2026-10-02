// Long-horizon factor research on 1h/4h/1d structure (no 5m/15m: Coinbase history at those timeframes is too slow to pull for many months).
// For every coin and every 2 hours it computes the structure features the Brain uses, then measures how well each ranks FORWARD excess returns (vs the same-hour average of all coins)
// at 6h / 24h / 48h, over the whole sample, per time chunk (is the sign stable?) and per BTC regime (does it only work in bull markets?).
// Usage: node scripts/research-long.mjs [days=240]       (first run downloads ~38 coins x days of 1h candles, cached in logs/backtest-cache)
import fs from 'node:fs';
import path from 'node:path';
process.env.PAPER_TRADING ??= 'true';
const { config } = await import('../src/config.js');
const { analyze } = await import('../src/structure.js');
const { aggregate } = await import('../src/indicators.js');
const DAYS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 240;
const REST = 'https://api.exchange.coinbase.com', CACHE = path.join(config.root, 'logs', 'backtest-cache');
fs.mkdirSync(CACHE, { recursive: true });
const SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'UNI', 'ATOM', 'NEAR', 'APT', 'ARB', 'OP', 'INJ', 'SUI', 'SEI', 'TIA', 'FET', 'AAVE', 'HBAR', 'ETC', 'FIL', 'ICP', 'IMX', 'PEPE', 'SHIB', 'BONK', 'WIF', 'ENA', 'JUP', 'ONDO', 'RENDER', 'TAO', 'CRV', 'MKR', 'STX'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, n = 0) { const res = await fetch(url, { headers: { 'User-Agent': 'crypto-ai-lab-research/1.0' }, signal: AbortSignal.timeout(20_000) }); if (res.status === 429 && n < 4) { await sleep(1500 * (n + 1)); return get(url, n + 1); } if (!res.ok) throw new Error(`${res.status}`); return res.json(); }
async function fetchRange(product, gran, s0, s1) {
  const out = new Map();
  for (let s = s0; s < s1; s += 300 * gran) { const e = Math.min(s + 300 * gran, s1); for (const [t, l, h, o, c, v] of await get(`${REST}/products/${product}/candles?granularity=${gran}&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`)) out.set(t, { t, o, h, l, c, v }); await sleep(170); }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
const endSec = Math.floor(Date.now() / 3600_000) * 3600, start = endSec - DAYS * 86400;
const data = {};
for (const s of SYMS) {
  const f = path.join(CACHE, `long-${s}-${DAYS}d.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 12 * 3600_000) { data[s] = JSON.parse(fs.readFileSync(f, 'utf8')); continue; }
  try { const d = { h1: await fetchRange(`${s}-USD`, 3600, start - 320 * 3600, endSec), d1: await fetchRange(`${s}-USD`, 86400, start - 330 * 86400, endSec) }; if (d.h1.length > 1000) { fs.writeFileSync(f, JSON.stringify(d)); data[s] = d; console.error('loaded', s, d.h1.length); } } catch (e) { console.error('skip', s, e.message); }
}
const syms = Object.keys(data); console.error(syms.length, 'coins');
const upto = (arr, gran, T, n = 300) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t + gran <= T) lo = m + 1; else hi = m; } return arr.slice(Math.max(0, lo - n), lo); };
const idxAt = (arr, T) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < T) lo = m + 1; else hi = m; } return lo; };
const rows = [];
for (let T = start; T <= endSec - 48 * 3600; T += 2 * 3600) {
  const grp = [];
  for (const s of syms) {
    const d = data[s], h1 = upto(d.h1, 3600, T); if (h1.length < 200) continue;
    const price = h1[h1.length - 1].c, pf = (a) => [...a, { t: 0, o: price, h: price, l: price, c: price, v: 0 }];
    const a1 = analyze(pf(h1), '1h'), a4 = analyze(pf(aggregate(h1, 4 * 3600)), '4h'), ad = analyze(pf(upto(d.d1, 86400, T)), '1d');
    if (!a1 || !a4) continue;
    const i0 = idxAt(d.h1, T), at = (h) => d.h1[Math.min(d.h1.length - 1, i0 + h - 1)]?.c;
    const f6 = at(6), f24 = at(24), f48 = at(48); if (!f48) continue;
    const ch = (n) => (h1.length > n ? price / h1[h1.length - 1 - n].c - 1 : 0);
    grp.push({ sym: s, T, fw: { r6: f6 / price - 1, r24: f24 / price - 1, r48: f48 / price - 1 },
      x: { d1: ad?.trend.score ?? 0, h4: a4.trend.score, h1: a1.trend.score, flow1: a1.flow.recent, flow4: a4.flow.recent, demandShift: a1.flow.shift === 'demand_takeover' ? 1 : a1.flow.shift === 'supply_takeover' ? -1 : 0,
        rvol1: a1.volume.rvol ?? 1, rsi1: a1.momentum.rsi ?? 50, rsi4: a4.momentum.rsi ?? 50, ext1: a1.momentum.extensionAtr, ext4: a4.momentum.extensionAtr, roc6: a1.momentum.roc6, roc24: ch(24), roc72: ch(72), roc168: ch(168),
        atrPct: a1.atrPct, candle1: a1.candles.score, candle4: a4.candles.score, bullBreak1: a1.trend.bullBreak ? 1 : 0, bearBreak1: a1.trend.bearBreak ? 1 : 0, boxPos: a1.box?.pos ?? 0.5,
        supDist: a1.levels.support ? (price - a1.levels.support.price) / a1.atr : 9, resDist: a1.levels.resistance ? (a1.levels.resistance.price - price) / a1.atr : 9, aboveE50: a1.aboveEma50 ? 1 : 0, macdUp: a1.momentum.macdRising ? 1 : 0 } });
  }
  if (grp.length < 15) continue;
  const btc = grp.find((g) => g.sym === 'BTC');
  for (const k of ['r6', 'r24', 'r48']) { const m = grp.reduce((a, r) => a + r.fw[k], 0) / grp.length; for (const r of grp) (r.ex ??= {})[k] = r.fw[k] - m; }
  const mkt = grp.reduce((a, r) => a + r.x.roc24, 0) / grp.length;
  for (const r of grp) { r.btc4 = btc?.x.h4 ?? 0; r.mkt24 = mkt; rows.push(r); }
}
fs.writeFileSync(path.join(CACHE, `long-rows-${DAYS}d.json`), JSON.stringify(rows));
console.log(`${rows.length} coin-observations over ${DAYS} days (${syms.length} coins, every 2h)`);

const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const corr = (a, b) => { const n = a.length; if (n < 30) return 0; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0; };
const ic = (set, k, tgt) => corr(rank(set.map((r) => r.x[k])), rank(set.map((r) => r.ex[tgt])));
const Ts = [...new Set(rows.map((r) => r.T))].sort((a, b) => a - b), chunkN = 4;
const chunks = Array.from({ length: chunkN }, (_, i) => rows.filter((r) => r.T >= Ts[Math.floor(Ts.length * i / chunkN)] && r.T < (Ts[Math.floor(Ts.length * (i + 1) / chunkN)] ?? Infinity)));
const bull = rows.filter((r) => r.btc4 >= 0.25), bear = rows.filter((r) => r.btc4 <= -0.25);
for (const tgt of ['r6', 'r24', 'r48']) {
  console.log(`\nIC vs forward ${tgt} excess return   (|IC| under ~0.02 is noise)  chunks = 4 consecutive quarters of the sample`);
  console.log('feature'.padEnd(13), 'all'.padStart(7), ...chunks.map((_, i) => `q${i + 1}`.padStart(7)), 'BTCup'.padStart(7), 'BTCdn'.padStart(7), ' stable');
  const out = Object.keys(rows[0].x).map((k) => ({ k, all: ic(rows, k, tgt), q: chunks.map((c) => ic(c, k, tgt)), up: ic(bull, k, tgt), dn: ic(bear, k, tgt) })).sort((a, b) => Math.abs(b.all) - Math.abs(a.all));
  for (const o of out) console.log(o.k.padEnd(13), o.all.toFixed(3).padStart(7), ...o.q.map((v) => v.toFixed(3).padStart(7)), o.up.toFixed(3).padStart(7), o.dn.toFixed(3).padStart(7), o.q.every((v) => Math.sign(v) === Math.sign(o.all) && Math.abs(v) > 0.008) ? '  YES' : '  -');
}
process.exit(0);
