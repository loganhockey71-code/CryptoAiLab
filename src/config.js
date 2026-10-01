import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The ONE .env file, always resolved from the project root.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

// Hard paper-only safety switch: refuse to start unless explicitly enabled.
if (process.env.PAPER_TRADING !== 'true') {
  console.error('FATAL: PAPER_TRADING=true must be set in .env. This app is paper-trading only; refusing to start.');
  process.exit(1);
}

const env = (k) => {
  const v = process.env[k];
  return v && !v.startsWith('your_') ? v : null; // placeholders count as "not set"
};

export const config = {
  root,
  port: Number(process.env.PORT) || 4000,
  paperTrading: true,
  keys: {
    supabaseUrl: env('SUPABASE_URL'),
    supabaseKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    gemini: env('GEMINI_API_KEY'),
    openrouter: env('OPENROUTER_API_KEY'),
    coingecko: env('COINGECKO_API_KEY'),
    coinmarketcap: env('COINMARKETCAP_API_KEY'),
    coinglass: env('COINGLASS_API_KEY'),
    etherscan: env('ETHERSCAN_API_KEY'),
    congress: env('CONGRESS_KEY'),
    fred: env('FRED_API_KEY'),
    zerion: env('ZERION_API_KEY'),
    watchWallets: (env('ZERION_WATCH_WALLETS') || '').split(',').map((a) => a.trim()).filter(Boolean),
  },
  models: {
    // tried in order; one congested or retired model must not take the Research Brain offline
    gemini: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest'],
    openrouter: env('OPENROUTER_MODEL') || 'google/gemini-3.5-flash',
  },
  // Deterministic risk constants. The self-learning system must never write to these.
  risk: Object.freeze({
    startingCapital: 2000,
    minPositionPct: 0.25,
    maxPositionPct: 0.30,
    maxOpenPositions: 3,
    stopMinPct: 0.025,
    stopMaxPct: 0.04,
    minRR: 2.5,
    minConfluence: 80,
    dailyLossCapPct: 0.05,
    freezeHours: 3,
    freezeStopLossesPerDay: 3,
    consecutiveLossWindowMin: 60,
    assetCooldownHours: 2,
    maxConsecutiveLossDays: 3,
    feePct: 0.001,
    slippagePct: 0.0005,
    staleMs: 10_000,
    trailActivatePct: 0.015,
  }),
  // Copy-trading selection + execution rules. The win-rate floor is hard: nobody below 75% is ever tracked.
  copy: Object.freeze({
    minWinRate: 0.75, preferredWinRate: 0.80,
    windowDays: 90, minTrades: 30, minProfitFactor: 1.5,
    minSpanDays: 7, minActiveDays: 5, maxTradesPerDay: 40,   // history must be long enough, and not bot-like (closes/day)
    maxCandidateAccount: 5_000_000,
    maxUnrealizedLossPct: 0.10, minAccountValue: 10_000, maxLastFillDays: 14,
    maxTracked: 7, candidatePool: 200, reevalHours: 12,
    maxChasePct: 0.01, stopPct: 0.04, maxFillAgeMs: 120_000, minNotional: 10,
  }),
  // On-chain (Zerion) copy trading. Same win-rate rules as Hyperliquid (see config.copy); these are the on-chain specifics.
  zerion: Object.freeze({
    networks: ['eth', 'base', 'arbitrum', 'bsc', 'solana'],     // GeckoTerminal network ids used to discover active wallets
    poolsPerNetwork: 8, minDiscoveryTradeUsd: 1000, candidatePool: 120, maxPages: 8, minTradeUsd: 50,
    pollMs: 20_000, maxFillAgeMs: 300_000, pricePollMs: 5_000,
    minLiquidityUsd: 200_000, minVolume24hUsd: 100_000, minPairAgeDays: 3,   // only copy into tokens we could realistically exit
  }),
  scanIntervalMs: 5 * 60_000,
  confirmWindowMs: 15 * 60_000,
  maxResearchPerScan: 5,
};

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const warn = (...a) => console.warn(new Date().toISOString(), 'WARN', ...a);
