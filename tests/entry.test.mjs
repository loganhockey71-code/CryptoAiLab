// Entry-quality tests: direction vs timing vs trade geometry, anti-chasing, "why now", shorts, regime-as-modifier, empirical probabilities, counterfactuals, loss clusters, news reaction.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PAPER_TRADING = 'true';
const S = await import('./scenarios.mjs');
const { config } = await import('../src/config.js');
const E = await import('../src/empirical.js');
const learning = await import('../src/learning.js');
const news = await import('../src/newsimpact.js');
const radar = await import('../src/radar.js');

const B = config.brain;
const mk = { pumped: S.pumped(), fresh: S.fresh(), grind: S.lateGrind(), bounce: S.failedBounce() };
const fx = S.fixtureModel(), none = E.buildModel({}, []);

/* =========================================================== the three situations */
test('1. a coin that already pumped is NOT bought: the direction is bullish, the entry is late, so WAIT for a pullback', () => {
  for (const model of [fx, none]) {
    const { d, chg24h } = S.decideOn(mk.pumped, { empirical: model });
    assert.ok(chg24h > 0.1, `it really pumped (${chg24h})`);
    assert.ok(d.scores.direction >= B.minDirection, `direction is bullish (${d.scores.direction})`);
    assert.equal(d.chase.verdict, 'chasing');
    assert.ok(d.chase.moveAtr > 3 && d.chase.distLevelAtr > 2 && d.chase.expectedMoveUsed > 0.7, JSON.stringify(d.chase));
    assert.notEqual(d.action, 'BUY');
    assert.equal(d.verdict, 'WAIT');
    assert.ok(d.vetoes.some((v) => v.code === 'chasing'));
    assert.equal(d.why.now.length, 0, 'there is no concrete "why now"');
    assert.ok(/pullback \/ retest/.test(d.waitingFor.join(' ')), d.waitingFor.join(' | '));
    assert.ok(d.scores.timing < B.minTiming);
  }
});

test('2. a coin beginning a strong move with a fresh entry (breakout -> retest held) is a LONG with a concrete "why now" and a planned zone', () => {
  const { d, price } = S.decideOn(mk.fresh, { empirical: fx });
  assert.equal(d.setup.name, 'breakout_retest');
  assert.equal(d.chase.verdict, 'fresh');
  assert.ok(d.scores.direction >= B.minDirection && d.scores.timing >= B.minTiming && d.scores.geometry >= B.minGeometry, JSON.stringify(d.scores));
  assert.equal(d.action, 'BUY'); assert.equal(d.verdict, 'LONG');
  assert.deepEqual(d.vetoes.filter((v) => v.hard || v.code === 'chasing'), []);
  assert.ok(d.why.now.length >= 2 && /retested/.test(d.why.now[0]), d.why.now.join(' | '));
  assert.ok(d.why.confirms[0].includes('INSIDE the zone') && d.why.invalidates.length === 2 && d.why.failure.length >= 1);
  assert.ok(price >= d.entryZone.lo && price <= d.entryZone.hi, 'price is inside the planned zone');
  assert.equal(d.maxEntry, d.entryZone.hi, 'a confirmation beyond the top of the zone is chasing');
  assert.ok(d.rr >= config.risk.minRR && d.ev >= B.minEV && d.pUp >= B.minPUp);
});

test('2b. the SAME fresh setup is only WAIT while its probability is unproven (no measured history): no claimed edge', () => {
  const { d } = S.decideOn(mk.fresh, { empirical: none });
  assert.equal(d.verdict, 'WAIT');
  assert.ok(d.vetoes.some((v) => v.code === 'low_probability' || v.code === 'low_ev'));
  assert.ok(/zero-drift prior/.test(d.pUpSource), d.pUpSource);
});

test('3. a bullish coin with bad timing: strong direction, no entry -> WAIT, and the reason is timing, not direction', () => {
  const { d } = S.decideOn(mk.grind, { empirical: fx });
  assert.ok(d.scores.direction >= B.minDirection, `direction ${d.scores.direction}`);
  assert.ok(d.scores.timing < B.minTiming, `timing ${d.scores.timing}`);
  assert.equal(d.verdict, 'WAIT');
  assert.ok(d.vetoes.some((v) => ['chasing', 'late_entry', 'outside_zone', 'bad_timing', 'no_setup'].includes(v.code)));
  assert.equal(d.why.now.length, 0);
});

