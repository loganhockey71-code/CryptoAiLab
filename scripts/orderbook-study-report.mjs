// Analyse study-data/orderbook-study.jsonl (written by scripts/orderbook-study.mjs). Read-only. Works on a partial file, so it can be run while the study is still going.
// Usage: node scripts/orderbook-study-report.mjs [--file path]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'study-data', 'orderbook-study.jsonl');
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const by = (k) => rows.filter((r) => r.k === k);
const trades = by('trade'), samples = by('sample'), holds = by('hold');
const q = (a, p) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
const f = (x, d = 3) => (x == null ? '-' : x.toFixed(d));
const mid = (r) => (r.bid + r.ask) / 2;
const minDepth = (r) => Math.min(r.depth?.b1 ?? 0, r.depth?.a1 ?? 0);

const first = rows.find((r) => r.k === 'start'), lastAt = Math.max(...rows.map((r) => r.at ?? 0));
console.log(`Study: ${first ? first.coins.length : '?'} coins, ${((lastAt - (first?.at ?? lastAt)) / 3600_000).toFixed(1)}h of data, ${samples.length} samples, ${trades.length} trades after a >=30s gap, ${by('reconnect').length} reconnects\n`);

// 1) How stale does the last trade price get vs the live book?
console.log('A) Last-trade price vs live mid, by how old the last trade is (samples):');
const ageBuckets = [[0, 30], [30, 60], [60, 120], [120, 300], [300, 1e9]];
console.table(ageBuckets.map(([lo, hi]) => {
  const s = samples.filter((r) => r.tradeAgeS != null && r.tradeAgeS >= lo && r.tradeAgeS < hi && r.lastPx);
  const div = s.map((r) => Math.abs(r.lastPx / mid(r) - 1) * 100);
  return { tradeAge: hi > 1e8 ? `${lo}s+` : `${lo}-${hi}s`, n: s.length, 'divergence med %': f(q(div, 0.5)), 'p90 %': f(q(div, 0.9)), 'max %': f(Math.max(...div, 0)), 'spread med %': f(q(s.map((r) => r.spreadPct), 0.5)), 'best quote unchanged p90 s': f(q(s.map((r) => r.unchangedS), 0.9), 1), 'feed lag p90 s': f(q(s.map((r) => r.feedLagS), 0.9), 1) };
}));

// 2) The accuracy test: next real trade after a quiet gap vs the book quote just before it, and vs the stale last price
console.log('B) Trades after a >=30s gap: how well does the pre-trade book predict the fill? (error vs the trade price)');
const spreadOf = (r) => ((r.ask - r.bid) / mid(r)) * 100;
const spreadBuckets = [['<=0.15%', (r) => spreadOf(r) <= 0.15], ['0.15-0.3%', (r) => spreadOf(r) > 0.15 && spreadOf(r) <= 0.3], ['0.3-0.5%', (r) => spreadOf(r) > 0.3 && spreadOf(r) <= 0.5], ['>0.5%', (r) => spreadOf(r) > 0.5], ['ALL', () => true]];
console.table(spreadBuckets.map(([name, fn]) => {
  const s = trades.filter((r) => r.bid && r.ask && fn(r));
  const mErr = s.map((r) => Math.abs(r.px / mid(r) - 1) * 100), sErr = s.map((r) => Math.abs(r.px / r.prevPx - 1) * 100);
  const buys = s.filter((r) => r.side === 'buy'), buyOverAsk = buys.map((r) => (r.px / r.ask - 1) * 100);
  return { spread: name, n: s.length, 'inside quote %': s.length ? Math.round(s.filter((r) => r.px >= r.bid * 0.9999 && r.px <= r.ask * 1.0001).length / s.length * 100) : '-', 'mid err med %': f(q(mErr, 0.5)), 'mid err p90 %': f(q(mErr, 0.9)), 'mid err max %': f(Math.max(...mErr, 0)), 'stale-px err med %': f(q(sErr, 0.5)), 'stale-px err p90 %': f(q(sErr, 0.9)), 'buy fill vs ask p90 %': f(q(buyOverAsk, 0.9)), 'buy fill vs ask max %': f(Math.max(...buyOverAsk, 0)) };
}));
console.log('Ask-side check for a BUY (what a paper entry would pay): fills above the pre-trade best ask by more than 0.1% / 0.25% / 0.5%:',
  [0.1, 0.25, 0.5].map((x) => { const b = trades.filter((r) => r.side === 'buy' && r.ask); return `${b.filter((r) => (r.px / r.ask - 1) * 100 > x).length}/${b.length}`; }).join(', '), '\n');

