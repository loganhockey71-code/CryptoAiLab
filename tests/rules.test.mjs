// The entry rules, group by group: A pre-filters, B vetoes (only genuinely dangerous conditions), C setups, D soft scoring, E probability + EV, F regime, discovery.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PAPER_TRADING = 'true';
const S = await import('./scenarios.mjs');
const { config } = await import('../src/config.js');
const E = await import('../src/empirical.js');
const radar = await import('../src/radar.js');
const news = await import('../src/newsimpact.js');
const discovery = await import('../src/discovery.js');

const B = config.brain;
const fresh = S.fresh(), grind = S.lateGrind(), bounce = S.failedBounce();
const fx = S.fixtureModel();
const codes = (d) => d.vetoes.map((v) => v.code);
const run = (c5, o = {}) => S.decideOn(c5, { empirical: fx, ...o }).d;
const coin = { price: 1, vol24: 50e6, mcap: 500e6, chg1h: 0.01, chg24h: 0.02 };

/* ================================================================== A. pre-filters */
test('A1-5: liquidity screens reject only genuinely illiquid coins; odd volume is a WARNING; a missing market cap is fine when liquidity is clear', () => {
  assert.equal(radar.rejectReason(coin), null);
  assert.equal(radar.rejectReason({ ...coin, vol24: 800_000 }).code, 'illiquid');
  assert.equal(radar.rejectReason({ ...coin, mcap: 3_000_000 }).code, 'tiny_cap');
  assert.equal(radar.rejectReason({ ...coin, price: 0 }).code, 'insufficient_data');
  assert.equal(radar.rejectReason({ ...coin, vol24: null }).code, 'insufficient_data');
  assert.equal(radar.rejectReason({ ...coin, mcap: null, vol24: 20e6 }), null, 'market cap may be missing when volume is sufficient');
  assert.equal(radar.rejectReason({ ...coin, mcap: null, vol24: 2e6 }).code, 'insufficient_data', 'but not when there is no liquidity data to compensate');
  const wash = { ...coin, mcap: 20_000_000, vol24: 90_000_000 };
  assert.equal(radar.rejectReason(wash), null, 'a high volume / market-cap ratio is flagged, not rejected');
  assert.ok(radar.screenWarnings(wash).some((w) => /wash/.test(w)));
  const spike = { ...coin, vol24: 2_000_000, mcap: 100_000_000, chg1h: 0.25 };
  assert.equal(radar.rejectReason(spike), null, 'a 20% hour on thin volume is a major warning, not an automatic veto');
  assert.ok(radar.screenWarnings(spike).some((w) => /major warning/.test(w)));
  assert.ok(radar.screenWarnings({ ...coin, mcap: null }).some((w) => /market cap unknown/.test(w)));
});

test('A: warnings cost score (they are not ignored)', () => {
  const base = run(fresh), warned = run(fresh, { warnings: ['24h volume is 5.0x market cap: possible wash trading (flagged for review, not rejected)', 'exchange price differs 8% from the reference price'] });
  assert.ok(warned.scores.direction < base.scores.direction);
  assert.equal(codes(warned).length, codes(base).length, 'but they do not block by themselves');
});

test('A8: a coin with no 4h / 5m history (a new listing) is still analysed: the nearest timeframe stands in, with a penalty saying so', async () => {
  const brain = await import('../src/brain.js');
  const T = S.analyse(fresh); delete T['4h']; delete T['5m'];
  const d = brain.decide({ symbol: 'NEW', name: 'New', ta: T, regime: S.regimeBull, news: null, market: null, book: null, chg1h: 0.01, chg24h: 0.03, rs: { mkt1: 0, mkt24: 0.01, btc24: 0.01, eth24: 0.01 }, smart: null, adj: [], empirical: fx, shape: S.shape(), selected: [] });
  assert.notEqual(d.action, 'IGNORE');
  assert.ok(d.penalties.some((p) => /4h history is not available/.test(p.text)));
  const none = brain.decide({ symbol: 'X', ta: { '1h': T['1h'] }, regime: S.regimeBull, empirical: fx, shape: S.shape() });
  assert.equal(none.vetoes[0].code, 'no_data', 'without 1h and 15m there is nothing to calculate');
});