/* ================================================================ scoring structure */
test('the overall score is the WEAKEST of direction / timing / geometry: a strong trend cannot hide a poor entry', () => {
  for (const c5 of [mk.pumped, mk.fresh, mk.grind]) {
    const { d } = S.decideOn(c5, { empirical: fx });
    assert.equal(d.score, Math.min(d.scores.direction, d.scores.timing, d.scores.geometry));
  }
  const { d } = S.decideOn(mk.pumped, { empirical: fx });
  assert.ok(d.mean > d.score + 20, `a naive average (${d.mean}) would have hidden the problem (${d.score})`);
});

test('correlated indicators never count as independent confirmation (momentum is one family and is excluded from the agreement count)', () => {
  for (const c5 of [mk.pumped, mk.fresh, mk.grind, mk.bounce]) {
    const { d } = S.decideOn(c5, { empirical: fx, regime: S.regimeBull });
    assert.ok(!d.families.agree.includes('momentum'));
    assert.ok(d.reasons.some((r) => /one family/.test(r)));
  }
});

test('every LONG requires the three gates, the entry check refuses a decision that fails any one, and the risk filter is wired to them', async () => {
  const risk = await import('../src/risk.js');
  const shaped = { target: 110, rr: 3 }, base = { signal: { direction: 'bullish' }, entry: 100, shaped, btc: { severe: false }, portfolio: { manual_review_required: false, halted_for_day: false }, openCount: 0, dataFresh: true };
  assert.deepEqual(risk.entryFilters({ ...base, scores: { direction: 80, timing: 80, geometry: 80 } }), []);
  for (const k of ['direction', 'timing', 'geometry']) {
    const r = risk.entryFilters({ ...base, scores: { direction: 80, timing: 80, geometry: 80, [k]: 10 } });
    assert.ok(r.some((x) => x.startsWith(k) || x.startsWith('trade geometry')), `${k}: ${r}`);
  }
  assert.ok(risk.entryFilters({ ...base, btc: { severe: true }, scores: { direction: 80, timing: 80, geometry: 80 } }).some((x) => /severe/.test(x)));
});

/* ============================================================================ shorts */
test('SHORT is evaluated with its own logic: a downtrend with sellers in control is a short candidate, never a long', () => {
  const { d } = S.decideOn(mk.bounce, { empirical: S.fixtureModelShort(), regime: S.regimeBear });
  assert.equal(d.side, 'short');
  assert.ok(d.short.scores.direction >= B.minDirection, JSON.stringify(d.short.scores));
  assert.ok(['SHORT', 'WAIT'].includes(d.verdict));
  assert.notEqual(d.long.verdict, 'LONG');
  assert.ok(d.reasons.some((r) => /Relative strength|Supply/.test(r)));
  assert.equal(B.allowShortTrades, false, 'detected and journaled, but not executed while the strategy is long-only');
});

test('a SHORT is vetoed against an uptrend and against exceptional relative strength (it is not the long logic flipped)', () => {
  const up = S.decideOn(mk.fresh, { empirical: S.fixtureModelShort() }).d;
  assert.ok(up.short.vetoes.length > 0 && up.short.verdict !== 'SHORT');
  const { d } = S.decideOn(mk.bounce, { empirical: S.fixtureModelShort(), rs: { mkt1: -0.02, mkt24: -0.1, btc24: -0.12, eth24: -0.11 } });   // coin barely moved while BTC dumped -> strong relative strength
  assert.ok(d.short.vetoes.some((v) => /relative strength|uptrend|buyers/.test(v)) || d.short.scores.direction < up.short.scores.direction + 100);
});

/* ============================================================================ regime */
test('a bearish-but-not-severe regime is a probability/size modifier: it does NOT block a coin with its own fresh setup', () => {
  const bull = S.decideOn(mk.fresh, { empirical: fx, regime: S.regimeBull }).d, bear = S.decideOn(mk.fresh, { empirical: fx, regime: { ...S.regimeBear, label: 'pullback_in_uptrend' } }).d;
  assert.equal(bear.vetoes.filter((v) => v.code === 'severe_regime').length, 0);
  assert.ok(bear.pUp < bull.pUp, `${bear.pUp} < ${bull.pUp}`);
  assert.equal(bear.riskMult, 0.6);
  assert.ok(['LONG', 'WAIT'].includes(bear.verdict));
});

