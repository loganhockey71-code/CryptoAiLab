# Token-discovery dashboard redesign — design

## Problem

The current UI (`public/index.html` + `app.js` + `style.css`, served by `src/server.js`) is a single operational dashboard: stats bar, one big coin table, a chart, positions, and panels for radar/funnel/news/manual-review. It has no browsing/discovery surface — no dedicated search, no "what's hot right now," no alerts feed, no ranked AI trade ideas, no sector/category filtering.

## Goal

Add a fomo.family-style token-discovery interface with six pages — **Tokens, Search, Hot, Alerts, AI Leaderboard, Categories** — polished, dark, data-dense, built entirely on real data this project already computes or can cheaply fetch through its existing, rate-limited CoinGecko client. Nothing is invented: every signal that can't be computed from real data is explicitly labeled unavailable/stale rather than faked.

## Non-goals

- No change to the trading engine, risk limits, position sizing, stops, or circuit breakers. This is a read-side (presentation) change only; `/api/state`'s existing fields keep their meaning, they only gain new ones.
- No new trading controls beyond what exists today (the manual-review clear button).
- Paper trading stays paper trading; nothing here touches order placement.
- No framework/build-step migration (decided: stay vanilla JS/HTML/CSS, no React/bundler).
- No mobile-specific redesign — this remains an operator dashboard, viewed at desktop widths like today.

## Architecture

### Stay single-page, add client-side routing

`public/index.html`/`app.js` becomes a small hash-router SPA: a persistent header (stats bar, global search, nav tabs) and a content area that swaps between seven views — the six new pages plus a **Portfolio** tab that carries over today's dashboard content (positions, equity/P&L, gate/circuit-breaker status, radar/funnel pipeline, manual-review banner) essentially unchanged. One Express static server, one `/api/state` snapshot + `/api/stream` SSE connection as today — navigating tabs does not reconnect the stream or lose the live feed, it only changes what's rendered from the same in-memory snapshot. The existing `/api/candles/:symbol` endpoint and chart component (`lightweight-charts`) are reused for any page that shows a price chart (Tokens detail view, Hot detail view).

### New data the server computes (additive to `snapshotForUi()` in `src/engine.js`)

1. **Trending flag** — `state.trending` (CoinGecko trending ids, already fetched in `universe.js` via `cgTrending`) is already computed but not exposed; add it to the snapshot and tag matching rows.
2. **Categories** — new periodic fetch in `universe.js`: for a fixed small set of CoinGecko category slugs (e.g. `meme-token`, `decentralized-finance-defi`, `artificial-intelligence`, `gaming`, `layer-1`, `real-world-assets-rwa`, plus a "Major" bucket from existing rank data), call `/coins/markets?category=<slug>` through the existing rate-limited, priority-queued `cgFetch` lane, on a multi-hour cadence (cheap: one call per category, not per coin). Cache which of our tracked `coingecko_id`s fall in each category. Expose `categories: { slug: { label, symbols }, ... }` plus a `category` array per coin row (coins matching none of the fetched categories are labeled "Uncategorized," never guessed). The fetch's own age is exposed so the UI can label it stale if a refresh fails.
3. **Alerts** — a new capped ring buffer `state.alerts` (plain array, most-recent-first, capped ~300), appended to at existing points in `engine.js` where something notable already happens and is already logged via `logDecision`: a coin entering `HOT`, a `BUY`/`SHORT` decision firing, a position opened or closed, an exploration trade, a learned-rule adjustment applying. Each entry: `{ at, type: 'news'|'signal'|'trade', symbol, text, severity }`. Exposed in the snapshot (most recent N) plus a small `/api/alerts?before=<ts>` endpoint for paging further back than the live snapshot carries. `state.newsFeed.items` (already fetched) is merged in as `type: 'news'` alerts rather than duplicated.
4. **AI Leaderboard rows** — computed from `state.decisions` (this scan's live decisions, already ranked, already carrying `score`/`pUp`/`ev`/`rr`/`setup`), each row enriched with that setup's historical record pulled from already-closed paper trades (`state.recentClosed`, already grouped by querying each trade's stored `prediction.setup`) — win rate and average R per setup, shown with its sample size, or explicitly labeled "thin history (n=N)" below the Brain's own existing confidence threshold, exactly matching how `brain.js` already talks about data confidence. No new statistics engine: this is a join of two things the engine already has.

### Pages

- **Shared header**: stats bar (reused from today), a persistent search input, and the seven nav tabs. The search input does a live client-side filter over the snapshot's `rows` by symbol/name (all rows are already pushed to the client every scan — no new endpoint needed), jumping to a token detail panel (price, chart, signal, category, recent alerts for that symbol) reused across Tokens/Hot/Leaderboard.
- **Tokens**: the full sortable table of `rows`, with filters for venue (Coinbase/Gate.io), tradable/excluded, category, and signal/class — built by extending the existing table-rendering code in `app.js` rather than a rewrite.
- **Hot**: ranked by a transparent, labeled blend of what's actually available per coin — relative volume (`rvol`), 1h/24h momentum, the new trending flag, and sentiment score where present (`sentimentCount` already tracks how much sentiment data backs it) — never collapsing missing inputs into a fabricated single number; a coin with no sentiment data shows "sentiment: no data," not a zero.
- **Alerts**: the `alerts` feed, filterable by type (news/signal/trade), newest first, each entry showing its source plainly.
- **AI Leaderboard**: the leaderboard rows above, default-sorted by composite score, columns for direction/timing/geometry, pUp, EV, net R:R, setup, and historical win-rate/avgR (or thin-history label). If the buy-low/sell-high strategy work (separately specced) ships later, its `strategy` tag on each decision becomes just another column here with no leaderboard changes needed.
- **Categories**: a pill/tab bar (Major, Meme, Altcoin, AI, DeFi, Gaming, RWA, Uncategorized) that filters the same Tokens table view by the new `category` tag — not a separate data table, a filter mode on Tokens.
- **Portfolio** (carried over): today's stats/positions/radar-funnel/manual-review content, moved into its own tab essentially as-is.

## Staleness/labeling convention

Every new data source follows the same convention the current health/`stale` row fields already use: an explicit age (`categoriesAgeMs`, `alerts[].at`, trending refresh time) and an explicit "unavailable"/"stale" badge when a fetch has failed or aged out, shown in the UI rather than silently falling back to a guess. No page ever invents a trending rank, a sentiment score, or a backtest number that wasn't actually computed.

## Risk/compatibility check

- `/api/state` and `/api/stream` keep every existing field; this only adds new ones (`trending`, `categories`, `alerts`, leaderboard rows) and moves nothing the engine or risk code reads.
- `universe.js`'s new category calls go through the same priority-queued, rate-limited `cgFetch` used for every other CoinGecko call — no separate rate budget to manage.
- No change to `guardrails.js`, sizing, stops, circuit breakers, or `PAPER_TRADING=true`.

## Open implementation details (left for the plan)

- Exact CoinGecko category slugs to use and the "Major" bucket's cutoff (likely top-N by rank, reusing the existing `coin.rank`).
- Exact Hot-page weighting/display of its blended signals (styled like the Brain's own "labelled, never invented" reasoning, not a hidden formula).
- Which specific `engine.js` call sites get an `alerts.push(...)` line (enumerated during implementation against the current `logDecision` call sites).
- Visual design details (pill colors, badge styles, table density) within the existing `style.css` dark theme tokens.
