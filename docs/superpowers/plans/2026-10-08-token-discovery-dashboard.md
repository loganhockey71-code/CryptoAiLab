# Token-Discovery Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six discovery pages (Tokens, Search, Hot, Alerts, AI Leaderboard, Categories) plus a carried-over Portfolio tab to the existing single-page dashboard, built entirely on real data the engine already computes or can cheaply fetch, with no changes to trading/risk logic.

**Architecture:** Server side, add four pure/testable helpers in a new `src/dashboard.js` (category tagging, an alert ring-buffer push, a leaderboard join of live decisions with historical setup performance, and a transparent "hot" score), wire them into `src/universe.js` (a new periodic CoinGecko category fetch) and `src/engine.js` (alert emission at existing event points, new snapshot fields), and add one new `/api/alerts` paging endpoint in `src/server.js`. Client side, turn `public/index.html`/`app.js` into a small hash-router SPA: a persistent header (stats + global search + nav tabs) swaps a content area between seven views, reusing the existing single `/api/state` + `/api/stream` snapshot and today's render functions (moved, not rewritten) for the carried-over Portfolio/Tokens content.

**Tech Stack:** Node.js (ESM), Express, vanilla JS/HTML/CSS (no build step), `node:test` for server-side unit tests, `lightweight-charts` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-10-08-token-discovery-dashboard-design.md`

---

## Part A — Server-side data additions

### Task 1: `src/config.js` — categories config block

**Files:**
- Modify: `src/config.js:182` (immediately after the closing `}),` of the `radar` block)

- [ ] **Step 1: Add the `categories` config block**

Insert this new block right after the `radar: Object.freeze({ ... }),` block ends (after the line containing `thinSpikePct: 0.20, thinSpikeVol: 3_000_000,` and its closing `}),`):

```js
  // Categories page: a fixed small set of CoinGecko category slugs, refreshed on a slow cadence (one call per slug, not per coin).
  // majorRank: a coin with cg_rank <= majorRank is tagged "major" regardless of its other categories.
  categories: Object.freeze({
    everyMs: 6 * 60 * 60_000,
    majorRank: 100,
    list: Object.freeze([
      { slug: 'meme-token', label: 'Meme' },
      { slug: 'decentralized-finance-defi', label: 'DeFi' },
      { slug: 'artificial-intelligence', label: 'AI' },
      { slug: 'gaming', label: 'Gaming' },
      { slug: 'layer-1', label: 'Layer 1' },
      { slug: 'real-world-assets-rwa', label: 'RWA' },
    ]),
  }),
```

- [ ] **Step 2: Verify the file still parses**

Run: `node -e "import('./src/config.js').then(m => console.log(m.config.categories.list.length))"`
Expected: `6`

- [ ] **Step 3: Commit**

```bash
git add src/config.js
git commit -m "Add categories config block for the dashboard's Categories page"
```

---

### Task 2: `src/dashboard.js` — pure helpers (TDD)

**Files:**
- Create: `src/dashboard.js`
- Create: `tests/dashboard.test.mjs`
- Modify: `package.json:7`

This task builds four small, pure functions with no I/O, each independently testable: `categoriesFor` (category tagging), `pushAlert` (ring-buffer insert), `buildLeaderboard` (join live decisions with historical setup performance), `hotScore` (a transparent, labeled "what's hot" score).

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/dashboard.test.mjs`
Expected: FAIL — `Cannot find module '../src/dashboard.js'`

- [ ] **Step 3: Write `src/dashboard.js`**

```js
// Pure helpers behind the dashboard's Categories, Alerts, AI Leaderboard and Hot pages. No I/O, no randomness: every number here is
// either a plain transform of real input or explicitly absent (never invented) when its input is missing.

/** Which category tags apply to one coin: 'major' by rank, plus any CoinGecko category slug whose fetched id set contains this coin.
 *  bySlug: Map<slug, Set<coingecko_id>>. coin: { id (coingecko id), rank (trade rank, 1 = biggest) }. Never empty: 'uncategorized' when nothing else matches. */
export function categoriesFor(coin, bySlug, categoryList, majorRank) {
  const tags = [];
  if (coin.rank != null && coin.rank <= majorRank) tags.push('major');
  for (const { slug } of categoryList) if (bySlug.get(slug)?.has(coin.id)) tags.push(slug);
  return tags.length ? tags : ['uncategorized'];
}

/** Ring-buffer insert, newest first, capped. Mutates and returns `alerts`. `now`/`cap` are injectable for deterministic tests. */
export function pushAlert(alerts, entry, { cap = 300, now = Date.now() } = {}) {
  alerts.unshift({ at: now, ...entry });
  if (alerts.length > cap) alerts.length = cap;
  return alerts;
}

/** AI Leaderboard rows: today's live opportunities (already ranked, already carrying score/pUp/ev/rr/setup), each joined with its
 *  setup's measured record from closed paper trades. A setup with fewer than `minSample` closed trades is labeled `thin: true`
 *  rather than given a win rate that isn't backed by enough data; a setup with zero closed trades gets `history: null`. */
export function buildLeaderboard(opportunities, closedTrades, { minSample = 8, topN = 20 } = {}) {
  const bySetup = new Map();
  for (const t of closedTrades) {
    if (!t.setup) continue;
    const g = bySetup.get(t.setup) ?? { n: 0, wins: 0, sumPnlPct: 0 };
    g.n++; if (t.pnl > 0) g.wins++; g.sumPnlPct += t.pnlPct ?? 0;
    bySetup.set(t.setup, g);
  }
  return opportunities.slice(0, topN).map((o) => {
    const g = o.setupId ? bySetup.get(o.setupId) : null;
    const history = !g ? null : g.n >= minSample ? { n: g.n, winRate: +(g.wins / g.n).toFixed(2), avgPnlPct: +(g.sumPnlPct / g.n).toFixed(4) } : { n: g.n, thin: true };
    return { symbol: o.symbol, name: o.name, action: o.action, verdict: o.verdict, cls: o.cls, score: o.score, scores: o.scores, pUp: o.pUp, pUpSource: o.pUpSource, ev: o.ev, evLB: o.evLB, rr: o.rr, setup: o.setup, setupId: o.setupId, history };
  });
}

/** A transparent "what's hot" score: the sum of whichever signals are actually present for this coin, each named in `parts` so the
 *  UI can show the breakdown instead of a hidden number. A missing input contributes nothing and is absent from `parts`/`available`
 *  (not zero) so the UI can tell "no signal" apart from "neutral signal". Only upward momentum counts (buying weakness is a
 *  different, separate strategy, not "hot"). */
export function hotScore(row, { trendingBonus = 1.5 } = {}) {
  const parts = {};
  if (row.rvol != null) parts.volume = +row.rvol.toFixed(2);
  if (row.chg1h != null && row.chg1h > 0) parts.momentum1h = +(row.chg1h * 20).toFixed(2);
  if (row.chg24h != null && row.chg24h > 0) parts.momentum24h = +(row.chg24h * 8).toFixed(2);
  if (row.trending) parts.trending = trendingBonus;
  if (row.sentiment != null && row.sentimentCount > 0) parts.sentiment = +Math.max(0, row.sentiment).toFixed(2);
  const total = +Object.values(parts).reduce((a, b) => a + b, 0).toFixed(2);
  return { total, parts, available: Object.keys(parts) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/dashboard.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Add the new test file to `package.json`'s test script**

In `package.json:7`, change:

```json
    "test": "node --test tests/brain.test.mjs tests/entry.test.mjs tests/rules.test.mjs tests/explore.test.mjs",
