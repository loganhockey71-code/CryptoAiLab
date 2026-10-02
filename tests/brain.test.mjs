// Run: npm test   (node --test tests/)
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PAPER_TRADING = 'true';
const { analyze, analyzeAll, pivots } = await import('../src/structure.js');
const brain = await import('../src/brain.js');
const news = await import('../src/newsimpact.js');
const learning = await import('../src/learning.js');
const risk = await import('../src/risk.js');
const { aggregate } = await import('../src/indicators.js');

/** Candles from a close-price function. wick = fraction of price used for high/low wicks; vol(i) = volume. */
function series(n, close, { gran = 3600, wick = 0.003, vol = () => 100, t0 = 1_700_000_000 } = {}) {
  const out = []; let prev = close(0);
  for (let i = 0; i < n; i++) { const c = close(i), o = prev; out.push({ t: t0 + i * gran, o, c, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), v: vol(i) }); prev = c; }
  return out;
}
const wave = (i, base, drift, amp, period) => base * (1 + drift * i + amp * Math.sin((2 * Math.PI * i) / period));
const up = (n = 320, g = 3600) => series(n, (i) => wave(i, 100, 0.002, 0.03, 24), { gran: g });
const down = (n = 320, g = 3600) => series(n, (i) => wave(i, 100, -0.002, 0.03, 24), { gran: g });

/* ------------------------------------------------------------------ structure */
test('structure: uptrend, downtrend and range are told apart', () => {
  assert.match(analyze(up()).trend.state, /up/);
  assert.match(analyze(down()).trend.state, /down/);
  const flat = analyze(series(320, (i) => 100 + 2 * Math.sin(i / 3)));
  assert.equal(flat.trend.state, 'range');
});

test('structure: pivots only use confirmed swings', () => {
  const c = series(140, (i) => 100 + 5 * Math.sin(i / 4));
  const { highs, lows } = pivots(c);
  assert.ok(highs.length > 2 && lows.length > 2);
  assert.ok(highs.every((h) => h.i < c.length - 3), 'a pivot needs 3 bars after it');
});

test('structure: hammer and bullish engulfing are recognised after a decline', () => {
  const base = series(120, (i) => 120 - i * 0.25);
  const last = base[base.length - 1];
  const hammer = { t: last.t + 3600, o: last.c, c: last.c * 1.002, h: last.c * 1.003, l: last.c * 0.97, v: 300 };
  const a = analyze([...base, hammer, { ...hammer, t: hammer.t + 3600, o: hammer.c, h: hammer.c, l: hammer.c, c: hammer.c }]);
  assert.ok(a.candles.patterns.some((p) => p.name === 'hammer' || p.name === 'bullish_pin_bar'), JSON.stringify(a.candles.patterns));
  assert.ok(a.candles.score > 0);
});

test('structure: a box breakout with retest is detected', () => {
  const after = [104, 106, 108, 107, 105, 103, 102.4, 103.5, 105, 106];
  const c = series(161, (i) => (i < 150 ? 100 + 2 * Math.sin(i * 0.8) : after[i - 150] ?? 106), { wick: 0.002 });
  const a = analyze(c);
  assert.ok(a.box, 'a range should be found');
  assert.equal(a.box.state, 'breakout_up');
  assert.ok(a.box.retest, 'the retest of the old range high should be seen');
});

test('structure: buyer/seller pressure follows where bars close on volume', () => {
  const buyers = series(120, (i) => 100 + i * 0.1, { vol: () => 100 }).map((k) => ({ ...k, c: k.h * 0.999, o: k.l * 1.001 }));
  const a = analyze(buyers);
  assert.ok(a.flow.recent > 0.3, `pressure ${a.flow.recent}`);
  assert.equal(a.flow.control, 'demand_control');
});

/* ---------------------------------------------------------------------- brain */
const shape = (e, st, tg) => risk.shapeTrade(e, st, tg, { symbol: 'TEST', rank: 30 });
function ta(h1c, { m15c, m5c, d1c } = {}) {
  const h1 = h1c, m15 = m15c ?? series(320, (i) => h1c[h1c.length - 1].c, { gran: 900 }), m5 = m5c ?? series(320, (i) => h1c[h1c.length - 1].c, { gran: 300 });
  return analyzeAll({ d1: d1c ?? series(320, (i) => wave(i, 100, h1c === undefined ? 0 : 0.002, 0.03, 24), { gran: 86400 }), h1, m15, m5 });
}
const regimeOk = { label: 'risk_on_uptrend', score: 0.5, allowLongs: true, notes: [] };
const decide = (T, extra = {}) => brain.decide({ symbol: 'TEST', name: 'Test', ta: T, regime: regimeOk, news: null, market: null, book: null, chg24h: 0.02, btcChg24h: 0.01, smart: null, adj: [], shape, ...extra });