/* ================================================================== B. vetoes */
const clone = (T) => structuredClone(T);
test('B11-12: a downtrend is normally a PENALTY; only a strong downtrend with heavy selling and no reversal evidence is a veto', () => {
  const mod = run(fresh, { mutate: (T) => { T['1h'].trend.score = -0.4; T['1h'].trend.state = 'down'; T['1h'].trend.bullBreak = false; T['1h'].trend.higherLowAfterLow = false; T['1h'].sweep.bullish = null; T['1h'].flow.shift = 'none'; T['15m'].trend.bullBreak = false; T['15m'].sweep.bullish = null; } });
  assert.ok(mod.penalties.some((p) => p.code === 'downtrend_h1'));
  assert.ok(!codes(mod).includes('downtrend_h1_extreme'));
  const extreme = run(fresh, { mutate: (T) => { Object.assign(T['1h'].trend, { score: -0.8, state: 'strong_down', bullBreak: false, higherLowAfterLow: false }); T['1h'].sweep.bullish = null; Object.assign(T['1h'].flow, { control: 'supply_control', recent: -0.4, shift: 'none' }); T['15m'].trend.bullBreak = false; T['15m'].sweep.bullish = null; } });
  assert.ok(codes(extreme).includes('downtrend_h1_extreme'));
  const withReversal = run(fresh, { mutate: (T) => { Object.assign(T['1h'].trend, { score: -0.8, state: 'strong_down', bullBreak: true }); Object.assign(T['1h'].flow, { control: 'supply_control', recent: -0.4 }); } });
  assert.ok(!codes(withReversal).includes('downtrend_h1_extreme'), 'reversal evidence turns the veto back into a penalty');
  const h4 = run(fresh, { mutate: (T) => { Object.assign(T['4h'].trend, { score: -0.8, state: 'strong_down', bullBreak: false }); T['1h'].trend.bullBreak = false; T['1h'].trend.higherLowAfterLow = false; T['1h'].sweep.bullish = null; T['1h'].flow.shift = 'none'; T['15m'].trend.bullBreak = false; T['15m'].sweep.bullish = null; } });
  assert.ok(codes(h4).includes('downtrend_h4_extreme'));
});

test('B13-15: daily downtrend is context only; sellers in control and several bearish signals lower the score, they do not veto', () => {
  const base = run(grind);
  const d = run(grind, { mutate: (T) => { T['1d'].trend.state = 'strong_down'; T['1d'].trend.score = -0.8; Object.assign(T['1h'].flow, { control: 'supply_control', recent: -0.15, shift: 'none' }); T['1h'].candles.score = -0.5; T['15m'].candles.score = -0.5; T['1h'].momentum.score = -0.5; } });
  for (const c of ['downtrend_d1', 'supply_control', 'bearish_signals']) assert.ok(d.penalties.some((p) => p.code === c), c);
  assert.ok(!codes(d).some((c) => /downtrend|supply_control|major_conflict|bearish/.test(c)));
  assert.ok(d.scores.direction < base.scores.direction);
});

test('B16-17: only coin-specific CATASTROPHIC news vetoes; normal negative news just lowers the score', () => {
  const coins = [{ symbol: 'TEST', name: 'Test' }];
  const mkNews = (title, tier = 4) => news.coinImpact(news.extractEvents([{ title, source: 'x', tier, publishedAt: Date.now() - 600_000 }], coins), coins[0], null, 0.01);
  const hack = mkNews('Hackers drain $80M from Test protocol in exploit'), mild = mkNews('Test ETF outflows continue as traders sell Test');
  assert.ok(hack.catastrophic, 'a hack is catastrophic'); assert.ok(!mild.catastrophic && mild.effect < 0);
  const dHack = run(fresh, { news: hack });
  assert.ok(codes(dHack).includes('catastrophic_news') && dHack.action !== 'BUY');
  const base = run(fresh), dMild = run(fresh, { news: mild });
  assert.ok(!codes(dMild).includes('catastrophic_news'));
  assert.ok(dMild.scores.direction < base.scores.direction, 'normal negative news reduces the score');
});