```

to:

```json
    "test": "node --test tests/brain.test.mjs tests/entry.test.mjs tests/rules.test.mjs tests/explore.test.mjs tests/dashboard.test.mjs",
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (all suites, including the 8 new dashboard tests)

- [ ] **Step 7: Commit**

```bash
git add src/dashboard.js tests/dashboard.test.mjs package.json
git commit -m "Add pure dashboard helpers: category tagging, alert buffer, leaderboard join, hot score"
```

---

### Task 3: `src/universe.js` — periodic CoinGecko category fetch

**Files:**
- Modify: `src/universe.js:116` (immediately after the `cgTrending` function, before `export const universe = ...`)

- [ ] **Step 1: Add `cgCategories()`**

Insert this new function right after the closing `}` of `export async function cgTrending() { ... }` (currently ending at line 116, just before `export const universe = ...`):

```js
/** CoinGecko's markets list filtered by category, one call per configured slug (config.categories.list), cached on config.categories.everyMs.
 *  Returns Map<slug, Set<coingecko_id>>. A slug whose fetch fails keeps its last good set (stale beats empty) and the cache is retried sooner. */
let categoryCache = { at: 0, bySlug: new Map() };
export async function cgCategories() {
  const Zc = config.categories;
  if (categoryCache.at && Date.now() - categoryCache.at < Zc.everyMs) return categoryCache.bySlug;
  const bySlug = new Map();
  let okAny = false;
  for (const { slug } of Zc.list) {
    try {
      const rows = await cgFetch(`/coins/markets?vs_currency=usd&category=${slug}&per_page=250`, 'lo');
      bySlug.set(slug, new Set(rows.map((r) => r.id)));
      okAny = true;
    } catch (e) {
      warn(`CoinGecko category '${slug}' unavailable:`, e.message);
      bySlug.set(slug, categoryCache.bySlug.get(slug) ?? new Set());
    }
  }
  categoryCache = okAny ? { at: Date.now(), bySlug } : { at: Date.now() - Zc.everyMs + 5 * 60_000, bySlug };
  return categoryCache.bySlug;
}
/** Age of the current category cache in ms, or null before the first fetch (for the UI's staleness label). */
export function categoriesAgeMs() { return categoryCache.at ? Date.now() - categoryCache.at : null; }
```

- [ ] **Step 2: Verify it runs (network call; may take a few seconds)**

Run: `node -e "import('./src/universe.js').then(async m => { const b = await m.cgCategories(); console.log([...b.entries()].map(([k,v]) => k+':'+v.size)); })"`
Expected: six lines like `meme-token:250` printed (sizes near 250, the per_page cap), or a warning line for any slug CoinGecko rejects — either way it must not throw.

- [ ] **Step 3: Commit**

```bash
git add src/universe.js
git commit -m "Add periodic CoinGecko category fetch for the dashboard's Categories page"
```

---

### Task 4: `src/engine.js` — carry `setup` into closed-trade history

The AI Leaderboard's historical join (Task 2's `buildLeaderboard`) needs each closed trade's setup name, which today is stored in the DB's `prediction.setup` JSON field but is dropped when trades are mapped into `state.recentClosed`.

**Files:**
- Modify: `src/engine.js:755-762` (`historyFromDb`)
- Modify: `src/engine.js:764-770` (`recordHistory`)

- [ ] **Step 1: Add `setup` to `historyFromDb`**

Change:

```js
function historyFromDb(t) {
  return {
    id: t.id, symbol: t.symbol, side: t.side ?? 'long', source: t.source ?? 'strategy', trader: t.source_trader ?? null,
    entry: Number(t.entry_price), exit: Number(t.exit_price), notional: Number(t.final_pnl_pct) ? Math.abs(Number(t.final_pnl) / Number(t.final_pnl_pct)) : Number(t.notional), pnl: Number(t.final_pnl), pnlPct: Number(t.final_pnl_pct),
    reason: t.exit_reason, openedAt: new Date(t.entry_time).getTime(), closedAt: new Date(t.exit_time).getTime(),
    origin: String(t.source ?? '').startsWith('copy_') ? 'mimic' : 'own', trigger: t.entry_trigger ?? null, triggerReasons: t.prediction?.trigger?.reasons ?? [], mode: t.prediction?.mode ?? 'normal',
  };
}
```

to:

```js
function historyFromDb(t) {
  return {
    id: t.id, symbol: t.symbol, side: t.side ?? 'long', source: t.source ?? 'strategy', trader: t.source_trader ?? null,
    entry: Number(t.entry_price), exit: Number(t.exit_price), notional: Number(t.final_pnl_pct) ? Math.abs(Number(t.final_pnl) / Number(t.final_pnl_pct)) : Number(t.notional), pnl: Number(t.final_pnl), pnlPct: Number(t.final_pnl_pct),
    reason: t.exit_reason, openedAt: new Date(t.entry_time).getTime(), closedAt: new Date(t.exit_time).getTime(),
    origin: String(t.source ?? '').startsWith('copy_') ? 'mimic' : 'own', trigger: t.entry_trigger ?? null, triggerReasons: t.prediction?.trigger?.reasons ?? [], mode: t.prediction?.mode ?? 'normal',
    setup: t.prediction?.setup ?? null,
  };
}
```

- [ ] **Step 2: Add `setup` to `recordHistory`**

Change:

```js
function recordHistory(pos, trade, notional) {
  state.recentClosed.unshift({
    id: pos.id, symbol: pos.symbol, side: pos.side ?? 'long', source: sourceOf(pos), trader: pos.copy?.trader ?? null,
    entry: pos.entry, exit: trade.exit_price, notional, pnl: trade.final_pnl, pnlPct: trade.final_pnl_pct, reason: trade.exit_reason,
    openedAt: pos.openedAt, closedAt: Date.now(),
    origin: pos.copy ? 'mimic' : 'own', trigger: pos.trigger?.kind ?? null, triggerReasons: pos.trigger?.reasons ?? [], mode: pos.mode ?? 'normal',
  });
```

to:

