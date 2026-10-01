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
  },
  models: {
    gemini: 'gemini-2.5-flash',
    openrouter: 'google/gemini-2.5-flash',
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
  scanIntervalMs: 5 * 60_000,
  confirmWindowMs: 15 * 60_000,
  maxResearchPerScan: 5,
};

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const warn = (...a) => console.warn(new Date().toISOString(), 'WARN', ...a);