// 3) Does the quote hold? (flicker / stub-order check)
console.log('C) Quote stability 10s later, for coins whose last trade was already >=30s old:');
const moves = holds.map((h) => Math.abs((h.bid + h.ask) / 2 / mid(h.base) - 1) * 100), widen = holds.map((h) => ((h.ask - h.bid) / h.ask) / ((h.base.ask - h.base.bid) / h.base.ask));
console.log(`  n=${holds.length}; mid moved med ${f(q(moves, 0.5))}% p90 ${f(q(moves, 0.9))}% p99 ${f(q(moves, 0.99))}% max ${f(Math.max(...moves, 0))}%; spread changed >2x in ${holds.filter((h, i) => widen[i] > 2 || widen[i] < 0.5).length}/${holds.length}\n`);

// 4) What a gate would rescue: stale samples (last trade older than 30s) that would pass the proposed book rules
console.log('D) Of samples where the last trade was >=30s old (today these are skipped as "stale"), how many have a trustworthy book?');
const stale = samples.filter((r) => r.tradeAgeS != null && r.tradeAgeS >= 30);
const gates = [['spread<=0.3%, depth(1%)>=$5k each side, feed live (<5s)', (r) => r.spreadPct <= 0.3 && minDepth(r) >= 5000 && r.feedLagS <= 5], ['spread<=0.2%, depth(1%)>=$10k each side, feed live (<5s)', (r) => r.spreadPct <= 0.2 && minDepth(r) >= 10000 && r.feedLagS <= 5], ['spread<=0.3% only', (r) => r.spreadPct <= 0.3]];
console.table(gates.map(([name, fn]) => ({ gate: name, 'stale samples': stale.length, 'pass gate': stale.filter(fn).length, 'pass %': stale.length ? Math.round(stale.filter(fn).length / stale.length * 100) : '-' })));
const gateFn = gates[0][1];
const passed = trades.filter((r) => r.bid && r.ask && r.quoteT != null && spreadOf(r) <= 0.3 && Math.min(r.depth?.b1 ?? 0, r.depth?.a1 ?? 0) >= 5000);
const pErr = passed.map((r) => Math.abs(r.px / mid(r) - 1) * 100), pAsk = passed.filter((r) => r.side === 'buy').map((r) => (r.px / r.ask - 1) * 100);
console.log(`Trades that passed gate 1 (spread<=0.3%, depth>=$5k): n=${passed.length}; mid error med ${f(q(pErr, 0.5))}% p90 ${f(q(pErr, 0.9))}% p99 ${f(q(pErr, 0.99))}% max ${f(Math.max(...pErr, 0))}%; buy fill above ask p99 ${f(q(pAsk, 0.99))}% max ${f(Math.max(...pAsk, 0))}%`);
console.log('Entry-drift limit is 0.5%: trades whose fill differed from the pre-trade mid by more than that:', `${trades.filter((r) => r.bid && Math.abs(r.px / mid(r) - 1) * 100 > 0.5).length} of ${trades.length} (all spreads), ${pErr.filter((x) => x > 0.5).length} of ${passed.length} (gate 1)\n`);

// 5) Worst cases
console.log('Worst mid errors that PASSED gate 1 (these are the dangerous ones):');
console.table(passed.sort((a, b) => Math.abs(b.px / mid(b) - 1) - Math.abs(a.px / mid(a) - 1)).slice(0, 8).map((r) => ({ coin: r.p, gapS: r.gapS, spread: f(spreadOf(r)) + '%', midErr: f(Math.abs(r.px / mid(r) - 1) * 100) + '%', side: r.side, depth1: Math.min(r.depth.b1, r.depth.a1), at: new Date(r.at).toISOString().slice(0, 16) })));
if (trades.length < 300) console.log(`\nNOTE: only ${trades.length} post-gap trades so far. Tail percentiles (p99, max) need several hundred before they mean anything.`);