```js
function recordHistory(pos, trade, notional) {
  state.recentClosed.unshift({
    id: pos.id, symbol: pos.symbol, side: pos.side ?? 'long', source: sourceOf(pos), trader: pos.copy?.trader ?? null,
    entry: pos.entry, exit: trade.exit_price, notional, pnl: trade.final_pnl, pnlPct: trade.final_pnl_pct, reason: trade.exit_reason,
    openedAt: pos.openedAt, closedAt: Date.now(),
    origin: pos.copy ? 'mimic' : 'own', trigger: pos.trigger?.kind ?? null, triggerReasons: pos.trigger?.reasons ?? [], mode: pos.mode ?? 'normal',
    setup: pos.ctx?.brain?.setup?.name ?? null,
  });
```

- [ ] **Step 3: Run the existing test suite (regression check)**

Run: `npm test`
Expected: PASS — these are additive fields, nothing existing reads a fixed shape that would break.

- [ ] **Step 4: Commit**

```bash
git add src/engine.js
git commit -m "Carry the setup name into closed-trade history for the AI Leaderboard join"
```

---

### Task 5: `src/engine.js` — new state fields and imports

**Files:**
- Modify: `src/engine.js:8` (import line)
- Modify: `src/engine.js:41-47` (initial `state` object)

- [ ] **Step 1: Import the new helpers**

Change line 8 from:

```js
import { refreshUniverse, restoreCooldowns, universe, cgTrending, radar as radarState, watchOnlyMovers, refreshHot, refreshTail, cgStats } from './universe.js';
```

to:

```js
import { refreshUniverse, restoreCooldowns, universe, cgTrending, cgCategories, categoriesAgeMs, radar as radarState, watchOnlyMovers, refreshHot, refreshTail, cgStats } from './universe.js';
import * as dashboard from './dashboard.js';
```

- [ ] **Step 2: Add the new state fields**

Find the initial `state` object (around line 41-47):

```js
  closedTotal: 0,              // every trade ever closed (top-bar counter; recentClosed is capped at 200)
  trending: new Set(),         // CoinGecko trending ids, refreshed every scan
  ctx: null,                   // latest news/macro/politics context, reused by the fast mover scan
  newsFeed: { at: null, feeds: [], items: [] },   // everything the app read this scan (News & Politics panel)
  freezeKeys: new Set(),       // breaker events that have already caused a freeze (so one event can never re-freeze)
  copyCooldown: new Map(),     // coin -> until (2h lockout after a copied position hits its stop)
  rescore: new Set(),          // trader addresses whose win rate must be re-evaluated now (3rd straight loss, or manual release)
```

Add these four lines right after `rescore: new Set(),`:

```js
  categories: new Map(),       // CoinGecko category slug -> Set(coingecko_id), refreshed every few hours
  alerts: [],                  // Alerts page: news + AI-generated signal/trade events, newest first, capped at 300
  prevLiveSymbols: new Set(),  // last scan's live BUY/SHORT symbols, so a NEW one can be alerted once
  lastActiveRuleCount: null,   // last scan's count of active learned rules, so a newly-active one can be alerted once
```

- [ ] **Step 3: Commit**

```bash
git add src/engine.js
git commit -m "Add dashboard state fields: categories, alerts, prevLiveSymbols, lastActiveRuleCount"
```

---

### Task 6: `src/engine.js` — emit alerts from `runBrain()`

**Files:**
- Modify: `src/engine.js:196` (the `cgTrending()` call)
- Modify: `src/engine.js:335-363` (the per-coin decision loop and the `opp`/`state.brain` assembly, inside `runBrain`)

- [ ] **Step 1: Fetch categories alongside trending**

Change line 196 from:

```js
    cgTrending().then((t) => { state.trending = t; }).catch(() => {});   // cached 15 min; never lets a CoinGecko rate-limit pause hold up the scan
```

to:

```js
    cgTrending().then((t) => { state.trending = t; }).catch(() => {});   // cached 15 min; never lets a CoinGecko rate-limit pause hold up the scan
    cgCategories().then((c) => { state.categories = c; }).catch(() => {});   // cached several hours; same non-blocking pattern
```

- [ ] **Step 2: Alert when a coin enters HOT classification**

In `runBrain`, change:

```js
  const decisions = [];
  for (const cs of coins) {
    const prev = cs.brain?.score;
    const d = thinkAbout(cs, env);
    cs.brainDelta = prev != null ? d.score - prev : 0; cs.brain = d;
    decisions.push(d);
    learning.noteScan(cs.symbol, d, now);
  }
```

to:

```js
  const decisions = [];
  for (const cs of coins) {
    const prev = cs.brain?.score, prevCls = cs.brain?.cls;
    const d = thinkAbout(cs, env);
    cs.brainDelta = prev != null ? d.score - prev : 0; cs.brain = d;
    decisions.push(d);
    learning.noteScan(cs.symbol, d, now);
    if (d.cls === 'HOT' && prevCls !== 'HOT') dashboard.pushAlert(state.alerts, { type: 'signal', symbol: d.symbol, text: `${d.symbol} entered HOT classification (score ${d.score}${d.setup ? `, ${d.setup.label}` : ''})` });
  }
```

- [ ] **Step 3: Alert on a newly-appearing live BUY/SHORT signal, and on a newly-active learned rule**

Find this block (right after `decisions.sort(rank)` / the `opp` line, currently):

```js
  const by = (cls) => decisions.filter((d) => d.cls === cls);
  const live1 = (d) => d.action === 'BUY' || d.action === 'SHORT';
  const opp = decisions.filter((d) => live1(d) || d.cls === 'HOT' || d.cls === 'SHORT' || d.action === 'WATCH').sort((a, b) => (live1(a) ? 0 : 1) - (live1(b) ? 0 : 1) || b.score - a.score || b.scores.direction - a.scores.direction);
  state.brain = {
```

Insert these lines between the `opp` line and `state.brain = {`:

```js
  const liveSymbols = new Set(decisions.filter(live1).map((d) => d.symbol));
  for (const sym of liveSymbols) if (!state.prevLiveSymbols.has(sym)) {
    const d = decisions.find((x) => x.symbol === sym);
    dashboard.pushAlert(state.alerts, { type: 'signal', symbol: sym, text: `${sym}: new ${d.action} signal (score ${d.score}, EV ${d.ev ?? '—'}R${d.setup ? `, ${d.setup.label}` : ''})` });
  }
  state.prevLiveSymbols = liveSymbols;
  const activeRules = learningReport().activeRules ?? 0;
  if (state.lastActiveRuleCount != null && activeRules > state.lastActiveRuleCount) {
    dashboard.pushAlert(state.alerts, { type: 'signal', symbol: '*', text: `${activeRules - state.lastActiveRuleCount} learned rule(s) went active (now ${activeRules} total)` });
  }
  state.lastActiveRuleCount = activeRules;

```

