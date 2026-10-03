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
    nvidia: env('NVIDIA_API_KEY'),
    ollama: env('OLLAMA_API_KEY'),             // Ollama Cloud (OpenAI-compatible at https://ollama.com/v1); the free plan has hourly/weekly usage limits
    groq: env('GROQ_API_KEY'),                 // Groq free tier (OpenAI-compatible)
    kilo: env('KILO_API_KEY'),                 // Kilo gateway: only its FREE models are ever used
    aiGateway: env('AI_GATEWAY_API_KEY'),      // Vercel AI Gateway: only its zero-price models are ever used by the Research Brain
    // Optional: ANY OpenAI-compatible endpoint (e.g. a self-hosted FreeLLMAPI proxy at http://localhost:3001/v1). Needs both the URL and the key.
    customUrl: env('CUSTOM_LLM_BASE_URL'),
    custom: env('CUSTOM_LLM_API_KEY'),
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
    // NVIDIA NIM (OpenAI-compatible, https://integrate.api.nvidia.com): the PRIMARY Research Brain model. Gemini and OpenRouter stay as fallbacks.
    custom: env('CUSTOM_LLM_MODEL') || 'auto',
    // Ollama Cloud models, tried in this order (only those the cloud actually lists are used). Override with OLLAMA_MODELS=a,b,c
    ollama: (env('OLLAMA_MODELS') || 'gpt-oss:120b,nemotron-3-super,gemma4:31b,glm-5.3-flash,gpt-oss:20b').split(',').map((x) => x.trim()).filter(Boolean),
    // Groq models, tried in this order (each has its own free daily/minute limits). Override with GROQ_MODELS=a,b,c
    groq: (env('GROQ_MODELS') || 'openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b').split(',').map((x) => x.trim()).filter(Boolean),
    nvidia: env('NVIDIA_MODEL') || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  },
  // Deterministic risk constants. The self-learning system must never write to these.
  risk: Object.freeze({
    startingCapital: 2000,
    riskPerTradePct: 0.01,       // hard cap: a stopped-out trade (stop + fees + slippage) may lose at most 1% of equity. There is no minimum position size.
    maxPositionPct: 0.30,
    maxOpenPositions: 3,
    minComponent: 12,            // each of technical / volume / smart money / research must pass on its own (of 25)
    // Stop-loss distance by coin (fraction below entry). Every band is clamped to stopAbsMaxPct: NO stop is ever wider than 4%, on any pair or chain, memes included.
    stopBands: Object.freeze({ btc: [0.015, 0.02], eth: [0.02, 0.025], top20: [0.025, 0.03], mid: [0.03, 0.04], small: [0.04, 0.04], meme: [0.04, 0.04] }),
    stopAbsMaxPct: 0.04,
    // Take-profit zone by tier (fraction above entry): reaching it banks a PARTIAL (partialPct) and the rest runs on a dynamic trailing stop.
    // Memes may target above their band (cap 50%). Targets are never forced: no trade is held for its target, the stop/trail/exit rules decide.
    targetBands: Object.freeze({ btc: [0.04, 0.06], eth: [0.05, 0.08], top20: [0.06, 0.10], mid: [0.08, 0.15], small: [0.10, 0.20], meme: [0.10, 0.25] }),
    memeTargetCap: 0.5, partialPct: 0.5, extraPartialPct: 0.25,
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
    staleMs: 10_000,             // execution price must be this fresh: checked again immediately before any paper entry
    evalStaleMs: 30_000,         // candidate EVALUATION may use a price up to this old (slower coins); never used for execution
    maxEntryDriftPct: 0.005,     // reject an entry if the execution price is more than 0.5% away from the price the setup was confirmed at
    trailActivatePct: 0.015,
  }),
  // THE BRAIN (src/brain.js): the AI's own market analysis decides every entry. Scores, weights and the probability map are model parameters, NOT risk limits: they are
  // calibrated offline (scripts/backtest-brain.mjs) and may only be nudged by walk-forward-validated learning (src/learning.js), bounded by learnBound points.
  brain: Object.freeze({
    minScore: 80,                // legacy display value, no longer a gate
    watchScore: 55,              // below this a coin with no veto is simply NEUTRAL
    // P(target before stop) and expected value in R after costs. Priors are anchored to BACKTEST base rates (scripts/backtest-brain.mjs: entries meeting the real criteria hit
    // a 2.5R+ target first only ~20-30% of the time and the held-out half was worse), so the score map below is deliberately modest: only the top tail of setups clears it.
    // EV (win probability x reward - loss, net of fees, spread and slippage) must be MEANINGFULLY positive: at least minEV AND still positive after subtracting evSeK standard errors of the
    // estimate (so a thin or noisy sample cannot pass). minPUp is only the yardstick for a REALISTIC target (the largest R a setup reaches at least that often), not an entry gate.
    minPUp: 0.30, minEV: 0.05, evSeK: 1.0, dataMinN: 30,
    // Three separate gates (direction / timing / trade geometry): each must pass ON ITS OWN. The overall score is the weakest of the three, so a strong trend cannot hide a poor entry.
    // Direction / timing / geometry are RANKING inputs, not three separate cutoffs. They combine into one composite (weights below); a very weak component drags the composite down (weak-link
    // penalty) so a strong trend still cannot buy a terrible entry. A coin is eligible when its composite clears minComposite (tightened in a weak BTC regime, relaxed for exceptional relative
    // strength) AND its EV is meaningfully positive AND the protected R:R / stop rules hold. Eligible coins are RANKED against each other each scan and the best few are taken.
    composite: Object.freeze({ wDirection: 0.35, wTiming: 0.30, wGeometry: 0.35, weakBelow: 35, weakPenalty: 0.8, chasePenaltyFrom: 0.5, chasePenalty: 25 }), minComposite: 55,
    zoneTolerance: 0.5,                      // price up to this many ATRs beyond the planned zone: the zone is RECALCULATED around the live price instead of giving up
    cancelBeyond: 1.0,                       // a pending entry is cancelled (and recalculated next scan) when price runs this many ATRs past the zone: never chased
    chaseWarn: 0.4, chaseVeto: 0.6,          // anti-chasing score (0 fresh .. 1 fully chased): a PENALTY on timing and composite, never an automatic rejection
    detectShorts: true,                      // SHORT setups are detected, scored, journaled and measured (counterfactual) ...
    allowShortTrades: false,                 // ... but not executed: CLAUDE.md keeps the strategy long-only for v1 (shorts need a perp venue and their own stop engine). Flip only deliberately.
    newsMinSamples: 15,                      // a news rule gets full weight only after this many measured reactions agree with its expected direction (default weight 0.5)
    funnel: Object.freeze({ minVol24: 1_000_000, minMcap: 5_000_000, maxDeepPerScan: 150 }),
    exploreRiskFraction: 0.5,    // until 30+ own trades are measured AND their average R is positive, every entry risks only this fraction of the normal 1% (smaller than the cap, never larger)
    exploreMinTrades: 30,
    scoreScale: 55,
    // Weights follow what scripts/research-long.mjs measured over 240 days x 38 coins: short-term momentum / relative strength / candle and flow signals carried ~zero or NEGATIVE forward information,
    // so they are weighted low; setup quality and the R:R / location geometry (which set the payoff, not a prediction) carry the most.
    weights: Object.freeze({ trend: 0.14, flow: 0.14, candles: 0.07, volume: 0.08, momentum: 0.05, structure: 0.16, regime: 0.08, relStrength: 0.02, news: 0.05, setup: 0.20, smart: 0.01 }),
    calib: Object.freeze({ mid: 72, width: 10, floor: 0.15, ceil: 0.45 }),   // score -> P(target before stop); replaced by the live record as outcomes accumulate
    maxSpreadPct: 0.4, minDepthUsd: 10_000,   // only EXTREMELY thin books veto (positions are at most ~$600)
    maxBuysPerScan: 2, ringPerSymbol: 48, ringEveryMs: 20 * 60_000,
    sellConfirmScans: 2,         // a SELL on an open position must hold on this many consecutive scans
    learnBound: 8, learnMinTrain: 8, learnMinTest: 5, learnTrainFrac: 0.6,
    missedMovePct: 0.08, missedWindowH: 24, missedEveryMs: 30 * 60_000,
    llmReview: true,             // the LLM may only DOWNGRADE a BUY to WATCH (never create or upgrade one)
  }),
  // Copy-trading selection + execution rules. The win-rate floor is hard: nobody below 75% is ever tracked.
  // mirror=false: tracked traders are a small DATA input only. They can never open, add to or size a position (see engine.openCopyPosition).
  copy: Object.freeze({
    mirror: false,
    minWinRate: 0.75, preferredWinRate: 0.80,
    windowDays: 90, minTrades: 30, minProfitFactor: 1.5,
    minSpanDays: 7, minActiveDays: 5, maxTradesPerDay: 40, minMedianHoldMin: 10,   // history must be long enough, and not bot-like (closes/day)
    maxCandidateAccount: 5_000_000,
    maxUnrealizedLossPct: 0.10, minAccountValue: 10_000, maxLastFillDays: 14,
    maxTracked: 7, maxCopyPositions: 2,           // copies may use 2 of the 3 position slots; one stays free for my own analysis
    candidatePool: 200, reevalHours: 12,
    maxChasePct: 0.01, stopPct: 0.04, stopMaxPct: 0.04,   // copy hard stop is 4% and can never be wider
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
  // Tradable universe: EVERY coin with an online Coinbase USD market (stablecoins and wrapped/staked tokens excluded), not just the top 100.
  universe: Object.freeze({
    tailEvery: 3,                                       // coins outside the shortlist still get full candle analysis every 3rd scan (and on first sight)
    minVolume24hUsd: 1_000_000,                         // tracked regardless, but never ENTERED below this 24h volume: too thin to fill at the modelled slippage
  }),
  // Market radar funnel. Stage 0: sweep ~8,200 coins on cheap data only. Stage 1: a dynamic shortlist gets candle analysis every scan.
  // Stage 2: only the strongest few are deeply researched (derivatives, news, macro, smart money, AI). Coins that cannot be traded here are watch-only.
  radar: Object.freeze({
    // Discovery (every coin CoinGecko lists, 250 per page, ~8,500 coins) is slow-changing: a full sweep every 4h is enough. A rate-limited sweep resumes from the page it stopped at.
    everyMs: 4 * 60 * 60_000, retryMs: 5 * 60_000, maxPages: 34,
    // Coins we can actually trade are refreshed far more often with ONE batched call per 250 ids (no full sweep needed): the shortlist + open positions every hotEveryMs,
    // every other tradable coin every tradableEveryMs. Both feed the same radar rows, so priorities and the shortlist stay current between sweeps.
    hotEveryMs: 10 * 60_000, tradableEveryMs: 60 * 60_000, idsPerCall: 250,
    // A coin the cheap refresh sees ripping (1h change, or its 24h volume jumping since the previous refresh) is promoted to analysis right away.
    promote1h: 0.05, promoteVolJump: 0.5, promoteCooldownMs: 15 * 60_000,
    // CoinGecko rate limiting: calls are serialised with this minimum gap (keyed plans allow ~30/min, the public tier far less). A 429 pauses ALL calls (Retry-After, else exponential backoff).
    gapMs: Object.freeze({ keyed: 2_500, public: 6_500 }), maxRetries: 4, backoffBaseMs: 30_000, backoffMaxMs: 5 * 60_000,
    trendingEveryMs: 30 * 60_000, cmcEveryMs: 60 * 60_000,
    shortlistSize: 150,                                       // 100-300: refreshed with candles every scan
    researchMax: 20,                                          // 10-30: deep research slots per scan
    minMcapUsd: 5_000_000, maxVolMcap: 3, washCapCeiling: 500_000_000,   // manipulation screens
    thinSpikePct: 0.20, thinSpikeVol: 3_000_000,
  }),
  // AI provider handling. An error that cannot succeed until a reset is not retried: that model is skipped until then (the values below are only fallbacks when the provider gives no reset time).
  // pressureMaxSignals: once any model has hit a DAILY quota, only this many of the best candidates are sent to the AI per scan, so what is left is reserved for them.
  // maxAttemptsPerSignal: HTTP calls one signal may make for TRANSIENT trouble (timeouts, 5xx, unparseable output) = the first call + 1 retry in total, across every model.
  // maxDiscoveriesPerSignal: models found unavailable (quota / rate limit / gone) while serving ONE signal; a safety stop so a bad day cannot burn calls walking a long chain.
  llm: Object.freeze({ maxDiscoveriesPerSignal: 3, openrouterRefreshMs: 6 * 3600_000, maxAttemptsPerSignal: 2, authDownMs: 6 * 3600_000, quotaFallbackMs: 2 * 3600_000, rateFallbackMs: 60_000, maxDownMs: 26 * 3600_000, pressureMaxSignals: 5 }),
  // Trending / unusually-active detection. It only decides what gets researched FIRST; it never lowers a requirement.
  movers: Object.freeze({ chg1h: 0.04, chg4h: 0.08, chg24h: 0.15, rvol: 2.5, maxMoversPerScan: 3, fastTrigger1h: 0.08, fastCheckMs: 60_000, fastCooldownMs: 15 * 60_000 }),
  // Loss-side early exit (see src/exits.js): a losing long in a confirmed, continuing downtrend is closed BEFORE its stop. It can only exit earlier / at a smaller loss than the
  // stop, so it never adds risk. It is a risk rule: self-learning must never change it.
  exits: Object.freeze({ downtrend: Object.freeze({ minLossR: 0.3, minHoldMs: 10 * 60_000, confirmChecks: 3, lowerBars: 3, rsiMax: 40 }) }),
  scanIntervalMs: 5 * 60_000,
  confirmWindowMs: 15 * 60_000,
};

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const warn = (...a) => console.warn(new Date().toISOString(), 'WARN', ...a);