test('brain: NEVER buys inside a 1h/4h downtrend, even when the 15m has bounced', () => {
  const h1 = down();
  const bounce = series(320, (i) => (i < 300 ? 100 - i * 0.05 : 85 + (i - 300) * 0.6), { gran: 900, vol: (i) => (i > 300 ? 300 : 100) });
  const d = decide(ta(h1, { m15c: bounce }));
  assert.notEqual(d.action, 'BUY');
  assert.ok(d.vetoes.some((v) => v.hard && /downtrend|supply|conflict/.test(v.code)), JSON.stringify(d.vetoes.map((v) => v.code)));
  assert.ok(['AVOID', 'WATCH', 'IGNORE'].includes(d.cls));
});

test('brain: every veto and reason is generated from the inputs, and a downtrend names what it is waiting for', () => {
  const d = decide(ta(down()));
  assert.ok(d.reasons.length >= 3 && d.reasons.every((r) => typeof r === 'string' && r.length > 10));
  assert.ok(d.waitingFor.length > 0 && /reversal/.test(d.waitingFor.join(' ')));
});

test('brain: other traders cannot create a BUY or move the score by more than ~1 point', () => {
  const T = ta(down());
  const a = decide(T), b = decide(T, { smart: { net: 9, longs: 9, shorts: 0 } });
  assert.equal(a.action, b.action);
  assert.ok(Math.abs(a.score - b.score) <= 1.1, `${a.score} vs ${b.score}`);
});

test('brain: a screened-out coin is IGNORE and gets no setup', () => {
  const d = decide(ta(up()), { rejected: { text: 'illiquid' } });
  assert.equal(d.action, 'IGNORE');
  assert.equal(d.setup, null);
});

test('brain: a SEVERE regime blocks entries (hard veto)', () => {
  const d = decide(ta(up()), { regime: { label: 'risk_off_downtrend', score: -0.6, allowLongs: false, severe: true, notes: ['BTC down'] } });
  assert.notEqual(d.action, 'BUY');
  assert.ok(d.vetoes.some((v) => v.code === 'severe_regime'));
});

test('brain: manage() holds while structure is intact and sells when it breaks', () => {
  const good = ta(up()), bad = ta(down());
  assert.equal(brain.manage({}, good, good['1h'].price).action, 'HOLD');
  assert.equal(brain.manage({}, bad, bad['1h'].price).action, 'SELL');
});

test('brain: probability map is monotonic and bounded by the calibrated floor/ceiling', () => {
  let prev = 0;
  for (let s = 0; s <= 100; s += 10) { const p = brain.probability(s); assert.ok(p >= prev && p >= 0.15 - 1e-9 && p <= 0.45 + 1e-9); prev = p; }
});

/* ----------------------------------------------------------------------- news */
const coins = [{ symbol: 'AAVE', name: 'Aave' }, { symbol: 'XRP', name: 'XRP' }, { symbol: 'BTC', name: 'Bitcoin' }, { symbol: 'ETH', name: 'Ethereum' }];
const ev = (title, extra = {}) => news.extractEvents([{ title, source: 'x', tier: 4, publishedAt: Date.now() - 1800_000, ...extra }], coins);

test('news: denials / hedged headlines are "uncertain" and never dangerous', () => {
  for (const t of ['Aave founder says V3 unaffected after third-party adapter exploit drains $305K', 'Traders now see little chance of a Fed rate hike in October after weak jobs report', 'Trump’s potential AI czar helped pioneer the SEC’s crypto crackdown']) {
    const e = ev(t);
    assert.ok(e.every((x) => x.direction === 'uncertain'), t);
    assert.equal(news.coinImpact(e, coins[0], null, 0.01).dangerous, false, t);
  }
});

test('news: short liquidations are bullish, long liquidations bearish', () => {
  assert.equal(ev('Bitcoin reaches for $87K as short liquidations top $120M')[0].direction, 'bullish');
  assert.equal(ev('Bitcoin slides as long liquidations hit $400M')[0].direction, 'bearish');
});

test('news: an official-source regulator action on a named coin is dangerous; one unofficial market-wide headline is not', () => {
  const sec = ev('SEC sues XRP issuer over unregistered securities', { tier: 3, publishedAt: Date.now() - 600_000 });
  assert.equal(news.coinImpact(sec, coins[1], null, 0.01).dangerous, true);
  const war = ev('Missile strikes escalate overnight as talks collapse', { tier: 4 });
  assert.equal(news.coinImpact(war, coins[2], null, 0.01).dangerous, false);
  assert.ok(news.coinImpact(war, coins[2], null, 0.01).effect < 0, 'still lowers the score');
});

test('news: already-priced-in bullish "sell the news" events lose their effect', () => {
  const e = ev('Coinbase lists Aave perpetuals today');
  const fresh = news.coinImpact(e, coins[0], () => 0.0, 0.01).effect, priced = news.coinImpact(e, coins[0], () => 0.06, 0.01).effect;
  assert.ok(fresh > 0 && priced === 0, `${fresh} ${priced}`);
});

test('news: the same fact from two outlets is one event', () => {
  const e = news.extractEvents([{ title: 'Hackers drain $50M from Aave bridge exploit', source: 'A', tier: 4, publishedAt: Date.now() - 1000 }, { title: 'Aave bridge exploit: hackers drain $50M', source: 'B', tier: 4, publishedAt: Date.now() - 2000 }], coins);
  assert.equal(e.length, 1);
  assert.equal(e[0].corroboratedBy, 1);
});

