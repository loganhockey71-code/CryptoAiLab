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
    birdeye: env('BIRDEYE_API_KEY'),
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
    minComponent: 12,            // each of technical / volume / smart money / research must pass on its own (of 25)
    // Stop-loss distance by coin (fraction below entry). Normal band per tier; with confidence >= stopOverrideConfidence the stop may be
    // wider than the band, but NEVER wider than stopAbsMaxPct. Memes are capped at 10% and sit in the same 6-10% band as the Top 51-100.
    stopBands: Object.freeze({ btc: [0.015, 0.02], eth: [0.02, 0.025], top20: [0.025, 0.03], mid: [0.03, 0.06], small: [0.06, 0.10], meme: [0.06, 0.10] }),
    stopAbsMaxPct: 0.15, stopOverrideConfidence: 85,
    memeSymbols: Object.freeze(['DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI', 'TRUMP', 'MEME', 'BRETT', 'POPCAT', 'MOG', 'PENGU', 'FARTCOIN', 'SPX', 'TURBO', 'NEIRO', 'PNUT', 'GOAT', 'MOODENG', 'BOME']),
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
    minSpanDays: 7, minActiveDays: 5, maxTradesPerDay: 40, minMedianHoldMin: 10,   // history must be long enough, and not bot-like (closes/day)
    maxCandidateAccount: 5_000_000,
    maxUnrealizedLossPct: 0.10, minAccountValue: 10_000, maxLastFillDays: 14,
    maxTracked: 7, maxCopyPositions: 2,           // copies may use 2 of the 3 position slots; one stays free for my own analysis candidatePool: 200, reevalHours: 12,
    maxChasePct: 0.01, stopPct: 0.04, stopMaxPct: 0.07,   // copy hard stop is 4%; may be set wider for a specific trade but NEVER beyond 7%
     maxFillAgeMs: 120_000, minNotional: 10,
    // Consecutive losing copies of the SAME trader (a win resets it): 1 keep copying, 2 pause, 3 long pause + re-score, 4 review, 5+ removed.
    loserStreak: Object.freeze({ pause2Hours: 3, pause3Hours: 24, reviewAt: 4, removeAt: 5 }),
  }),
  // On-chain (Zerion) copy trading. Same win-rate rules as Hyperliquid (see config.copy); these are the on-chain specifics.
  zerion: Object.freeze({
    networks: ['eth', 'base', 'arbitrum', 'bsc', 'solana'],     // GeckoTerminal network ids used to discover active wallets
    poolsPerNetwork: 15, minDiscoveryTradeUsd: 500, maxDiscoveryTradeUsd: 100_000, botSamplePerPool: 5,   // wallets with more swaps than this in ONE pool sample look like bots
    poolLiquidityMin: 200_000, poolLiquidityMax: 100_000_000, poolVolume24hMin: 200_000,                  // skip dust pools and the bot-dominated majors
    candidatePool: 400, maxPages: 8, minTradeUsd: 50,
    // Birdeye (Solana top traders by token) is rate/CU limited on the free plan: run rarely and cap calls per day.
    birdeyeTokens: 5, birdeyeEveryH: 6, birdeyePerDayCap: 25, birdeyeMinRealizedUsd: 250, birdeyeMinTrades: 3,
    pollMs: 20_000, maxFillAgeMs: 300_000, pricePollMs: 5_000,
    minLiquidityUsd: 200_000, minVolume24hUsd: 100_000, minPairAgeDays: 3,   // only copy into tokens we could realistically exit
  }),
  // Trending / unusually-active detection. It only decides what gets researched FIRST; it never lowers a requirement.
  movers: Object.freeze({ chg1h: 0.04, chg4h: 0.08, chg24h: 0.15, rvol: 2.5, maxMoversPerScan: 3, fastTrigger1h: 0.08, fastCheckMs: 60_000, fastCooldownMs: 15 * 60_000 }),
  scanIntervalMs: 5 * 60_000,
  confirmWindowMs: 15 * 60_000,
  maxResearchPerScan: 6,
};

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const warn = (...a) => console.warn(new Date().toISOString(), 'WARN', ...a);