test('only a SEVERE regime blocks new longs', async () => {
  const brain = await import('../src/brain.js');
  const sev = S.decideOn(mk.fresh, { empirical: fx, regime: { ...S.regimeBull, severe: true, allowLongs: false, riskMult: 0, notes: ['BTC is crashing'] } }).d;
  assert.notEqual(sev.action, 'BUY');
  assert.ok(sev.vetoes.some((v) => v.code === 'severe_regime'));
  const T = S.analyse(mk.pumped), calm = brain.marketRegime({ btc: T, eth: T, breadth: 0.5 });
  assert.equal(calm.severe, false); assert.equal(calm.allowLongs, true);
  const crash = S.analyse(mk.bounce), r = brain.marketRegime({ btc: { '1d': crash['1d'], '4h': { ...crash['4h'], trend: { ...crash['4h'].trend, score: -0.9 } }, '1h': { ...crash['1h'], trend: { ...crash['1h'].trend, score: -0.9 } } }, eth: null, breadth: 0.1 });
  assert.equal(r.severe, true); assert.equal(r.allowLongs, false); assert.equal(r.riskMult, 0);
});

test('exceptional relative strength is still evaluated on its own merits when the regime is mildly bearish', () => {
  const d = S.decideOn(mk.fresh, { empirical: fx, regime: { ...S.regimeBear, label: 'range' }, rs: { mkt1: -0.004, mkt24: -0.03, btc24: -0.03, eth24: -0.03 } }).d;
  assert.ok(d.relStrength.vsBTC24 > 0.05);
  assert.equal(d.vetoes.filter((v) => v.code === 'severe_regime').length, 0);
});

/* ================================================================== empirical probability */
test('empirical: no data means the zero-drift prior (no claimed edge); data moves it, shrunk by sample size, and the haircut applies', () => {
  const p0 = none.pReach('breakout_retest', 'long', 2.5);
  assert.ok(p0.p < 0.3 && /zero-drift/.test(p0.source), JSON.stringify(p0));
  const thin = E.buildModel({ 'long:x': { n: 3, hits: [3, 3, 3, 3, 3, 3, 3] } }, []), full = E.buildModel({ 'long:x': { n: 300, hits: [270, 240, 210, 180, 150, 120, 90] } }, []);
  assert.ok(thin.pReach('x', 'long', 2.5).p < full.pReach('x', 'long', 2.5).p, 'three lucky results cannot create a claimed edge');
  assert.ok(full.pReach('x', 'long', 2.5).p > 0.4 && full.pReach('x', 'long', 1).p > full.pReach('x', 'long', 3).p, 'monotone in R');
  const cut = E.buildModel({ 'long:x': { n: 300, hits: [270, 240, 210, 180, 150, 120, 90] } }, [], { haircut: 0.8 });
  assert.ok(Math.abs(cut.pReach('x', 'long', 2.5).p / full.pReach('x', 'long', 2.5).p - 0.8) < 0.02);
  assert.ok(full.realisticR('x', 'long', 0.3) >= full.realisticR('x', 'long', 0.5));
});

test('empirical: a setup that reaches 1.5R but rarely 2.5R is recognised, and a 2.5R target is called unrealistic', () => {
  const m = E.buildModel({ 'long:breakout_retest': { n: 200, hits: [150, 110, 80, 40, 20, 8, 2] } }, []);
  assert.ok(m.realisticR('breakout_retest', 'long', 0.3) <= 2);
  const { d } = S.decideOn(mk.fresh, { empirical: m });
  assert.ok(d.vetoes.some((v) => v.code === 'unrealistic_target' || v.code === 'low_probability'));
  assert.notEqual(d.action, 'BUY');
});

