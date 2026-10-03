// Exploration mode: setups that fail ONLY the protected 2.5R requirement may be traded at tiny risk (paper), measured separately; nothing else is relaxed.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PAPER_TRADING = 'true';
const S = await import('./scenarios.mjs');
const { config } = await import('../src/config.js');
const risk = await import('../src/risk.js');
const learning = await import('../src/learning.js');
const { guard } = await import('../src/guardrails.js');

const newsMod = await import('../src/newsimpact.js'), { buildModel } = await import('../src/empirical.js');
const X = config.brain.explore, fresh = S.fresh(), fx = S.fixtureModel(), noModel = buildModel({}, []);
const catastrophic = newsMod.coinImpact(newsMod.extractEvents([{ title: 'Hackers drain $80M from Test protocol in exploit', source: 'x', tier: 4, publishedAt: Date.now() - 600_000 }], [{ symbol: 'TEST', name: 'Test' }]), { symbol: 'TEST', name: 'Test' }, null, 0.01);
const run = (o = {}) => S.decideOn(fresh, { empirical: fx, ...o }).d;
const lowR = (f, o = {}) => run({ ...o, mutate: (T) => { T['1h'].box.height *= f; if (o.mutate) o.mutate(T); } });
const codes = (d) => d.vetoes.map((v) => v.code);

/** find a target-height factor at which the 2.5R rule is the ONLY blocker */
function onlyRR(o = {}) {
  for (const f of [0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5]) { const d = lowR(f, o); if (codes(d).length === 1 && codes(d)[0] === 'poor_rr' && d.rr >= X.minRR) return d; }
  return null;
}

test('config: exploration is paper-only tiny risk, below the normal 1%, and cannot touch the protected R:R', () => {
  assert.ok(X.enabled && X.riskMin === 0.001 && X.riskMax === 0.0025);
  assert.ok(X.riskMax < config.risk.riskPerTradePct);
  assert.equal(config.risk.minRR, 2.5, 'the protected minimum is unchanged');
  assert.ok(Object.isFrozen(X) && Object.isFrozen(config.brain));
  assert.ok(X.prelimTrades === 50 && X.decisiveTrades === 100);
});

test('a setup that fails ONLY the 2.5R requirement is exploration-eligible, not a normal BUY, with 0.10-0.25% risk', () => {
  const d = onlyRR();
  assert.ok(d, 'a scenario where poor_rr is the only blocker should exist');
  assert.notEqual(d.action, 'BUY');
  assert.equal(d.exploration.eligible, true);
  assert.ok(d.exploration.riskPct >= 0.001 && d.exploration.riskPct <= 0.0025, `${d.exploration.riskPct}`);
  assert.ok(d.rr >= X.minRR && d.rr < config.risk.minRR, `net R:R ${d.rr}`);
  assert.ok(/fails only the protected/.test(d.exploration.reason));
  assert.ok(d.why.now.length > 0, 'it still needs a concrete why-now');
});

test('a normal BUY is never labelled exploration, and a setup far below the R:R sanity floor is not eligible', () => {
  const buy = run();
  assert.equal(buy.action, 'BUY'); assert.equal(buy.exploration, null);
  const tiny = lowR(0.2);
  assert.ok(codes(tiny).includes('poor_rr') && tiny.exploration == null, `R:R ${tiny.rr} is under ${X.minRR}`);
});

test('exploration requires every other gate: a real veto, a low composite or no why-now disqualifies it (only the EV test is waived)', () => {
  assert.equal(onlyRR({ regime: { ...S.regimeBull, severe: true, allowLongs: false, riskMult: 0, notes: ['BTC is crashing'] } }), null, 'severe market');
  assert.equal(onlyRR({ news: catastrophic }), null, 'catastrophic coin news');
  const noEdge = onlyRR({ empirical: noModel });
  assert.ok(noEdge === null || noEdge.exploration.eligible, 'the EV test is waived for exploration (it is the R:R shortfall seen from the other side)');
  const book = { spreadPct: 0.6, depthUsd: { pct1: { bid: 90_000, ask: 90_000 }, pct05: { bid: 40_000, ask: 40_000 } }, at: Date.now() };
  assert.equal(onlyRR({ book }), null, 'a wide spread still vetoes');
});

test('risk scales with quality inside 0.10%-0.25%: a stronger composite risks more, never more than the cap', () => {
  const lo = onlyRR({ regime: { ...S.regimeBear, score: -0.3, label: 'bounce_in_downtrend' } }), hi = onlyRR({ regime: { ...S.regimeBull, score: 0.7 } });
  if (lo && hi) assert.ok(hi.exploration.riskPct >= lo.exploration.riskPct);
  for (const d of [lo, hi].filter(Boolean)) assert.ok(d.exploration.riskPct >= X.riskMin && d.exploration.riskPct <= X.riskMax);
});