(so the full ordering is: `opp` line, the new block above, then `state.brain = { ... }` unchanged).

- [ ] **Step 4: Run the full test suite (regression check)**

Run: `npm test`
Expected: PASS — `runBrain` isn't exercised by the current unit tests directly (they test `brain.decide` in isolation), so this is a structural check that nothing else broke; `learningReport` and `live1`/`decisions` are pre-existing locals, used here in their existing scope.

- [ ] **Step 5: Commit**

```bash
git add src/engine.js
git commit -m "Emit dashboard alerts for HOT classification, new live signals, and newly-active learned rules"
```

---

### Task 7: `src/engine.js` — emit alerts on position opened/closed

**Files:**
- Modify: `src/engine.js:651` (end of `tryEnter`, after the existing `logDecision('entered', ...)` call)
- Modify: `src/engine.js:831` (inside `closePosition`, after the existing `logDecision('exit', ...)` call)

- [ ] **Step 1: Alert when a position opens**

Change:

```js
    logDecision('entered', p.symbol, `${exploring ? 'EXPLORATION ' : ''}PAPER LONG ${qty.toPrecision(5)} @ ${entryPx.toPrecision(6)} ($${notional.toFixed(0)}, ${pct(sizePct)} of equity) stop ${stopPx.toPrecision(6)} (${pct(fin.stopPct)}) risk $${fin.riskUsd.toFixed(2)} (${pct(fin.riskUsd / equity)} of equity) target ${shaped.target.toPrecision(6)} · ${d.setup.label}`);
  } catch (e) {
```

to:

```js
    logDecision('entered', p.symbol, `${exploring ? 'EXPLORATION ' : ''}PAPER LONG ${qty.toPrecision(5)} @ ${entryPx.toPrecision(6)} ($${notional.toFixed(0)}, ${pct(sizePct)} of equity) stop ${stopPx.toPrecision(6)} (${pct(fin.stopPct)}) risk $${fin.riskUsd.toFixed(2)} (${pct(fin.riskUsd / equity)} of equity) target ${shaped.target.toPrecision(6)} · ${d.setup.label}`);
    dashboard.pushAlert(state.alerts, { type: 'trade', symbol: p.symbol, text: `${exploring ? 'Exploration' : 'Paper'} long opened: ${qty.toPrecision(5)} @ ${entryPx.toPrecision(6)} (${d.setup.label}), stop ${stopPx.toPrecision(6)}, target ${shaped.target.toPrecision(6)}` });
  } catch (e) {
```

- [ ] **Step 2: Alert when a position closes**

Change:

```js
  logDecision('exit', pos.symbol, `${reason}: net P&L $${finalPnl.toFixed(2)} (${pct(finalPct)})${pos.copy ? ` [copy of ${pos.copy.trader.slice(0, 8)}]` : ''}`);
```

to:

```js
  logDecision('exit', pos.symbol, `${reason}: net P&L $${finalPnl.toFixed(2)} (${pct(finalPct)})${pos.copy ? ` [copy of ${pos.copy.trader.slice(0, 8)}]` : ''}`);
  dashboard.pushAlert(state.alerts, { type: 'trade', symbol: pos.symbol, text: `Position closed (${reason}): net P&L $${finalPnl.toFixed(2)} (${pct(finalPct)})` });
```

- [ ] **Step 3: Run the full test suite (regression check)**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/engine.js
git commit -m "Emit dashboard alerts when a paper position opens or closes"
```

---

### Task 8: `src/engine.js` — `/api/alerts` paging support and leaderboard/snapshot fields

**Files:**
- Modify: `src/engine.js:1277-1329` (`snapshotForUi`)
- Modify: `src/engine.js` (add a new exported `alertsPage` function near `snapshotForUi`)

- [ ] **Step 1: Add category/trending tags and a hot score to each row**

In `snapshotForUi`, the row-mapping loop currently ends with:

```js
      stale: coin.product ? feed.tickAgeMs(coin.product) > R.staleMs : null,
      ...(cs ? rowActivity(cs) : {}),
    };
  });
```

Change it to:

```js
      stale: coin.product ? feed.tickAgeMs(coin.product) > R.staleMs : null,
      trending: state.trending.has(coin.id),
      category: dashboard.categoriesFor(coin, state.categories, config.categories.list, config.categories.majorRank),
      hot: dashboard.hotScore({ rvol: cs?.rvol ?? null, chg1h: coin.chg1h ?? null, chg24h: coin.chg24h ?? null, trending: state.trending.has(coin.id), sentiment: cs?.sentiment?.score ?? null, sentimentCount: cs?.sentiment?.count ?? 0 }),
      ...(cs ? rowActivity(cs) : {}),
    };
  });
```

- [ ] **Step 2: Add `categories`, `alerts`, and `leaderboard` to the returned snapshot**

Find the end of `snapshotForUi`'s return object:

```js
    newsFeed: state.newsFeed,
    decisions: state.decisions.slice(0, 100), reflections: state.reflections.slice(0, 40),
    pending: [...state.pending.values()].map((x) => ({ symbol: x.symbol, refPrice: x.refPrice, createdAt: x.createdAt, score: x.decision?.score ?? null })),
    brain: brainSnapshot(),
    limits: { minConfluence: R.minConfluence, minRR: R.minRR, maxPositions: R.maxOpenPositions },
  };
}
```

Change to:

```js
    newsFeed: state.newsFeed,
    decisions: state.decisions.slice(0, 100), reflections: state.reflections.slice(0, 40),
    pending: [...state.pending.values()].map((x) => ({ symbol: x.symbol, refPrice: x.refPrice, createdAt: x.createdAt, score: x.decision?.score ?? null })),
    brain: brainSnapshot(),
    limits: { minConfluence: R.minConfluence, minRR: R.minRR, maxPositions: R.maxOpenPositions },
    categories: { list: config.categories.list, ageMs: categoriesAgeMs() },
    alerts: state.alerts.slice(0, 200),
    leaderboard: dashboard.buildLeaderboard(state.brain.opportunities ?? [], state.recentClosed, {}),
  };
}
```

- [ ] **Step 3: Add the `/api/alerts` paging function**

Add this new exported function immediately after `snapshotForUi` (after its closing `}`, before `export const __test = ...`):

```js
/** Alerts older than `beforeTs` (default: now), newest first, for the Alerts page's "load more". */
export function alertsPage(beforeTs = Date.now(), limit = 100) {
  return state.alerts.filter((a) => a.at < beforeTs).slice(0, limit);
}
```

- [ ] **Step 4: Run the full test suite (regression check)**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine.js
git commit -m "Expose categories, alerts and AI leaderboard in the dashboard snapshot"
```

---

### Task 9: `src/server.js` — `/api/alerts` endpoint

**Files:**
- Modify: `src/server.js:36` (immediately after the `/api/stream` route, before `let tradeCache = ...`)

