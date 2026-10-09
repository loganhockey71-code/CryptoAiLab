// Pure helpers behind the dashboard's Categories, Alerts, AI Leaderboard and Hot pages: no I/O, no randomness.
import test from 'node:test';
import assert from 'node:assert/strict';
const D = await import('../src/dashboard.js');

/* ---------------------------------------------------------------- categoriesFor */
test('categoriesFor: tags a coin major by rank, by matching category slugs, or uncategorized', () => {
  const bySlug = new Map([
    ['meme-token', new Set(['dogecoin', 'shiba-inu'])],
    ['gaming', new Set(['shiba-inu'])],
  ]);
  const list = [{ slug: 'meme-token', label: 'Meme' }, { slug: 'gaming', label: 'Gaming' }];
  assert.deepEqual(D.categoriesFor({ id: 'bitcoin', rank: 1 }, bySlug, list, 100), ['major']);
  assert.deepEqual(D.categoriesFor({ id: 'shiba-inu', rank: 250 }, bySlug, list, 100), ['meme-token', 'gaming']);
  assert.deepEqual(D.categoriesFor({ id: 'dogecoin', rank: 15 }, bySlug, list, 100), ['major', 'meme-token']);
  assert.deepEqual(D.categoriesFor({ id: 'some-obscure-coin', rank: 4000 }, bySlug, list, 100), ['uncategorized']);
});

test('categoriesFor: a missing category fetch (empty bySlug) never crashes, just leaves coins uncategorized', () => {
  const list = [{ slug: 'meme-token', label: 'Meme' }];
  assert.deepEqual(D.categoriesFor({ id: 'x', rank: 500 }, new Map(), list, 100), ['uncategorized']);
});

/* ---------------------------------------------------------------- pushAlert */
test('pushAlert: inserts newest-first and caps the buffer', () => {
  const alerts = [];
  D.pushAlert(alerts, { type: 'news', symbol: 'BTC', text: 'first' }, { now: 1000 });
  D.pushAlert(alerts, { type: 'signal', symbol: 'ETH', text: 'second' }, { now: 2000 });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].text, 'second');
  assert.equal(alerts[0].at, 2000);
  assert.equal(alerts[1].text, 'first');
});

test('pushAlert: caps the buffer at the configured size, dropping the oldest', () => {
  const alerts = [];
  for (let i = 0; i < 5; i++) D.pushAlert(alerts, { type: 'signal', symbol: 'X', text: `n${i}` }, { now: i, cap: 3 });
  assert.equal(alerts.length, 3);
  assert.deepEqual(alerts.map((a) => a.text), ['n4', 'n3', 'n2']);
});

/* ---------------------------------------------------------------- buildLeaderboard */
test('buildLeaderboard: joins live opportunities with historical setup performance, labeling thin history', () => {
  const opportunities = [
    { symbol: 'AAA', name: 'Aaa', action: 'BUY', verdict: 'LONG', cls: 'HOT', score: 80, scores: { direction: 80, timing: 70, geometry: 75 }, pUp: 0.6, pUpSource: 'setup history', ev: 0.3, evLB: 0.1, rr: 2.8, setup: 'Pullback', setupId: 'trend_pullback' },
    { symbol: 'BBB', name: 'Bbb', action: 'WATCH', verdict: 'WAIT', cls: 'WATCH', score: 60, scores: { direction: 60, timing: 50, geometry: 55 }, pUp: 0.5, pUpSource: 'prior', ev: 0.05, evLB: -0.02, rr: 1.8, setup: 'Breakout', setupId: 'breakout_retest' },
  ];
  const closedTrades = [
    ...Array.from({ length: 9 }, (_, i) => ({ setup: 'trend_pullback', pnl: i % 3 === 0 ? -5 : 10, pnlPct: i % 3 === 0 ? -0.01 : 0.02 })),
    { setup: 'breakout_retest', pnl: 4, pnlPct: 0.01 },
  ];
  const rows = D.buildLeaderboard(opportunities, closedTrades, { minSample: 8, topN: 20 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'AAA');
  assert.equal(rows[0].history.n, 9);
  assert.equal(rows[0].history.thin, undefined);
  assert.equal(rows[0].history.winRate, 0.67);
  assert.equal(rows[1].symbol, 'BBB');
  assert.equal(rows[1].history.n, 1);
  assert.equal(rows[1].history.thin, true);
});

test('buildLeaderboard: a setup with no closed trades yet gets a null history, never an invented number', () => {
  const opportunities = [{ symbol: 'CCC', name: 'Ccc', action: 'BUY', verdict: 'LONG', cls: 'HOT', score: 70, scores: {}, pUp: 0.5, ev: 0.1, rr: 2.6, setup: 'Sweep', setupId: 'liquidity_sweep' }];
  const rows = D.buildLeaderboard(opportunities, [], {});
  assert.equal(rows[0].history, null);
});

/* ---------------------------------------------------------------- hotScore */
test('hotScore: blends only the signals actually present, naming each one', () => {
  const full = D.hotScore({ rvol: 2, chg1h: 0.05, chg24h: 0.1, trending: true, sentiment: 0.4, sentimentCount: 6 });
  assert.ok(full.total > 0);
  assert.deepEqual(new Set(full.available), new Set(['volume', 'momentum1h', 'momentum24h', 'trending', 'sentiment']));
  const sparse = D.hotScore({ rvol: null, chg1h: null, chg24h: 0.02, trending: false, sentiment: null, sentimentCount: 0 });
  assert.deepEqual(sparse.available, ['momentum24h']);
  assert.ok(!('sentiment' in sparse.parts));
});

test('hotScore: a negative move contributes nothing (never a negative "heat")', () => {
  const r = D.hotScore({ rvol: 1.8, chg1h: -0.08, chg24h: -0.1, trending: false, sentiment: null, sentimentCount: 0 });
  assert.equal(r.parts.momentum1h, undefined);
  assert.equal(r.parts.momentum24h, undefined);
  assert.equal(r.parts.volume, 1.8);
});