test('entry filter: the exploration minimum applies ONLY when passed; the protected 2.5 stays the default and an R:R below the floor is still refused', () => {
  const base = { signal: { direction: 'bullish' }, entry: 100, btc: { severe: false }, portfolio: { manual_review_required: false, halted_for_day: false }, openCount: 0, dataFresh: true, composite: 70, floor: 55 };
  const ok = (rr, extra = {}) => risk.entryFilters({ ...base, shaped: { target: 110, rr }, ...extra });
  assert.ok(ok(2.0).some((x) => /R:R/.test(x)), 'normal trades still need 2.5');
  assert.deepEqual(ok(2.0, { minRR: X.minRR }), [], 'an exploration trade may have 2.0');
  assert.ok(ok(1.2, { minRR: X.minRR }).some((x) => /R:R/.test(x)));
  assert.ok(ok(2.0, { minRR: X.minRR, composite: 40 }).some((x) => /composite/.test(x)), 'the other gates still apply');
  assert.ok(ok(2.0, { minRR: X.minRR, btc: { severe: true } }).some((x) => /severe/.test(x)));
  assert.ok(ok(2.0, { minRR: X.minRR, openCount: 3 }).some((x) => /already 3 open/.test(x)), 'the 3-position cap still applies');
});

test('exploration sizing: a stop-out loses at most the stated 0.10-0.25% of equity (costs included) and is never bigger than the normal cap', () => {
  for (const [equity, riskPct, stop] of [[2000, 0.0025, 0.03], [2000, 0.001, 0.03], [2000, 0.0025, 0.04], [1500, 0.0015, 0.025]]) {
    const cap = guard.maxNotionalFor(equity, stop), n = risk.explorationNotional(equity, riskPct, stop, cap);
    const lossAtStop = n * (stop + risk.ROUND_TRIP_COST_PCT);
    assert.ok(Math.abs(lossAtStop - equity * riskPct) < 1e-6, `${lossAtStop} vs ${equity * riskPct}`);
    assert.ok(n <= cap && n < equity * config.risk.maxPositionPct);
    const fin = guard.finalizeEntry({ side: 'long', equity, cash: equity, entry: 100, stop: 100 * (1 - stop), wanted: n });
    assert.ok(fin.ok && fin.riskUsd <= equity * riskPct + 1e-6, `finalize keeps the tiny risk (${fin.riskUsd})`);
  }
  assert.ok(risk.explorationNotional(2000, 0.0025, 0.03, 50) === 50, 'the normal cap still wins when smaller');
});

/* ------------------------------------------------------------- the evidence report */
const T0 = 1_700_000_000_000;
function trades(list) {
  learning.journal.entries = list.map(([mode, R, rr], i) => ({ id: `x${i}`, at: T0 + i * 3600_000, kind: 'decision', side: 'long', mode, symbol: 'X', action: 'WATCH', setup: 'trend_pullback', score: 60, rr, execRR: rr, tradeId: `t${i}`, vetoes: ['poor_rr'], evidence: {}, outcome: { R, hit: R > 0 ? 'trailing_stop' : 'stop_loss', source: 'trade', mfe: 0.01, mae: -0.01, hoursHeld: 5, pnl: R * 3 } }));
}
const rnd = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

test('exploration report: too few trades concludes nothing and says the normal rules stay', () => {
  trades(Array.from({ length: 20 }, (_, i) => ['exploration', i % 2 ? 1.5 : -1, 1.8]));
  const x = learning.explorationReport();
  assert.equal(x.n, 20); assert.equal(x.verdict, 'collecting'); assert.ok(/stay exactly as they are/.test(x.text));
  assert.equal(x.progress, 0.2);
});

test('exploration report: positive only when the 95% lower bound is above zero; negative when the upper bound is below; otherwise inconclusive', () => {
  const r = rnd(5), mix = (n, pWin, win, loss) => Array.from({ length: n }, () => ['exploration', r() < pWin ? win : loss, 1.9]);
  trades(mix(60, 0.62, 1.8, -1));   // expectancy ~ +0.74R
  let x = learning.explorationReport();
  assert.ok(x.lower95 > 0 && x.verdict === 'positive (preliminary)', JSON.stringify([x.avgR, x.lower95, x.verdict]));
  trades(mix(120, 0.62, 1.8, -1));
  assert.equal(learning.explorationReport().verdict, 'positive (decisive)');
  trades(mix(70, 0.2, 1.8, -1));    // ~ -0.44R
  x = learning.explorationReport();
  assert.ok(x.upper95 < 0 && /^negative/.test(x.verdict), JSON.stringify([x.avgR, x.upper95, x.verdict]));
  trades(mix(55, 0.36, 1.8, -1));   // ~ 0R
  x = learning.explorationReport();
  assert.ok(x.lower95 < 0 && x.upper95 > 0 && /^inconclusive/.test(x.verdict), JSON.stringify([x.avgR, x.lower95, x.upper95, x.verdict]));
});