test('B20: a wide spread or an EXTREMELY thin book vetoes; an ordinary book does not', () => {
  const book = (spreadPct, depth) => ({ spreadPct, depthUsd: { pct1: { bid: depth, ask: depth }, pct05: { bid: depth, ask: depth } }, at: Date.now() });
  assert.ok(codes(run(fresh, { book: book(0.6, 500_000) })).includes('illiquid_book'));
  assert.ok(codes(run(fresh, { book: book(0.05, 4_000) })).includes('illiquid_book'));
  assert.ok(!codes(run(fresh, { book: book(0.08, 60_000) })).includes('illiquid_book'));
});

test('B21: low volatility blocks ONLY when the expected move cannot realistically cover fees, spread, stop and target', () => {
  const dead = run(fresh, { mutate: (T) => { T['1h'].atrPct = 0.0004; } });
  assert.ok(codes(dead).includes('dead_market'));
  assert.ok(!codes(run(fresh)).includes('dead_market'));
});

test('B18-19: only a severe market vetoes; a weak BTC makes the AI more selective instead', () => {
  const bull = run(fresh, { regime: S.regimeBull }), weak = run(fresh, { regime: { ...S.regimeBear, score: -0.6, label: 'bounce_in_downtrend' } });
  assert.ok(!codes(weak).includes('severe_regime'));
  assert.ok(weak.floor > bull.floor, `floor ${weak.floor} > ${bull.floor}: more selective`);
  assert.ok(weak.pUp < bull.pUp);
});

/* ================================================================== C. setups */
test('C23: the setup list includes relative strength, support bounce and trend continuation as well as the originals, and the best one is chosen', () => {
  const d = run(fresh, { rs: { mkt1: -0.004, mkt24: -0.02, btc24: -0.03, eth24: -0.03 } });
  assert.ok(d.setupsFound.includes('relative_strength'), d.setupsFound.join(','));
  assert.ok(d.setupsFound.includes('breakout_retest'));
  const names = new Set(['trend_pullback', 'breakout_retest', 'range_breakout', 'trend_reversal', 'liquidity_sweep', 'momentum_continuation', 'relative_strength', 'support_bounce', 'trend_continuation']);
  for (const c5 of [fresh, grind]) for (const n of run(c5).setupsFound) assert.ok(names.has(n) || n.startsWith('discovered:'), n);
});

test('C24: one or two disagreeing indicators do not disqualify a setup', () => {
  const d = run(fresh, { mutate: (T) => { T['1h'].momentum.rsi = 71; T['1h'].momentum.macdRising = false; T['15m'].momentum.score = -0.2; } });
  assert.equal(d.setup.name, 'breakout_retest');
  assert.equal(d.action, 'BUY');
});

test('C29: a liquidity-sweep reclaim with a buying response qualifies even in a bearish larger trend', () => {
  const d = run(fresh, { mutate: (T) => { Object.assign(T['4h'].trend, { score: -0.7, state: 'strong_down' }); Object.assign(T['1h'].trend, { score: -0.5, state: 'down' }); T['1h'].box = null; T['15m'].box = null; T['1h'].sweep.bullish = { level: T['1h'].price * 0.995, wickLow: T['1h'].price * 0.99, lowerWick: 0.7, depthAtr: 0.5 }; Object.assign(T['1h'].flow, { shift: 'demand_takeover', control: 'demand_control', recent: 0.3 }); } });
  assert.ok(d.setupsFound.includes('liquidity_sweep'), d.setupsFound.join(','));
});