- [ ] **Step 1: Add the route**

Insert after the closing `});` of the `/api/stream` handler (line 36) and before `let tradeCache = { at: 0, rows: [] };`:

```js

// Alerts page "load more": alerts strictly older than ?before (ms epoch), newest first.
app.get('/api/alerts', (req, res) => {
  if (!engine.isReady()) return res.status(503).json({ error: 'starting' });
  const before = Number(req.query.before) || Date.now();
  res.json({ alerts: engine.alertsPage(before, 100) });
});
```

- [ ] **Step 2: Verify the server still starts**

Run: `PAPER_TRADING=true node -e "import('./src/server.js').catch(e => { console.error(e); process.exit(1); })"`
Expected: no immediate throw (the process keeps running / logs "Dashboard: http://localhost:..."); stop it with Ctrl+C or let the harness time out the foreground command after confirming the startup log line.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "Add /api/alerts paging endpoint for the Alerts page"
```

---

## Part B — Client-side pages

### Task 10: `public/index.html` — nav shell and new view containers

**Files:**
- Modify: `public/index.html` (header, and wrap existing `<main class="grid">` content)

- [ ] **Step 1: Add the nav bar and search input to the header**

Change:

```html
<header class="top">
  <div class="brand">Crypto AI Lab <span class="badge paper">PAPER ONLY</span></div>
  <div class="stats" id="stats"></div>
</header>
<div id="banner" class="banner hidden"></div>
```

to:

```html
<header class="top">
  <div class="brand">Crypto AI Lab <span class="badge paper">PAPER ONLY</span></div>
  <input id="search" type="search" placeholder="Search tokens…" autocomplete="off" class="search">
  <nav id="nav" class="nav">
    <a href="#tokens" data-view="tokens">Tokens</a>
    <a href="#hot" data-view="hot">Hot</a>
    <a href="#alerts" data-view="alerts">Alerts</a>
    <a href="#leaderboard" data-view="leaderboard">AI Leaderboard</a>
    <a href="#categories" data-view="categories">Categories</a>
    <a href="#portfolio" data-view="portfolio">Portfolio</a>
  </nav>
  <div class="stats" id="stats"></div>
</header>
<div id="banner" class="banner hidden"></div>
```

- [ ] **Step 2: Wrap the existing content into named views**

The current `<main class="grid">` holds, in order: `regime-panel`, `risks-panel`, `opp-panel`, `avoid-panel`, `report-panel`, `table-panel`, `chart-panel`, `pos-panel`, `radar-panel`, `history-panel`, `copy-panel`, `news-panel`, `log-panel`, `learn-panel`.

Split it into two `<main>` blocks: `table-panel` + `chart-panel` become the **Tokens** view (plus new Hot/Alerts/Leaderboard/Categories scaffolding); everything else becomes the **Portfolio** view. Replace the single `<main class="grid">...</main>` block with:

```html
<main id="view-tokens" class="grid view">
  <section class="panel table-panel">
    <div class="panel-head">
      <h2>All tradable coins <small id="universe-note"></small></h2>
      <div class="toggles" id="up-toggles" title="Show only coins that are rising on every selected timeframe">
        <button type="button" class="tog" data-tf="m1">1M ▲</button>
        <button type="button" class="tog" data-tf="h1">1H ▲</button>
        <button type="button" class="tog" data-tf="h24">24H ▲</button>
      </div>
      <div class="toggles" id="category-filter" title="Filter by category"></div>
      <input id="filter" type="search" placeholder="Filter coin…" autocomplete="off">
    </div>
    <div class="scroll table-scroll">
      <table id="coins">
        <thead><tr>
          <th>#</th><th>Coin</th><th class="r">Price</th><th class="r">1h / 24h</th><th>1m candle</th><th>Signal</th><th class="r">Score</th>
          <th>Class</th><th class="r">RVOL</th><th class="r">Funding</th><th class="r">News</th><th>Data</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section class="panel chart-panel">
    <div class="panel-head"><h2>Chart · <span id="chart-symbol">BTC</span> <small>1m</small></h2><span class="muted" id="chart-note"></span></div>
    <div id="chart"></div>
  </section>
</main>

<main id="view-hot" class="grid-1 view hidden">
  <section class="panel">
    <div class="panel-head"><h2>Hot <small id="hot-note">price momentum, volume spikes and trending/sentiment where available</small></h2></div>
    <div class="scroll table-scroll"><table id="hot-table"><thead><tr><th>#</th><th>Coin</th><th class="r">Price</th><th class="r">1h / 24h</th><th class="r">RVOL</th><th>Signals</th><th class="r">Heat</th></tr></thead><tbody></tbody></table></div>
  </section>
</main>

<main id="view-alerts" class="grid-1 view hidden">
  <section class="panel">
    <div class="panel-head">
      <h2>Alerts <small id="alerts-note">news + AI-generated signal and trade events</small></h2>
      <div class="toggles" id="alert-filter">
        <button type="button" class="tog on" data-type="all">All</button>
        <button type="button" class="tog" data-type="news">News</button>
        <button type="button" class="tog" data-type="signal">Signal</button>
        <button type="button" class="tog" data-type="trade">Trade</button>
      </div>
    </div>
    <div class="scroll" id="alerts-list" style="max-height:720px"></div>
  </section>
</main>

<main id="view-leaderboard" class="grid-1 view hidden">
  <section class="panel">
    <div class="panel-head"><h2>AI Leaderboard <small id="leaderboard-note">today's top live ideas, with each setup's measured track record</small></h2></div>
    <div class="scroll table-scroll"><table id="leaderboard-table"><thead><tr><th>Coin</th><th>Action</th><th>Class</th><th>Setup</th><th class="r">Score</th><th class="r">P(target)</th><th class="r">EV</th><th class="r">R:R</th><th>Track record</th></tr></thead><tbody></tbody></table></div>
  </section>
</main>

<main id="view-categories" class="grid-1 view hidden">
  <section class="panel">
    <div class="panel-head">
      <h2>Categories <small id="categories-note"></small></h2>
      <div class="toggles" id="categories-pills"></div>
    </div>
    <div class="scroll table-scroll"><table id="categories-table"><thead><tr><th>#</th><th>Coin</th><th class="r">Price</th><th class="r">1h / 24h</th><th>Category</th><th class="r">Score</th></tr></thead><tbody></tbody></table></div>
  </section>
</main>