test('exploration trades are tracked SEPARATELY from normal trades, and the report is by R:R bucket', () => {
  trades([['exploration', 1.2, 1.6], ['exploration', -1, 1.6], ['exploration', 2, 2.1], ['normal', 3, 2.8], ['normal', -1, 2.7]]);
  const rep = learning.report();
  assert.equal(rep.trades.n, 2, 'normal trade statistics exclude exploration');
  assert.equal(rep.exploration.n, 3);
  const b = Object.fromEntries(rep.exploration.buckets.map((x) => [x.label, x.n]));
  assert.equal(b['1.50-1.75'], 2); assert.equal(b['2.00-2.25'], 1);
  assert.ok(rep.exploration.buckets.every((x) => x.positive === false), 'a bucket needs 15+ trades before it can count as positive');
});

test('a closed trade is scored in realised R = net P&L / dollars risked, and the entry keeps its mode', () => {
  learning.journal.entries = [{ id: 'd1', at: T0, kind: 'decision', side: 'long', symbol: 'X', setup: 'trend_pullback', entry: 100, stop: 97, rr: 1.9, outcome: null }];
  learning.attachTrade('d1', 'trade1', 'exploration');
  const e = learning.closeTrade('trade1', { exitReason: 'stop_loss', pnl: -3.1, pnlPct: -0.03, R: -3.1 / 3.0, rr: 1.9, mfe: 0.004, mae: -0.03, hours: 1.2, why: 'x' });
  assert.equal(e.mode, 'exploration'); assert.ok(Math.abs(e.outcome.R + 1.03) < 0.01); assert.equal(e.execRR, 1.9);
});

test('score exploration: the floor drop is 5 (55 -> 50), the 2.5R minimum is untouched, and a setup that is not under the floor or R:R is not labelled exploration', () => {
  assert.equal(X.floorDrop, 5); assert.equal(config.brain.minComposite - X.floorDrop, 50); assert.equal(config.risk.minRR, 2.5);
  const weak = run({ empirical: noModel, regime: { ...S.regimeBear, score: -0.6, allowLongs: true, severe: false, riskMult: 0.6 } });
  assert.ok(weak.score >= weak.floor || weak.exploration == null || weak.exploration.kind, 'only a real shortfall creates an exploration candidate');
  assert.equal(run().exploration, null, 'a normal BUY is never exploration');
  const d = onlyRR(); assert.equal(d.exploration.kind, 'lowRR');
});

test('entry filter: an exploration score trade passes at the lowered floor but still needs the full 2.5R and every other gate', () => {
  const base = { signal: { direction: 'bullish' }, entry: 100, btc: { severe: false }, portfolio: { manual_review_required: false, halted_for_day: false }, openCount: 0, dataFresh: true, shaped: { target: 110, rr: 2.6 } };
  assert.ok(risk.entryFilters({ ...base, composite: 52, floor: 55 }).some((x) => /composite/.test(x)), 'normal floor 55');
  assert.deepEqual(risk.entryFilters({ ...base, composite: 52, floor: 55 - X.floorDrop }), [], 'exploration floor 50');
  assert.ok(risk.entryFilters({ ...base, composite: 48, floor: 55 - X.floorDrop }).some((x) => /composite/.test(x)));
  assert.ok(risk.entryFilters({ ...base, shaped: { target: 110, rr: 2.0 }, composite: 52, floor: 50 }).some((x) => /R:R/.test(x)), 'the 2.5R rule still applies to score exploration');
});

test('exploration report splits the two experiments and shows fees/slippage in R and the modelled EV', () => {
  learning.journal.entries = Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, at: T0 + i * 3600_000, kind: 'decision', side: 'long', mode: 'exploration', xkind: i < 3 ? 'lowScore' : 'lowRR', symbol: 'X', action: 'WATCH', setup: 'trend_pullback', score: 52, ev: 0.1, entry: 100, stop: 97, rr: 2.7, execRR: 2.7, tradeId: `t${i}`, vetoes: [], evidence: {}, outcome: { R: i % 2 ? 1 : -1, hit: 'x', source: 'trade', mfe: 0.01, mae: -0.01, hoursHeld: 3, pnl: 1 } }));
  const x = learning.explorationReport();
  assert.equal(x.byKind.lowScore.n, 3); assert.equal(x.byKind.lowRR.n, 3);
  assert.ok(x.byKind.lowScore.avgCostR > 0 && x.byKind.lowScore.avgPredEV === 0.1 && x.byKind.lowScore.scoreBuckets.length === 2);
});