/* ------------------------------------------------------------------- learning */
const C15 = (startS, path) => path.map((p, i) => ({ t: startS + i * 900, o: p[0], c: p[3], h: p[1], l: p[2], v: 1 }));
test('learning.measure: target-first, stop-first and timeout are scored in R, stop wins ties', () => {
  const at = 1_700_000_000_000, entry = { at, holdHours: 4 }, plan = { entry: 100, stop: 98, target: 106 };
  const bars = (arr) => C15(at / 1000, arr);
  const win = learning.measure(entry, bars([[100, 103, 99.5, 102], [102, 106.5, 101, 106]]), plan, at + 3600_000 * 6);
  assert.equal(win.hit, 'target'); assert.ok(win.R > 2.3);
  const loss = learning.measure(entry, bars([[100, 101, 97.5, 98]]), plan, at + 3600_000 * 6);
  assert.equal(loss.hit, 'stop'); assert.ok(loss.R < -0.9);
  const tie = learning.measure(entry, bars([[100, 107, 97, 100]]), plan, at + 3600_000 * 6);
  assert.equal(tie.hit, 'stop', 'a bar touching both counts as the stop');
  const young = learning.measure(entry, bars([[100, 101, 99.5, 100.5]]), plan, at + 900_000);
  assert.equal(young, null, 'not matured yet');
});

function fakeEntries(specs) {
  learning.journal.entries = specs.map((s, i) => ({ id: `t${i}`, at: 1_700_000_000_000 + i * 3600_000, symbol: 'X', action: 'WATCH', setup: s.setup, score: 70, rr: 3, stop: 98, target: 106, vetoes: [], evidence: { regime: 'risk_on_uptrend', trend: { '4h': 'up', '1h': 'up' }, volume: { rvol15: 1, rvol1h: 1 }, momentum: {}, flow: {}, news: {} }, outcome: { R: s.R, hit: s.R > 0 ? 'target' : 'stop', source: 'candles', mfe: 0.01, mae: -0.01 } }));
}
test('learning.learnRules: only rules that hold on BOTH the earlier and the later slice go live', () => {
  const stable = Array.from({ length: 40 }, (_, i) => ({ setup: 'good', R: i % 4 === 0 ? -1 : 1.2 })), flaky = Array.from({ length: 40 }, (_, i) => ({ setup: 'flaky', R: i < 24 ? 1.5 : -1 })), neutral = Array.from({ length: 40 }, (_, i) => ({ setup: 'mid', R: i % 2 ? 0.2 : -0.2 }));
  const mixed = []; for (let i = 0; i < 40; i++) mixed.push(stable[i], flaky[i], neutral[i]);
  fakeEntries(mixed);
  const rules = learning.learnRules();
  const get = (k) => rules.find((r) => r.key === k);
  assert.equal(get('setup:good').status, 'active');
  assert.ok(get('setup:good').delta > 0 && get('setup:good').delta <= 8);
  assert.notEqual(get('setup:flaky').status, 'active', 'train good / test bad must not become a rule');
  assert.equal(get('setup:mid').status, 'active', 'consistently below the average on both slices is a (negative) rule');
  assert.ok(get('setup:mid').delta < 0);
});

test('learning.learnRules: with too little data nothing is activated and the report says so', () => {
  fakeEntries([{ setup: 'a', R: 1 }, { setup: 'a', R: 1 }, { setup: 'b', R: -1 }]);
  const rules = learning.learnRules();
  assert.ok(rules.every((r) => r.status !== 'active'));
  assert.ok(learning.report().sufficiency.length > 0);
});

test('learning.findMissed: explains why a +12% mover was not bought, from what the AI said before it moved', () => {
  const now = Date.now(), nowS = Math.floor(now / 3600_000) * 3600;
  const bars = Array.from({ length: 30 }, (_, i) => { const t = nowS - (30 - i) * 3600, p = i < 12 ? 100 - i * 0.2 : 97.8 + (i - 11) * 0.9; return { t, h: p * 1.004, l: p * 0.996, c: p }; });
  learning.journal.ring = new Map([['MOVR', [{ t: now - 22 * 3600_000, a: 'IGNORE', c: 'AVOID', s: 31, su: null, v: ['downtrend_h1'], p: 100 }]]]);
  const m = learning.findMissed([{ symbol: 'MOVR', h1: bars }], now);
  assert.equal(m.length, 1);
  assert.equal(m[0].why.code, 'downtrend_h1');
  assert.ok(m[0].movePct >= 0.08 && /downtrend/.test(m[0].text));
});

test('risk: nothing in the Brain can widen a stop beyond the 4% cap (shapeTrade clamps it)', () => {
  const s = risk.shapeTrade(100, 80, 130, { symbol: 'TEST', rank: 30 });
  assert.ok(s.stopDist <= 0.04 + 1e-9);
});
