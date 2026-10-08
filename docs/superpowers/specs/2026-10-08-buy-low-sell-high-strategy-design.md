# Buy-Low/Sell-High as a first-class strategy — design

## Problem

The Brain (`src/brain.js`) currently frames every opportunity as LONG vs SHORT (directional). Several of its existing LONG setups — `trend_pullback`, `support_bounce`, `liquidity_sweep`, `trend_reversal` — are really mean-reversion ("buy low, sell high") plays, but they're scored with the same direction logic as pure trend-following setups (`breakout_retest`, `momentum_continuation`, `relative_strength`, `trend_continuation`), which rewards trend structure already pointing up. That's the wrong lens for a mean-reversion entry, where temporary weakness, an oversold bounce, or a tested support zone is the opportunity, not a penalty.

Nothing in the codebase separately tracks or backtests "buy-low/sell-high" as its own strategy family. Backtests (`scripts/backtest-brain.mjs`, `scripts/research-long.mjs`) and the journal (`src/learning.js`) group results by `side:setup` only.

## Goal

Make buy-low/sell-high a third, independent, first-class evaluation path alongside directional LONG and SHORT — not a guess the AI is forced to make between "long" or "short," and not a sub-case buried inside the LONG evaluation. It must be:
- Detected on its own terms: oversold/undervalued conditions, support/demand zones, range lows, pullbacks in healthy trends, temporary relative weakness, reversal/mean-reversion setups, good R:R entry prices.
- Scored on its own terms: direction quality means "is this an attractive discount with buyers returning," not "is the trend already up."
- Exited on its own terms: sell into strength/resistance/a weakening setup, not only on a confirmed downtrend break.
- Journaled, backtested, and reported as its own category, compared side-by-side with directional long/short, every time a new strategy is tested.
- Built with every existing risk limit, position limit, stop rule, circuit breaker, and sizing rule completely unchanged.

## Non-goals

- No change to position sizing, the 1% risk model, stop-distance caps, the 6-position cap, circuit breakers, `guardrails.js`, or the EV/R:R/composite-floor math. The buy-low path reuses all of it as-is.
- No SHORT-side mirror ("sell-high" as a short entry). Buy-low/sell-high is inherently "enter cheap, exit dear" on the long side; the existing directional SHORT path already covers overbought/resistance shorts (unexecuted under `allowShortTrades=false`, journaled only).
- No new database schema/migration. The strategy tag is carried as a plain string through the existing JSON `prediction` column and in-memory position context.

## Architecture

### 1. Setup detection split (`src/brain.js`)

`detectLongSetups` is trimmed to trend-following setups only:
- `breakout_retest`, `range_breakout`, `momentum_continuation`, `relative_strength`, `trend_continuation`, and discovered patterns (`discovery.js`).

