### Permanent Reference File: `CLAUDE.md`

Save this content as `CLAUDE.md` in the root folder of your project (alongside `package.json`):

```markdown
# CLAUDE.md — Project Rules, Architecture & Execution Blueprint

## Architecture & Hard Constraints
- Local Deployment: Strictly at http://localhost:4000. DO NOT create Vercel or cloud deployment files.
- Single Environment File: Read credentials ONLY from one `.env` file in the project root. Never create `.env.local` or `.env.example`.
- Hard Safety Switch: Explicit `PAPER_TRADING=true` required. Strictly paper trading with $2,000 USD virtual capital. Live order-placement functions are forbidden. Read-only exchange data allowed.
- Dynamic Universe: The 100 largest cryptocurrencies by market cap that are actually tradable (listed on Coinbase USD; stablecoins and wrapped/staked tokens excluded). CoinGecko primary, CoinMarketCap secondary.

## Dual-Brain Architecture & Data Hierarchy
- Data Hierarchy: Direct exchange feed > Specialized derivatives (Coinglass) > Official macro/gov (FRED/Congress) > Reputable news & on-chain. Timestamp and provenance required for all signals. No duplicate counting across aggregators.
- Research Brain: LLM outputs structured JSON signals ONLY across multi-timeframe data (1d, 4h, 1h, 15m, 5m). Evaluates independent evidence confluence and uses probabilistic phrasing.
- Execution Engine: Minimal local latency evaluation upon receiving live 1m market ticks without waiting for LLM API calls.
- Continuous Loop: Scan -> Validate -> Analyze -> Candidate Signal -> Candle Confirm -> Risk Filter -> Enter -> Monitor -> Trail Profit -> Exit -> Calculate Net P&L -> Post-Mortem -> Update Lessons -> Resume.

## Risk Management & Safety Limits
- Default State: 100% Cash (Long-only for v1).
- Entry Confirmation: Candle confirmation required before entering any setup.
- Position Limits: Max 25%–30% portfolio equity per trade ($500–$600); max 3 active positions.
- Risk & Exit: Mandatory risk stop-loss (-2.5% to -4%). Dynamic trailing profit mechanism. BTC 1h regime must be bullish. Min R:R ratio >= 2.5:1. Confluence score >= 80/100.
- Circuit Breakers: -5% daily equity loss halts trading for the day. 3 consecutive loss days freeze execution until manual review. 3 single-day losses or 2 losses in 60 mins force a 3-hour freeze. 2-hour lockout on stop-loss hits.
- Execution Realism: Subtract 0.10% fee and 0.05% slippage per trade.

## Structured Self-Learning (Wins & Losses)
- Mandatory post-mortem reflection after EVERY trade (both winning and losing trades).
- Track recurring patterns and adjust future signal confidence based on historical results in Supabase.
- The self-learning system must NEVER automatically alter core risk parameters or circuit breakers.

## Database Tables (Supabase)
`portfolio`, `top_100_coins`, `trade_logs`, `market_signals`, `trade_reflections`, `tracked_traders`

## Copy Trading (Hyperliquid, paper only)
- Sources: Hyperliquid public leaderboard + info/WebSocket API (read-only, no keys, no order/signing endpoints). Zerion (on-chain wallets) is the planned second source.
- Win-rate floor is HARD: only traders with a verified win rate >= 75% are ever tracked; >= 80% ranks first. A "trade" is one closing order (fills grouped by order/TWAP id) net of fees.
- Extra qualification (protects against inflated win rates): >= 30 closed trades, >= 7 days of history on >= 5 active days, profit factor >= 1.5, positive net P&L, not bot-like (<= 40 closes/day), active in the last 14 days, account >= $10k, open positions not underwater by more than 10% of the account.
- Mirroring: entries, adds, partial exits, full exits and flips follow the leader. Size = leader's % of their account applied to our equity, capped at 30%. Skip if our price is more than 1% worse than the leader's fill, or the fill is more than 120s old (exits are never skipped for age).
- Applies to copies: circuit breakers, shared max 3 open positions, 30% size cap, fresh-data check (10s), fees + slippage, 2h asset cooldown after a stop, hard 4% protective stop, post-mortem after every trade. Shorts are allowed for copied trades (paper, 1x, no leverage). The BTC-regime / confluence / R:R filters apply to the LLM strategy only.