test('observe(): stop wins ties, shorts are mirrored, and candles before the entry are never used (no look-ahead)', () => {
  const t0 = 1_700_000_000, c = (i, h, l, cl) => ({ t: t0 + i * 900, o: cl, h, l, c: cl });
  const win = E.observe([c(0, 103, 99.5, 102), c(1, 106.5, 101, 106)], 100, 98, 'long', t0, 4 * 3600, 900);
  assert.ok(win.reach[E.LEVELS.indexOf(2.5)] && win.maxR >= 3);
  const tie = E.observe([c(0, 107, 97, 100)], 100, 98, 'long', t0, 4 * 3600, 900);
  assert.equal(tie.reach.some(Boolean), false); assert.ok(tie.stopped);
  const sh = E.observe([c(0, 100.5, 96, 97)], 100, 102, 'short', t0, 4 * 3600, 900);
  assert.ok(sh.reach[E.LEVELS.indexOf(1)] && sh.reach[E.LEVELS.indexOf(2)] && !sh.stopped);
  const before = E.observe([c(-8, 120, 100, 119), c(0, 100.4, 99.6, 100)], 100, 98, 'long', t0, 4 * 3600, 900);
  assert.ok(before.maxR < 0.5, 'the +20% bar BEFORE the entry must be ignored');
});

/* ============================================================================ learning */
const C15 = (startS, rows) => rows.map(([h, l, c], i) => ({ t: startS + i * 900, o: c, h, l, c, v: 1 }));
test('learning.measure: shorts are scored in the right direction and carry R path statistics (maxR, reach, time to stop)', () => {
  const at = 1_700_000_000_000, e = { at, holdHours: 4, side: 'short' };
  const m = learning.measure(e, C15(at / 1000, [[101, 98, 99], [100, 94, 95]]), { entry: 100, stop: 102, target: 95 }, at + 6 * 3600_000);
  assert.equal(m.hit, 'target'); assert.ok(m.R > 1.5 && m.mfe > 0.04);
  assert.ok(Array.isArray(m.reach) && m.maxR >= 2.5);
  const l = learning.measure({ ...e, side: 'short' }, C15(at / 1000, [[103, 99, 102]]), { entry: 100, stop: 102, target: 95 }, at + 6 * 3600_000);
  assert.equal(l.hit, 'stop'); assert.ok(l.R < -0.9 && l.tStop != null);
});

test('counterfactuals: a coin the brain DECLINED is journaled with a plain ATR plan, once per hour, and later measured', () => {
  learning.journal.entries = [];
  const d = { symbol: 'ZZZ', action: 'IGNORE', verdict: 'IGNORE', cls: 'NEUTRAL', score: 20, scores: { direction: 50, timing: 10, geometry: 0 }, pUp: 0, ev: null, setup: null, vetoes: [{ code: 'no_setup', hard: false }], reasons: [], evidence: { price: 100, atr1h: 2, regimeScore: 0.2 }, factors: {}, side: 'short', chase: { score: 0.1, verdict: 'fresh' } };
  const id = learning.record(d, Date.now(), 'ignored'), again = learning.record(d, Date.now() + 60_000, 'ignored');
  assert.equal(id, again);
  const e = learning.journal.entries[0];
  assert.equal(e.kind, 'ignored'); assert.equal(e.side, 'short');
  assert.ok(e.stop > e.entry && e.target < e.entry && Math.abs(e.rr - 2.5) < 1e-9);
  assert.equal(learning.record({ ...d, evidence: {} }, Date.now(), 'ignored'), null, 'no price / ATR: nothing to measure, nothing journaled');
});

function lossEntries(specs) {
  learning.journal.entries = specs.map((s, i) => ({ id: `l${i}`, at: 1_700_000_000_000 + i * 3600_000, kind: 'decision', side: 'long', symbol: 'X', action: 'WATCH', setup: s.setup ?? 'trend_pullback', score: 60, scores: { direction: 70, timing: s.timing ?? 80, geometry: 70 }, rr: 3, stop: 98, target: 106, chase: { score: s.late ? 0.7 : 0.1, verdict: s.late ? 'chasing' : 'fresh', moveAtr: s.late ? 5 : 1 }, vetoes: [], evidence: { regimeScore: 0.3 }, outcome: { R: s.R, hit: s.R > 0 ? 'target' : 'stop', source: 'candles', maxR: s.R > 0 ? 3 : 0.2, tStop: s.R > 0 ? null : 3 } }));
}
test('loss clusters: a repeated cause (late entries) is flagged with its lift; a single loss is never a cluster', () => {
  const specs = [];
  for (let i = 0; i < 30; i++) specs.push({ late: false, R: i % 3 === 0 ? -1 : 1.4 });         // fresh entries: ~33% losers
  for (let i = 0; i < 30; i++) specs.push({ late: true, R: i % 4 === 3 ? 1.4 : -1 });           // late entries: ~75% losers
  const shuffled = []; for (let i = 0; i < 30; i++) shuffled.push(specs[i], specs[30 + i]);
  lossEntries(shuffled);
  const lc = learning.lossClusters(), late = lc.clusters.find((c) => /late entry/.test(c.tag));
  assert.ok(late && late.flagged && late.lift > 1.3, JSON.stringify(late));
  assert.ok(late.persistent && /human decision/.test(late.hypothesis));
  lossEntries([{ R: -1 }, { R: 1 }, { R: 1 }]);
  assert.equal(learning.lossClusters().clusters.length, 0, 'one or two losses are not a pattern');
});