test('C31: setups discovered from history are used: a matching mined rule becomes a setup', () => {
  const rule = { id: 't1', label: 'h1 >= -1', conds: [{ f: 'h1', op: '>=', v: -1 }], test: { n: 300, excess: 0.01, t: 4 } };
  const d = run(grind, { discovered: [rule] });
  assert.ok(d.setupsFound.includes('discovered:t1'), d.setupsFound.join(','));
  const none = run(grind, { discovered: [{ ...rule, id: 't2', conds: [{ f: 'h1', op: '>=', v: 5 }] }] });
  assert.ok(!none.setupsFound.includes('discovered:t2'), 'a rule whose conditions do not match is not used');
});

test('discovery: finds a planted real edge out of sample, and finds NOTHING in pure noise (a high bar by design)', () => {
  const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const make = (plant, seed) => {
    const r = rng(seed), rows = [];
    for (let t = 0; t < 420; t++) for (let c = 0; c < 20; c++) {
      const x = Object.fromEntries(discovery.FEATURES.map((f) => [f, r()]));
      const edge = plant && x.rsi1 <= 0.2 && x.flow1 >= 0.6 ? 0.02 : 0, ex = edge + (r() - 0.5) * 0.1;
      rows.push({ T: 1_700_000_000 + t * 7200, x, fw: { r24: ex + 0.004 }, ex: { r24: ex } });
    }
    return rows;
  };
  const planted = discovery.discover(make(true, 7)), noise = discovery.discover(make(false, 11));
  assert.ok(planted.rules.length >= 1, JSON.stringify({ tested: planted.tested, pass: planted.candidatesPassingTrain }));
  assert.ok(planted.rules[0].conds.some((c) => c.f === 'rsi1' || c.f === 'flow1'));
  assert.ok(planted.rules[0].test.t >= 3 && planted.rules[0].test.excess > 0.003);
  assert.equal(noise.rules.length, 0, `noise must not produce a rule (tested ${noise.tested} combinations)`);
});

/* ================================================================== D. soft scoring */
test('D33: a 15m downtrend is acceptable (a caution and a timing cost), not a veto', () => {
  const base = run(fresh);
  const d = run(fresh, { mutate: (T) => { Object.assign(T['15m'].trend, { score: -0.5, state: 'down', bullBreak: false }); T['15m'].sweep.bullish = null; T['15m'].flow.shift = 'none'; } });
  assert.ok(d.cautions.some((c) => c.code === 'm15_down'));
  assert.ok(!codes(d).includes('wait_15m_turn'));
  assert.ok(d.scores.timing < base.scores.timing);
});

test('D35 / G68: slightly outside the planned zone RECALCULATES the zone instead of abandoning the setup; far outside stays outside', () => {
  const near = run(fresh, { mutate: (T) => { const lvl = T['1h'].box.hi; T['1h'].price = lvl + 0.6 * T['1h'].atr + 0.3 * T['1h'].atr; } });
  assert.equal(near.entryZone.recalculated, true);
  assert.ok(near.cautions.some((c) => c.code === 'zone_recalculated'));
  assert.ok(near.entryZone.hi >= near.entry);
  const far = run(fresh, { mutate: (T) => { const lvl = T['1h'].box.hi; T['1h'].price = lvl + 0.6 * T['1h'].atr + 1.5 * T['1h'].atr; } });
  assert.ok(!far.entryZone.recalculated);
  assert.ok(far.cautions.some((c) => c.code === 'outside_zone'));
  assert.ok(far.scores.timing < near.scores.timing);
});

test('D34 / D36: anti-chasing is a penalty, and several weaker confirmations can replace one textbook trigger', () => {
  const d = run(S.pumped());
  assert.ok(d.cautions.some((c) => c.code === 'chasing') && !codes(d).includes('chasing'), 'reported as a caution, not a veto');
  const weak = run(fresh, { mutate: (T) => { T['1h'].box.retest = false; Object.assign(T['1h'].box, { barsSinceBreak: 8 }); T['15m'].box = null; Object.assign(T['1h'].flow, { control: 'demand_control', recent: 0.3 }); } });
  if (weak.setup && !weak.setup.name.startsWith('discovered')) assert.ok(weak.timing.trigger.length >= 1);
});