A new `detectBuyLowSetups(T, ctx)` takes over the setups that are inherently mean-reversion, moved out of `detectLongSetups` unchanged in their trigger/level/stop/target logic (they already tolerate downtrends and ranges — that's what makes them buy-low setups):
- `trend_pullback` → pullback in a healthy trend, or a developing reversal when structure is improving.
- `support_bounce` → a tested support or range low with a buying response, in any market.
- `liquidity_sweep` → a liquidity sweep reclaim, qualifying even when the larger trend is bearish.
- `trend_reversal` → an early reversal (structure improving off a low).

Each opportunity is now classified by exactly one detector (trend-following or buy-low), never both. This avoids double-counting the same coin against the 6-position cap and avoids ever entering the "same" opportunity twice under two labels.

### 2. A `strategy` parameter on `evaluate()`

`evaluate(side, inp, T)` becomes `evaluate(side, inp, T, strategy = 'trend')`. For `side === 'long'` it accepts `strategy = 'buy_low'` as well; `side === 'short'` always uses `'trend'` (directional short, unchanged).

When `strategy === 'buy_low'`:
- **Setup source**: `detectBuyLowSetups(T, ctx)` instead of `detectLongSetups`.
- **Direction scoring**: a distinct family blend tuned for mean-reversion instead of trend-following:
  - `location` (new): how attractive the discount is — distance below the recent range/support/EMA, normalized by ATR. Replaces the trend-following `structure` family's reward for an already-up trend.
  - `flow`: unchanged calculation (demand returning — flow shift, absorption, control) but still weighted heavily, since "buyers returning" is the core evidence.
  - `reversalStrength` (new): candle rejection quality, sweep-reclaim quality, and the count of weaker confirmations agreeing — this is the "why now" evidence that distinguishes a bought dip from a falling knife.
  - `momentumExhaustion` (new, replaces the trend-following `momentum` family): rewards oversold RSI turning up / MACD curling / the decline decelerating, instead of rewarding momentum that is already strongly positive.
  - Relative weakness vs BTC/market, which the trend-following `relStrength` family penalizes, is treated as neutral-to-favorable here (buying weakness is the point) rather than scored as a direction penalty.
- **Vetoes stay identical**: severe regime, catastrophic news, illiquid book, dead market (not enough volatility to cover costs), no valid stop, poor R:R, low EV, low composite, no setup, no why-now, and — importantly — the existing "strong 4h downtrend / heavy 1h selling with no reversal evidence" veto is kept as-is. It doesn't conflict with buy-low: every buy-low setup only fires when reversal evidence (demand returning, a candle rejection, a sweep reclaim) already exists, so a real falling knife with no such evidence still gets vetoed exactly as today.
- **Composite floor, EV/R:R minimums, stop-shaping, empirical probability model**: all identical to the trend-following path. No separate, looser bar for buy-low.
- Output gains a `strategy: 'trend' | 'buy_low'` field (and `'trend'` for short), carried straight through — no derivation from setup name, no lookup table.

### 3. `decide()` picks the best long candidate

```
L  = evaluate('long', inpL, T, 'trend')
BL = evaluate('long', inpL, T, 'buy_low')
longPrimary = (BL.action === 'BUY' && (L.action !== 'BUY' || BL.score > L.score)) ? BL : L
```
(and, when neither is a BUY, whichever has the higher composite score is reported as the long candidate for WATCH/alt display — matching today's "the better-supported side is the one reported" philosophy applied across three paths instead of two.)

The existing high-conviction wide-stop re-plan (today keyed to `L`) is generalized to run against whichever of `L`/`BL` was chosen as `longPrimary`.

SHORT (`S`) is evaluated exactly as today and compared against `longPrimary` using the existing tie-break logic (SHORT wins only when `longPrimary` isn't a BUY and SHORT's direction score clears it by the existing margin).

The returned decision exposes `buyLow: stripSide(BL)` alongside the existing `long`/`short`/`alt` fields, so callers (dashboards, logs, backtests) can always see all three evaluations for a coin, not just the winner.

### 4. Strategy-aware exits (`manage()`)

`manage(pos, ta, price, strategy)` gains a `strategy` parameter (passed by the engine from `pos.ctx.brain.strategy ?? 'trend'`). For `strategy === 'trend'`, behavior is byte-for-byte unchanged (1h structure broke / 4h+1h dead).

For `strategy === 'buy_low'`, the same invalidation checks apply (the bought thesis failing is still a SELL), plus a new check: **sell into strength** — when price has reached the resistance/target zone and shows stalling or rejection there (a bearish candle, supply taking control on the 1h or 15m), exit even without a full downtrend confirmation. This matches "SELL into strength, resistance, or when the setup weakens" rather than waiting for the trend-following exit condition, which may never fire for a mean-reversion trade that simply ran out of room.

This sits alongside, and does not replace, the existing partial-take-profit (`target_partial`, `resistance_partial`), Chandelier trailing stop, and loss-side `downtrend_exit`/`momentum_reversal` rules in `src/exits.js`/`src/engine.js`, none of which change.

### 5. Journal and position tagging (`src/engine.js`)

- `prediction.strategy = d.strategy` is added next to the existing `prediction.setup` at trade-open time (`tryEnter`). No schema change — it's one more key in the existing JSON column.
- `pos.ctx.brain` already stores the full decision `d` (which now includes `strategy`), so no separate position field is needed; `manage()` is called with `pos.ctx?.brain?.strategy ?? 'trend'`.
- Log lines that currently say `LONG: ...` gain the strategy tag where it's useful for operators to distinguish at a glance (e.g. the per-scan summary line), without changing the underlying `BUY`/`SHORT` action semantics anywhere else in the engine (position opening, sizing, and guardrails code is untouched — it only ever looks at `action`, never `strategy`).

### 6. Backtests and research scripts

- `scripts/backtest-brain.mjs`: the per-hour replay loop adds a third evaluation (`dec._both.buyLow`) alongside `long`/`short`. The existing `group(cands, (r) => ...)` reporting adds a grouping by `strategy` (not just `side:setup`), so every backtest run prints buy-low/sell-high performance (win rate, avg R, reach-R stats) directly comparable to directional long and short in the same report.
- `scripts/research-long.mjs`: same addition — the long-side research loop evaluates both `trend` and `buy_low` and reports them as separate rows.
- `src/learning.js`: counterfactual/exploration journaling already records whatever decision object it's given; since `strategy` rides along on that object, its existing per-setup grouping naturally extends to show strategy — the report helper that lists `byKind`/buckets picks up `strategy` as an additional grouping key next to the existing `setup`/`side` keys.

## Risk/compatibility check against CLAUDE.md

- Position sizing formula, 1% risk cap, 30% position cap, 6-position cap, circuit breakers, 4% stop cap, fee/slippage accounting: all reused unmodified by both paths — `guardrails.js` is never touched.
- Long-only execution (`allowShortTrades=false`) is unaffected; buy-low only ever proposes long entries.
- Mandatory candle confirmation, fresh-price re-check, and the 1m confirmation logic in `tryEnter` apply identically regardless of which strategy produced the BUY decision, since they operate on the shared `d.entry`/`d.stop`/`d.target`/`d.entryZone` fields that both paths populate the same way.
- Structured self-learning rules remain per feature-bucket and still move score by at most ±8 points and never touch risk limits — the `strategy` tag only adds a grouping dimension to reporting, it does not change what the learning rules are allowed to do.

## Open implementation details (left for the plan, not architectural)

- Exact numeric weights/thresholds for the new `location`, `reversalStrength`, and `momentumExhaustion` families (analogous to how existing family weights like `dirW.structure = 0.32` were tuned) — these will mirror the existing code's style (weighted averages of normalized indicators, clamped to [-1, 1]) and can be adjusted during implementation/backtesting without changing the architecture above.
- Exact "stalling at resistance" threshold in the buy-low exit check (ATR distance to resistance, which candle/flow conditions count as rejection) — implemented in the same style as the existing `manage()` checks.