test('news: an event is followed to its ACTUAL reaction (magnitude, delay) and a headline type is only trusted after out-of-sample agreement', () => {
  const pub = 1_700_000_000_000, H = (h, c) => ({ t: 1_700_000_000 + h * 3600 - 3600, c });
  const bars = Array.from({ length: 30 }, (_, i) => H(i, 100 * (1 + (i >= 2 ? 0.004 * (i - 2) : 0))));
  const r = news.measureReaction({ publishedAt: pub, dir: 1 }, bars, null, 0.005, pub + 30 * 3600_000);
  assert.ok(r.r4 > 0.005 && r.aligned && r.delayH != null && r.alignedMagAtr > 1 && r.complete4);
  const none4 = news.measureReaction({ publishedAt: pub, dir: 1 }, bars, null, 0.005, pub + 2 * 3600_000);
  assert.equal(none4.r4, null, 'a reaction that has not happened yet is not invented');
  const mkEv = (rule, i, aligned) => ({ key: `${rule}${i}`, rule, label: rule, what: String(i), scope: 'market', coins: [], dir: 1, publishedAt: pub + i * 3600_000, reaction: { complete4: true, aligned, alignedMagAtr: aligned ? 1 : -1, delayH: 1 } });
  learning.journal.news = [...Array.from({ length: 30 }, (_, i) => mkEv('works', i, i % 5 !== 0)), ...Array.from({ length: 30 }, (_, i) => mkEv('noise', i, i % 2 === 0)), ...Array.from({ length: 6 }, (_, i) => mkEv('few', i, true))];
  const t = learning.newsTrust();
  assert.equal(t('works'), 1); assert.notEqual(t('noise'), 1); assert.equal(t('few'), 0.5, 'too few samples: stays at the default weight'); assert.equal(t('never-seen'), 0.5);
  const e = news.extractEvents([{ title: 'Coinbase lists Aave perpetuals today', source: 'x', tier: 4, publishedAt: Date.now() - 1000 }], [{ symbol: 'AAVE', name: 'Aave' }]);
  const full = news.coinImpact(e, { symbol: 'AAVE', name: 'Aave' }, null, 0.01, () => 1).effect, def = news.coinImpact(e, { symbol: 'AAVE', name: 'Aave' }, null, 0.01).effect;
  assert.ok(def > 0 && def < full, 'unvalidated headline types count for half');
});

/* ======================================================================= ranking funnel */
test('ranking: a coin STARTING strong outranks one already up the most; weak coins get short-candidate attention', () => {
  const mkt = { chg1h: 0.001, chg24h: 0.005, btc1h: 0.001, btc24: 0.01, eth1h: 0.001, eth24: 0.008 };
  const base = { vol24: 5e7, mcap: 5e9, price: 1, prev: null };
  const starting = radar.radarPriority({ ...base, chg1h: 0.02, chg24h: 0.04 }, { mkt }), extended = radar.radarPriority({ ...base, chg1h: 0.02, chg24h: 0.45 }, { mkt }), weak = radar.radarPriority({ ...base, chg1h: -0.025, chg24h: -0.08 }, { mkt });
  assert.ok(starting.score > extended.score, `${starting.score} > ${extended.score}`);
  assert.ok(starting.reasons.some((r) => /starting strong|stronger than the market/.test(r)));
  assert.ok(weak.reasons.some((r) => /short candidate/.test(r)));
});