<main id="view-portfolio" class="grid view hidden">
  <section class="panel regime-panel">
    <div class="panel-head"><h2>Market Regime <small id="regime-note">BTC / ETH structure, breadth, macro and news</small></h2></div>
    <div id="regime"></div>
  </section>

  <section class="panel risks-panel">
    <div class="panel-head"><h2>Biggest Risks <small>what could hurt right now</small></h2></div>
    <div class="scroll" id="risks"></div>
  </section>

  <section class="panel opp-panel">
    <div class="panel-head"><h2>Top Opportunities <small id="opp-note">ranked by the AI's own analysis: BUY = every gate passed, WATCH = waiting for something specific</small></h2></div>
    <div id="opps" class="opps"></div>
  </section>

  <section class="panel avoid-panel">
    <div class="panel-head"><h2>Coins to Avoid <small>downtrends, sellers in control, dangerous news</small></h2></div>
    <div class="scroll" id="avoid"></div>
  </section>

  <section class="panel report-panel">
    <div class="panel-head"><h2>Learning Report <small>outcomes, validated rules, vetoes, missed moves</small></h2></div>
    <div class="scroll" id="learning"></div>
  </section>

  <section class="panel pos-panel">
    <div class="panel-head"><h2>Execution &amp; Positions</h2></div>
    <div class="scroll" id="positions"></div>
  </section>

  <section class="panel radar-panel">
    <div class="panel-head"><h2>Market Radar <small id="radar-note">cheap scan of every coin → shortlist → deep research</small></h2></div>
    <div id="radar-chips" class="chips"></div>
    <div class="radar-cols">
      <div><h3>Deep research queue <small>strongest this scan</small></h3><div id="radar-queue" class="scroll"></div></div>
      <div><h3>Shortlist leaders <small>top by priority</small></h3><div id="radar-short" class="scroll"></div></div>
      <div><h3>No market <small>moving, but listed on neither Coinbase nor Gate.io</small></h3><div id="radar-watch" class="scroll"></div></div>
    </div>
  </section>

  <section class="panel history-panel">
    <div class="panel-head" id="trade-history"><h2>Trade History <small>closed trades · win or loss, net of fees &amp; slippage</small></h2></div>
    <div id="history-stats" class="chips"></div>
    <div class="scroll" id="history"></div>
  </section>

  <section class="panel copy-panel">
    <div class="panel-head"><h2>Tracked Traders <small id="copy-note">data input only: they never open, size or veto a trade</small></h2><span class="muted" id="copy-status"></span></div>
    <div class="scroll" id="copy"></div>
  </section>

  <section class="panel news-panel">
    <div class="panel-head"><h2>News &amp; Politics <small>everything the app reads: official sources (tier 3) and news (tier 4)</small></h2><span class="muted" id="news-status"></span></div>
    <div id="news-feeds" class="chips"></div>
    <div class="scroll" id="news"></div>
  </section>

  <section class="panel log-panel">
    <div class="panel-head"><h2>Decision Log <small>what the brain decided and why</small></h2></div>
    <div class="scroll" id="decisions"></div>
  </section>

  <section class="panel learn-panel">
    <div class="panel-head"><h2>Post-mortems <small>one per closed trade, built from the measured outcome</small></h2></div>
    <div class="scroll" id="reflections"></div>
  </section>
</main>
```

Note the grid layout for the Portfolio view keeps all the `grid-template-areas` names used by `.regime-panel` etc. in `style.css` unchanged — only `table-panel`/`chart-panel`/`pos-panel` moved out of it into the Tokens view, which Task 11 accounts for.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "Restructure the dashboard into a Tokens/Hot/Alerts/Leaderboard/Categories/Portfolio nav shell"
```

---

### Task 11: `public/style.css` — nav, views, and new page styles

**Files:**
- Modify: `public/style.css`

- [ ] **Step 1: Add nav/view/search styles**

Append at the end of `style.css`:

```css
/* ---- nav shell */
.nav { display: flex; gap: 4px; flex-wrap: wrap; }
.nav a { color: var(--muted); text-decoration: none; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid transparent; }
.nav a:hover { color: var(--text); }
.nav a.active { color: var(--text); border-color: var(--line); background: var(--panel2); }
input.search { background: var(--panel2); border: 1px solid var(--line); color: var(--text); border-radius: 6px; padding: 5px 9px; width: 220px; }
.view.hidden { display: none !important; }
.grid-1 { display: grid; gap: 12px; padding: 12px 16px 24px; }

/* ---- Tokens: category/trending tags */
.pill.trending { color: var(--amber); border-color: rgba(245,166,35,.5); }
.cat-tags { display: inline-flex; gap: 3px; flex-wrap: wrap; }
.cat-tags .pill { text-transform: capitalize; }

/* ---- Hot page */
#hot-table .heat { display: inline-block; min-width: 80px; height: 6px; border-radius: 3px; background: var(--line); position: relative; vertical-align: middle; }
#hot-table .heat b { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--amber); }
.sig-badges { display: inline-flex; gap: 4px; flex-wrap: wrap; }

/* ---- Alerts page */
.alert-row { display: flex; gap: 10px; align-items: baseline; padding: 7px 12px; border-top: 1px solid var(--line); font-size: 12px; }
.alert-row:first-child { border-top: 0; }
.alert-row .pill.type-news { color: var(--blue); border-color: rgba(91,157,255,.5); }
.alert-row .pill.type-signal { color: var(--amber); border-color: rgba(245,166,35,.5); }
.alert-row .pill.type-trade { color: var(--green); border-color: rgba(38,166,154,.5); }

/* ---- Categories page */
#categories-pills .tog.on { color: var(--blue); border-color: var(--blue); background: rgba(91,157,255,.12); }
```

- [ ] **Step 2: Commit**

```bash
git add public/style.css
git commit -m "Add nav/view/Hot/Alerts/Categories styles for the dashboard redesign"
```

---

### Task 12: `public/app.js` — hash router and global search

**Files:**
- Modify: `public/app.js:1-13` (top of file, after existing const declarations)
- Modify: `public/app.js:345-348` (the `render` function)
- Modify: `public/app.js` end (after `connect();`)

- [ ] **Step 1: Add the router**

Insert this block right after the existing line `let latest = null;` (around line 12):

```js
/* ------------------------------------------------------------------ router */
const VIEWS = ['tokens', 'hot', 'alerts', 'leaderboard', 'categories', 'portfolio'];
function showView(name) {
  if (!VIEWS.includes(name)) name = 'tokens';
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('hidden', v !== name);
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  if (latest) renderView(name, latest);
}
function currentView() { return (location.hash || '#tokens').slice(1); }
window.addEventListener('hashchange', () => showView(currentView()));
```

- [ ] **Step 2: Render only the active view's data, and route the global search**

Change the existing `render` function:

```js
function render(s) {
  latest = s;
  renderStats(s); renderBrain(s.brain); renderTable(s); renderPositions(s); renderHistory(s.history); renderNews(s.newsFeed); renderRadar(s.radar); renderCopy(s.copy); renderDecisions(s); renderReflections(s);
}
```

to:

```js
function renderView(name, s) {
  if (name === 'tokens') renderTable(s);
  else if (name === 'hot') renderHot(s);
  else if (name === 'alerts') renderAlerts(s);
  else if (name === 'leaderboard') renderLeaderboard(s);
  else if (name === 'categories') renderCategories(s);
  else if (name === 'portfolio') { renderBrain(s.brain); renderPositions(s); renderHistory(s.history); renderNews(s.newsFeed); renderRadar(s.radar); renderCopy(s.copy); renderDecisions(s); renderReflections(s); }
}
function render(s) {
  latest = s;
  renderStats(s);
  renderView(currentView(), s);
}
```

- [ ] **Step 3: Wire the global search input**

Add at the end of the file, after `connect();`:

```js
$('#search').addEventListener('input', () => {
  const q = $('#search').value.trim();
  if (currentView() !== 'tokens') location.hash = '#tokens';
  $('#filter').value = q;
  if (latest) renderTable(latest);
});
showView(currentView());
```

- [ ] **Step 4: Manual check (no automated test harness for this vanilla client code)**

Run: `PAPER_TRADING=true npm start` (background it or run in a separate terminal), then open `http://localhost:<port>` (port from `config.port`, printed on startup) in a browser.
Expected: the page loads showing the Tokens view by default; clicking each nav link changes `location.hash` and swaps which `<main>` is visible; typing in the header search box updates the Tokens table's filter.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "Add hash-router navigation and global search to the dashboard"
```

---

### Task 13: `public/app.js` — Hot page rendering

**Files:**
- Modify: `public/app.js` (add `renderHot` near the other render functions, e.g. directly before `function renderPositions`)

- [ ] **Step 1: Add `renderHot`**

```js
function renderHot(s) {
  const tbody = $('#hot-table tbody');
  const rows = s.rows.filter((r) => r.tradable && r.hot && r.hot.available.length).slice().sort((a, b) => b.hot.total - a.hot.total).slice(0, 60);
  $('#hot-note').textContent = `${rows.length} coins with at least one live signal (volume, momentum, trending or sentiment), ranked by their combined heat`;
  const partLabel = { volume: 'RVOL', momentum1h: '1h▲', momentum24h: '24h▲', trending: 'trending', sentiment: 'sentiment' };
  tbody.innerHTML = rows.length ? rows.map((r, i) => `<tr data-sym="${esc(r.symbol)}">
    <td class="muted">${i + 1}</td><td><b>${esc(r.symbol)}</b> <span class="muted">${esc(r.name)}</span></td>
    <td class="r">${price(r.price)}</td><td class="r">${chgCell(r)}</td><td class="r ${r.rvol > 1.5 ? 'up' : ''}">${r.rvol == null ? '—' : r.rvol.toFixed(2)}</td>
    <td><span class="sig-badges">${Object.keys(r.hot.parts).map((k) => `<span class="pill good">${esc(partLabel[k] || k)}</span>`).join('')}</span></td>
    <td class="r"><span class="heat" title="${esc(Object.entries(r.hot.parts).map(([k, v]) => `${partLabel[k] || k} ${v}`).join(', '))}"><b style="width:${Math.min(100, r.hot.total * 12)}%"></b></span> ${r.hot.total}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">No coin currently has a live volume, momentum, trending or sentiment signal.</td></tr>';
}
```

- [ ] **Step 2: Wire row clicks to the chart (reusing the existing selection pattern)**

Add after the existing `$('#coins tbody').addEventListener(...)` block:

```js
$('#hot-table tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-sym]');
  if (!tr) return;
  selected = tr.dataset.sym;
  location.hash = '#tokens';
});
```

- [ ] **Step 3: Manual check**

With the server running (Task 12's manual check), click the Hot nav tab.
Expected: a table of coins with at least one of RVOL/momentum/trending/sentiment, sorted by heat descending, each row showing which signals it actually has; no fabricated score for a coin with none of these signals (it's excluded, not shown with a `0`).

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "Add the Hot page: transparent, labeled momentum/volume/trending/sentiment ranking"
```

---

### Task 14: `public/app.js` — Alerts page rendering

**Files:**
- Modify: `public/app.js` (add `renderAlerts` near the other render functions; add the type-filter click handler)

- [ ] **Step 1: Add `renderAlerts`**

```js
let alertType = 'all';
function renderAlerts(s) {
  const newsAlerts = (s.newsFeed.items || []).map((i) => ({ at: i.publishedAt, type: 'news', symbol: '*', text: `${esc(i.source)}: ${esc(i.title)}` }));
  const all = [...s.alerts, ...newsAlerts].sort((a, b) => b.at - a.at).slice(0, 200);
  const rows = alertType === 'all' ? all : all.filter((a) => a.type === alertType);
  $('#alerts-note').textContent = `${rows.length} of ${all.length} alerts (news items read every scan, plus HOT/signal/trade events)`;
  $('#alerts-list').innerHTML = rows.length ? rows.map((a) => `<div class="alert-row"><span class="muted">${ago(a.at)}</span><span class="pill type-${esc(a.type)}">${esc(a.type)}</span>${a.symbol && a.symbol !== '*' ? `<b>${esc(a.symbol)}</b>` : ''}<span>${a.text}</span></div>`).join('')
    : '<div class="empty">No alerts yet.</div>';
}
```

- [ ] **Step 2: Wire the type filter buttons**

Add after the `renderAlerts` function:

```js
$('#alert-filter').addEventListener('click', (e) => {
  const b = e.target.closest('.tog');
  if (!b) return;
  document.querySelectorAll('#alert-filter .tog').forEach((x) => x.classList.toggle('on', x === b));
  alertType = b.dataset.type;
  if (latest) renderAlerts(latest);
});
```

- [ ] **Step 3: Manual check**

Click the Alerts nav tab, then each of the All/News/Signal/Trade filter buttons.
Expected: a chronological feed, newest first; filtering narrows it by type; each row plainly shows its source type.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "Add the Alerts page: news plus HOT/signal/trade events, filterable by type"
```

---

### Task 15: `public/app.js` — AI Leaderboard page rendering

**Files:**
- Modify: `public/app.js` (add `renderLeaderboard`)

- [ ] **Step 1: Add `renderLeaderboard`**

```js
function renderLeaderboard(s) {
  const rows = s.leaderboard || [];
  $('#leaderboard-note').textContent = rows.length ? `${rows.length} live ideas this scan, ranked by composite score` : 'No coin currently has a BUY/SHORT/WATCH-worthy setup';
  const track = (h) => !h ? '<span class="muted">no closed trades yet for this setup</span>' : h.thin ? `<span class="muted">${h.n} closed (thin: needs more data)</span>` : `${h.n} closed · win rate ${(h.winRate * 100).toFixed(0)}% · avg ${h.avgPnlPct >= 0 ? '+' : ''}${(h.avgPnlPct * 100).toFixed(2)}%`;
  $('#leaderboard-table tbody').innerHTML = rows.length ? rows.map((r) => `<tr data-sym="${esc(r.symbol)}">
    <td><b>${esc(r.symbol)}</b> <span class="muted">${esc(r.name)}</span></td>
    <td><span class="pill ${r.action === 'BUY' ? 'good' : r.action === 'SHORT' ? 'bad' : 'amber'}">${esc(r.verdict || r.action)}</span></td>
    <td><span class="pill ${r.cls === 'HOT' ? 'hotc' : r.cls === 'WATCH' ? 'amber' : ''}">${esc(r.cls)}</span></td>
    <td>${r.setup ? esc(r.setup) : '<span class="muted">—</span>'}</td>
    <td class="r">${r.score}</td><td class="r">${(r.pUp * 100).toFixed(0)}%</td><td class="r">${r.ev == null ? '—' : r.ev + 'R'}</td><td class="r">${r.rr ?? '—'}</td>
    <td class="muted">${track(r.history)}</td></tr>`).join('')
    : '<tr><td colspan="9" class="empty">No live ideas right now: the AI is waiting instead of forcing a trade.</td></tr>';
}
```

- [ ] **Step 2: Wire row clicks to the chart**

```js
$('#leaderboard-table tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-sym]');
  if (!tr) return;
  selected = tr.dataset.sym;
  location.hash = '#tokens';
});
```

- [ ] **Step 3: Manual check**

Click the AI Leaderboard nav tab.
Expected: a table of today's live BUY/SHORT/WATCH ideas sorted by score, each row showing its setup's historical track record (or "no closed trades yet" / "thin" where there isn't enough data) — never a fabricated win rate.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "Add the AI Leaderboard page: live ideas joined with measured setup history"
```

---

### Task 16: `public/app.js` — Categories page rendering

**Files:**
- Modify: `public/app.js` (add `renderCategories`; extend `renderTable`'s Tokens-page category toggle to reuse the same filter state)

- [ ] **Step 1: Add shared category filter state and `renderCategories`**

```js
let categoryOn = null; // null = all; otherwise one slug ('major', 'meme-token', ..., 'uncategorized')
function renderCategories(s) {
  const cats = s.categories || { list: [], ageMs: null };
  const all = [{ slug: 'major', label: 'Major' }, ...cats.list, { slug: 'uncategorized', label: 'Uncategorized' }];
  $('#categories-note').textContent = cats.ageMs == null ? 'category data not fetched yet' : `category data refreshed ${ago(Date.now() - cats.ageMs)}`;
  $('#categories-pills').innerHTML = [{ slug: null, label: 'All' }, ...all].map((c) => `<button type="button" class="tog ${categoryOn === c.slug ? 'on' : ''}" data-slug="${c.slug ?? ''}">${esc(c.label)}</button>`).join('');
  const rows = (categoryOn ? s.rows.filter((r) => (r.category || []).includes(categoryOn)) : s.rows).filter((r) => r.tradable);
  $('#categories-table tbody').innerHTML = rows.length ? rows.map((r) => `<tr data-sym="${esc(r.symbol)}">
    <td class="muted">${r.rank}</td><td><b>${esc(r.symbol)}</b> <span class="muted">${esc(r.name)}</span></td>
    <td class="r">${price(r.price)}</td><td class="r">${chgCell(r)}</td>
    <td class="cat-tags">${(r.category || []).map((c) => `<span class="pill">${esc(c.replace(/-/g, ' '))}</span>`).join('')}</td>
    <td class="r">${r.score == null ? '—' : r.score}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">No tradable coin in this category.</td></tr>';
}
```

- [ ] **Step 2: Wire the pill clicks**

```js
$('#categories-pills').addEventListener('click', (e) => {
  const b = e.target.closest('.tog');
  if (!b) return;
  categoryOn = b.dataset.slug || null;
  if (latest) renderCategories(latest);
});
$('#categories-table tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-sym]');
  if (!tr) return;
  selected = tr.dataset.sym;
  location.hash = '#tokens';
});
```

- [ ] **Step 3: Manual check**

Click the Categories nav tab, then a few pills (Major, Meme, DeFi, Uncategorized).
Expected: the table filters to coins tagged with that category; a coin matching none of the fetched categories shows under "Uncategorized", never silently hidden or mis-tagged; the note line shows how stale the category fetch is (or that it hasn't run yet).

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "Add the Categories page: pill filters over CoinGecko category tags"
```

---

### Task 17: Full manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

Run: `PAPER_TRADING=true npm start`
Expected: log line `Dashboard: http://localhost:<port> (PAPER_TRADING=true, paper capital $...)`.

- [ ] **Step 2: Walk every nav tab in a browser**

Open `http://localhost:<port>`. For each of Tokens, Hot, Alerts, AI Leaderboard, Categories, Portfolio:
- Confirm the view shows real data from the running engine (not a placeholder), or an explicit "nothing yet" / staleness message when the engine hasn't populated that data yet (e.g. categories before the first 6-hourly fetch completes, alerts before any HOT/signal/trade event has fired).
- Confirm clicking a row elsewhere (Hot/Leaderboard/Categories) jumps to the Tokens view with that coin's chart selected.
- Confirm the header search box filters the Tokens table and switches to the Tokens tab from any other tab.

Expected: no console errors (check the browser dev tools console); every page either shows live data or a clearly-labeled empty/stale state — never an invented number.

- [ ] **Step 3: Run the full automated test suite one more time**

Run: `npm test`
Expected: PASS (all suites)

- [ ] **Step 4: Commit (if any fixes were needed during the smoke test)**

```bash
git add -A
git commit -m "Fix issues found during dashboard smoke test"
```

(Skip this commit if the smoke test found nothing to fix.)

---

## Self-review notes

- **Spec coverage:** Tokens (Task 10/16 table reuse), Search (Task 12), Hot (Task 2 + 13), Alerts (Task 6/7/9 + 14), AI Leaderboard (Task 4/8 + 15), Categories (Task 1/3/8 + 16), Portfolio carry-over (Task 10), staleness labeling (categories `ageMs`, hot score's `available` list, leaderboard's `thin`/`null` history, alerts' own timestamps) are each covered by a task above. Non-goals (no risk/engine logic touched, no build step, no new trading controls) hold throughout — every change is additive to `snapshotForUi()`/new endpoints/new pure files, and no task touches `guardrails.js`, `risk.js`, sizing, or stop logic.
- **No placeholders:** every step above shows the exact code, exact file/line target, and exact command; nothing deferred to "add validation" or "similar to Task N".
- **Type/name consistency:** `dashboard.categoriesFor`/`pushAlert`/`buildLeaderboard`/`hotScore` are defined once (Task 2) and called with the same names and argument shapes in every later task (Tasks 6-8). `state.categories`/`state.alerts`/`state.prevLiveSymbols`/`state.lastActiveRuleCount` are declared once (Task 5) and only ever read/written under those exact names afterward.