test('D41-45: the scores are inputs to a composite ranking: a setup scoring only in the 60s can still be taken when everything else is sound', () => {
  const d = run(fresh);
  assert.equal(d.action, 'BUY');
  assert.ok(d.scores.geometry < 70, `geometry ${d.scores.geometry} is not a perfect 100 and did not need to be`);
  assert.ok(d.score >= d.floor && d.score < 85);
  assert.ok(d.floor < 60, 'the bar is a floor on a blended score, not three separate cutoffs');
});

/* ================================================================== E. probability and EV */
test('E48: EV includes the spread: the same trade has a lower R:R and EV when the order book is wider', () => {
  const book = (sp) => ({ spreadPct: sp, depthUsd: { pct1: { bid: 80_000, ask: 80_000 }, pct05: { bid: 40_000, ask: 40_000 } }, at: Date.now() });
  const a = run(fresh, { book: book(0.02) }), b = run(fresh, { book: book(0.35) });
  assert.ok(b.rr < a.rr && b.ev < a.ev, `${b.rr} < ${a.rr}; ${b.ev} < ${a.ev}`);
});

test('E46-47 / E50-52: with little measured history the EV must clear a UNCERTAINTY-adjusted bar, and confidence says how much data stands behind it', () => {
  const lucky = E.buildModel({ 'long:breakout_retest': { n: 6, hits: [6, 6, 6, 6, 6, 6, 6] } }, []), solid = E.buildModel({ 'long:breakout_retest': { n: 400, hits: [340, 290, 240, 195, 160, 125, 80] } }, []);
  const thin = run(fresh, { empirical: lucky }), full = run(fresh, { empirical: solid });
  assert.ok(thin.evLB < full.evLB && thin.confidence < full.confidence, `lower bound ${thin.evLB} < ${full.evLB}; confidence ${thin.confidence} < ${full.confidence}`);
  assert.ok(codes(thin).includes('low_ev') || thin.ev > B.minEV, 'six lucky results cannot pass on their own');
  assert.equal(full.action, 'BUY');
  assert.ok(thin.cautions.some((c) => c.code === 'thin_history'));
  const none = run(fresh, { empirical: E.buildModel({}, []) });
  assert.ok(none.confidence <= 0.1 && /zero-drift/.test(none.pUpSource), 'no data: no invented confidence');
});

test('E49: the protected R:R >= 2.5 still applies (a plan below it is blocked, not scored away)', () => {
  const d = run(fresh, { mutate: (T) => { T['1h'].box.height = T['1h'].box.height * 0.2; } });
  assert.ok(codes(d).includes('poor_rr') && d.action !== 'BUY');
});

/* ================================================================== F. regime */
test('F54-57: strong BTC strength raises confidence, and exceptional relative strength relaxes the weak-BTC penalty and floor', () => {
  const bull = run(fresh, { regime: { ...S.regimeBull, score: 0.7 } }), weak = { ...S.regimeBear, score: -0.6 };
  const ordinary = run(fresh, { regime: weak, rs: { mkt1: 0.001, mkt24: 0.004, btc24: 0.04, eth24: 0.04 } }), exceptional = run(fresh, { regime: weak, rs: { mkt1: -0.01, mkt24: -0.05, btc24: -0.06, eth24: -0.06 } });
  assert.ok(bull.floor < ordinary.floor);
  assert.ok(exceptional.floor < ordinary.floor, `${exceptional.floor} < ${ordinary.floor}`);
  assert.ok(exceptional.pUp > ordinary.pUp - 0.0001);
  assert.ok(exceptional.reasons.some((r) => /exceptional/.test(r)));
});
