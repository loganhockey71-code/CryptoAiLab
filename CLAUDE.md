### Permanent Reference File: `CLAUDE.md`

Save this content as `CLAUDE.md` in the root folder of your project (alongside `package.json`):

```markdown
# CLAUDE.md — Project Rules, Architecture & Execution Blueprint

## Architecture & Hard Constraints
- Local Deployment: Strictly at http://localhost:4000. DO NOT create Vercel or cloud deployment files.
- Single Environment File: Read credentials ONLY from one `.env` file in the project root. Never create `.env.local` or `.env.example`.
- Hard Safety Switch: Explicit `PAPER_TRADING=true` required. Strictly paper trading with $2,000 USD virtual capital. Live order-placement functions are forbidden. Read-only exchange data allowed.
- Dynamic Universe (funnel): Stage 0 RADAR sweeps every coin CoinGecko lists (~8,500) every 4h on cheap data only (rate-limit paced, resumes after a 429); tradable coins are refreshed far more often with batched calls (shortlist + positions every 10 min, the rest every 60 min) and a coin seen ripping is promoted to analysis immediately; the 5-minute scan never waits for the sweep. Coinbase order-book spread/depth is context for the Research Brain only (price, market cap, volume, 1h/24h/7d change, volume anomalies). Only coins with an online Coinbase USD market (~390; stablecoins and wrapped/staked tokens excluded) are tradable; the rest are watch-only and never researched or entered. Stage 1 SHORTLIST (150, range 100-300) of the highest cheap-priority tradable coins gets candle analysis every scan; the rest every 3rd scan and on first sight, so any coin can move up. Stage 2 DEEP RESEARCH (20, range 10-30) of the strongest candidates only: derivatives, news, macro, smart money, history and the AI. No Top-100 rank or trending flag is needed. Priority never lowers a requirement. Illiquid (< $1M 24h volume), tiny (< $5M cap), wash-trading-looking, thin-volume-spike and insufficient-data coins are rejected. CoinGecko primary, CoinMarketCap validates the top 300.

## Dual-Brain Architecture & Data Hierarchy
- Data Hierarchy: Direct exchange feed > Specialized derivatives (Coinglass) > Official macro/gov (FRED/Congress) > Reputable news & on-chain. Timestamp and provenance required for all signals. No duplicate counting across aggregators.
- Research Brain: LLM outputs structured JSON signals ONLY across multi-timeframe data (1d, 4h, 1h, 15m, 5m). Evaluates independent evidence confluence and uses probabilistic phrasing.
- Execution Engine: Minimal local latency evaluation upon receiving live 1m market ticks without waiting for LLM API calls.
- Continuous Loop: Scan -> Validate -> Analyze -> Candidate Signal -> Candle Confirm -> Risk Filter -> Enter -> Monitor -> Trail Profit -> Exit -> Calculate Net P&L -> Post-Mortem -> Update Lessons -> Resume.

## Risk Management & Safety Limits
- Default State: 100% Cash (Long-only for v1). 1x only, never any leverage. Holding time is flexible (minutes, hours or 1-3 days) while the thesis remains valid.
- Entry Confirmation: Candle confirmation required before entering any setup. Price freshness: candidate evaluation accepts a price up to 30s old; immediately before any paper entry the price is re-fetched and must be <= 10s old and within 0.5% of the confirmed price, otherwise the entry is rejected. An AI outage/formatting failure never rejects a setup: models are retried (with stricter JSON instructions) and the coin is re-tried later.
- Position Sizing: risk-based, no minimum size. `size_usd = (equity x 1%) / (stop% + estimated fees+slippage%)`, never above the 30% per-position cap; max 3 active positions. A stopped-out trade loses at most ~1% of equity including costs.
- Risk & Exit: Mandatory stop-loss by coin: BTC 1.5-2.0%, ETH 2.0-2.5%, Top 20 2.5-3.0%, Top 21-50 3-4%, Top 51-100 and memes 4%. NO stop is ever wider than 4% on any pair or chain, and a stop is never widened after entry. Take-profit zone by tier: BTC 4-6%, ETH 5-8%, Top 20 6-10%, Top 21-50 8-15%, Top 51-100 10-20%, memes 10-25%+; reaching it banks a 50% partial and moves the stop to breakeven (tighten only). The remainder runs on a Chandelier trailing stop (highest high - k x ATR(15m), k = 3.0 / 2.5 / 2.0 / 1.5 as profit passes 0 / 1R / 2R / 3R, tighter on fading momentum or a non-bullish BTC regime). `momentum_reversal` needs structure (2 consecutive lower 1m lows on declining volume, or 2 closes below the 21 EMA with RSI < 45); one red candle never exits a winner. Targets are never forced. Holding 1-2 days is normal: the Research Brain picks a 1-48h horizon, and any position held more than ~6h (the default) ignores 1-minute noise: no `momentum_reversal`/`regime_exit`, a wider 1h-ATR Chandelier trail, and it only exits early on a broken 1h trend (after 1h open) or its stop/trail. BTC 1h regime must be bullish. Min R:R ratio >= 2.5:1. Confluence score >= 80/100.
- Circuit Breakers: -5% daily equity loss halts trading for the day. 3 consecutive loss days freeze execution until manual review. 3 single-day losses or 2 losses in 60 mins force a 3-hour freeze. 2-hour lockout on stop-loss hits.
- Execution Realism: Subtract 0.10% fee and 0.05% slippage per trade.

## Structured Self-Learning (Wins & Losses)
- Mandatory post-mortem reflection after EVERY trade (both winning and losing trades).
- Track recurring patterns and adjust future signal confidence based on historical results in Supabase.
- The self-learning system must NEVER automatically alter core risk parameters or circuit breakers.

## Database Tables (Supabase)
`portfolio`, `top_100_coins`, `trade_logs`, `market_signals`, `trade_reflections`, `tracked_traders`, `trade_exit_events` (one row per exit leg, partial or final: price, size_usd, realized_pnl, exit_reason, iso_timestamp, FK to `trade_logs`; migration in `supabase/migrations/`)

## Copy Trading (Hyperliquid, paper only)
- Sources: Hyperliquid public leaderboard + info/WebSocket API (read-only, no keys, no order/signing endpoints). Zerion (on-chain wallets, key in `.env` as `ZERION_API_KEY`) is the second source; both run at the same time and share the same rules.
- Win-rate floor is HARD: only traders with a verified win rate >= 75% are ever tracked; >= 80% ranks first. A "trade" is one closing order (fills grouped by order/TWAP id) net of fees.
- Extra qualification (protects against inflated win rates): >= 30 closed trades, >= 7 days of history on >= 5 active days, profit factor >= 1.5, positive net P&L, not bot-like (<= 40 closes/day), active in the last 14 days, account >= $10k, open positions not underwater by more than 10% of the account.
- Mirroring: entries, adds, partial exits, full exits and flips follow the leader. Size = leader's % of their account applied to our equity, capped at 30%. Skip if our price is more than 1% worse than the leader's fill, or the fill is more than 120s old (exits are never skipped for age).
- Applies to copies: circuit breakers, shared max 3 open positions, 30% size cap, fresh-data check (10s), fees + slippage, 2h asset cooldown after a stop, hard 4% protective stop (may be set wider for a specific trade, absolute maximum 7%), post-mortem after every trade. Shorts are allowed for copied trades (paper, 1x, no leverage). The BTC-regime / confluence / R:R filters apply to the LLM strategy only.

## Per-Trader Loss-Streak Ladder (all copy sources)
Counts consecutive losing copies of the SAME trader; any win resets it. Exits/mirrored closes are never blocked, only new entries and adds.
- 1 loss: keep copying. 2 in a row: status PAUSED for 3h and an immediate re-score. 3 in a row: pause 24h and re-score the trader (must still qualify). 4 in a row: stop copying until manual review. 5+: removed from the active pool (same manual release needed).
- Derived from closed trades in Supabase, so it survives restarts. Operator release: dashboard "release" button (`POST /api/traders/release`), which clears the streak and forces a re-score.
- Thresholds live in `config.copy.loserStreak`; it is a risk rule, so self-learning must never change it.

## On-chain Copy Trading (Zerion, paper only)
- Discovery: GeckoTerminal trending pools on eth/base/arbitrum/bsc/solana -> wallets trading them (plus any in `ZERION_WATCH_WALLETS`). Scoring + live detection: Zerion decoded swaps. Prices/liquidity: DexScreener.
- A "trade" is one SELL of a non-stable, non-major token whose purchase was seen in the window (average-cost USD P&L net of gas). Sells without a known basis (airdrops, pre-window buys) are ignored, never counted as wins.
- Same qualification as Hyperliquid (win rate >= 75% hard floor, >= 80% preferred, plus trade count, history, profit factor, bot and underwater checks).
- Copy only into tokens we could exit: liquidity >= $200k, 24h volume >= $100k, pair age >= 3 days. Long-only (spot). Skip entries detected more than 300s late or more than 1% worse than the leader's price; exits are never skipped for age.
- Same position cap (max 3 across ALL sources), 30% size cap, circuit breakers, 4% hard stop, fees + slippage and post-mortems as every other trade.

## News, Politics & Regulation (read every scan, shown in the News & Politics panel)
- Tier 3 (official): White House presidential actions, Federal Register executive orders, Federal Reserve press releases + speeches, SEC and CFTC press releases, Congress.gov bills (crypto, tariffs, sanctions, securities, banking vocabulary), FRED macro series.
- Tier 4 (news / unofficial): CoinDesk, Cointelegraph, BBC World, NPR Politics, CNBC Markets, Google News (tariffs/sanctions/Fed/executive orders/war/election), and an UNOFFICIAL Truth Social mirror (trumpstruth.org). X/Twitter is not covered (no free API).
- Political items are market-wide context for the LLM Research Brain only (counted under macro_gov). They never trigger a trade, and copy trading ignores them.

## Immutable Guardrail Layer (`src/guardrails.js`)
Every entry (strategy and copy) goes through `guard.finalizeEntry()` and every stop change through `guard.keepStopTight()`. The module's limits are deep-frozen copies of `config.risk`; strategy code can propose stops/sizes but cannot exceed the 1% risk cap, the 4% stop cap, the 30% position cap, or the circuit breakers. Self-learning never touches it.
