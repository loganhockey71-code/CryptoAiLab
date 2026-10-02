// THE RESEARCH BRAIN: asynchronous LLM that outputs structured JSON only. It never places orders.
import { config, warn } from './config.js';

const { gemini, openrouter, nvidia } = config.keys;
/** A key is configured. This says nothing about whether the providers still have quota: see llmUsable(). */
export const llmAvailable = () => !!(nvidia || gemini || openrouter);

/** HTTP error from a provider, keeping the status, body and Retry-After so the failure can be classified (message format unchanged). */
class ApiError extends Error {
  constructor(provider, status, body, retryAfter) { super(`${provider} -> ${status} ${body.slice(0, 120)}`); this.status = status; this.body = body; this.retryAfter = retryAfter; }
}

async function callGemini(prompt, model) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': gemini },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new ApiError('gemini', res.status, await res.text(), res.headers.get('retry-after'));
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

/** NVIDIA NIM (OpenAI-compatible). A reasoning model: the answer is in `content`; any chain-of-thought arrives as `reasoning_content` or inside <think> tags and is dropped. */
async function callNvidia(prompt) {
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${nvidia}`, accept: 'application/json' },
    body: JSON.stringify({ model: config.models.nvidia, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 6000, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new ApiError('nvidia', res.status, await res.text(), res.headers.get('retry-after'));
  const j = await res.json();
  const m = j.choices?.[0]?.message ?? {};
  const answer = String(m.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return answer || String(m.reasoning_content ?? m.reasoning ?? '');       // last resort: some deployments put the whole reply in the reasoning field
}

async function callOpenRouter(prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${openrouter}` },
    body: JSON.stringify({
      model: config.models.openrouter,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new ApiError('openrouter', res.status, await res.text(), res.headers.get('retry-after'));
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}

/** Tolerant JSON extraction: strips code fences/BOM/smart quotes, takes the first balanced {...}, removes trailing commas. */
export function parseJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.replace(/^﻿/, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const attempt = (x) => { try { const v = JSON.parse(x); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  const direct = attempt(t) ?? attempt(t.replace(/,\s*([}\]])/g, '$1'));
  if (direct) return direct;
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {                      // first balanced object, respecting strings
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) {
      const chunk = t.slice(start, i + 1);
      return attempt(chunk) ?? attempt(chunk.replace(/,\s*([}\]])/g, '$1'));
    }
  }
  return null;
}

/** Research Brain health counters since startup (for the dashboard): why signals are missing, not just that they are. */
export const llmStats = { since: Date.now(), skippedUnavailable: 0, signals: 0, signalsOk: 0, noSignal: 0, invalid: 0, unparseable: 0, transient: 0, hard: 0, lastError: null, lastErrorAt: null, lastOkAt: null, lastOkProvider: null };
const noteError = (kind, text) => { llmStats[kind]++; llmStats.lastError = text; llmStats.lastErrorAt = Date.now(); };

const isTransient = (e) => /-> (408|425|429|500|502|503|504)/.test(e.message) || e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network/i.test(e.message);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const L = config.llm;
/** The model chain, in order: NVIDIA NIM (primary), every Gemini model (each has its OWN daily quota), then OpenRouter. */
const chain = () => [
  ...(nvidia ? [['nvidia', callNvidia]] : []),
  ...(gemini ? config.models.gemini.map((m) => [`gemini:${m}`, (p) => callGemini(p, m)]) : []),
  ...(openrouter ? [['openrouter', callOpenRouter]] : []),
];

// ---- Provider health. An error that cannot succeed until a reset (daily quota, per-minute limit, bad key) takes THAT model out of the chain until the reset time
// instead of being retried; every other model keeps working. `wasted` = calls that failed this way, `avoided` = calls we did not make because the model was down.
const health = new Map();          // name -> { downUntil, kind, reason, wasted, avoided, outages }
const hs = (name) => { let h = health.get(name); if (!h) health.set(name, h = { downUntil: 0, kind: null, reason: null, wasted: 0, avoided: 0, outages: 0 }); return h; };
const isDown = (name) => {
  const h = hs(name);
  if (h.downUntil > Date.now()) return true;
  if (h.downUntil) { h.downUntil = 0; warn(`AI provider ${name} is available again (was down: ${h.kind}); the next call will probe it`); }
  return false;
};
const nextUtcMidnight = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

/** Ms a provider says to wait: Gemini RetryInfo / "Please retry in 8h24m7s", OpenRouter X-RateLimit-Reset (epoch ms), or the Retry-After header. null if unknown. */
function resetMsFromError(e) {
  const body = e.body ?? '';
  try {
    const j = JSON.parse(body);
    const info = (j.error?.details ?? []).find((d) => d.retryDelay);
    if (info) return parseFloat(info.retryDelay) * 1000;
    const reset = Number(j.error?.metadata?.headers?.['X-RateLimit-Reset']);
    if (reset > Date.now()) return reset - Date.now();
  } catch { /* not JSON */ }
  const m = body.match(/retry in\s+(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m(?!s))?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (m && (m[1] || m[2] || m[3])) return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
  const ra = Number(e.retryAfter);
  return ra > 0 ? ra * 1000 : null;
}

/**
 * Is this error one that CANNOT succeed on retry until some reset? Returns { kind, until } or null (retryable / transient).
 *  quota = a daily (or other long) limit: down until the reset the provider reports, else the next 00:00 UTC (OpenRouter) or a re-probe delay (Gemini).
 *  rate  = a per-minute limit: down for exactly the delay it reports.   auth = bad / forbidden key: down for a long cooldown.
 */
export function classifyUnrecoverable(e) {
  const now = Date.now(), text = `${e.body ?? ''} ${e.message}`;
  if (e.status === 401 || e.status === 403) return { kind: 'auth', until: now + L.authDownMs };
  if (e.status === 402) return { kind: 'quota', until: now + L.quotaFallbackMs };   // payment required / credits exhausted: stays out until re-probed
  if (e.status !== 429) return null;
  const waitMs = resetMsFromError(e);
  const daily = /per.?day|daily|free-models-per-day/i.test(text) || (waitMs != null && waitMs > 15 * 60_000);
  if (daily) return { kind: 'quota', until: now + Math.min(L.maxDownMs, waitMs ?? (/openrouter/i.test(e.message) ? nextUtcMidnight() - now : L.quotaFallbackMs)) };
  return { kind: 'rate', until: now + Math.min(15 * 60_000, (waitMs ?? L.rateFallbackMs) + 1000) };
}

function markDown(name, c, e) {
  const h = hs(name);
  h.downUntil = c.until; h.kind = c.kind; h.reason = e.message.replace(/\s+/g, ' ').slice(0, 140); h.wasted++; h.outages++;
  const mins = Math.round((c.until - Date.now()) / 60_000);
  warn(`AI provider ${name} unavailable: ${c.kind} limit (HTTP ${e.status}), will not be retried until ${new Date(c.until).toISOString()} (${mins >= 90 ? (mins / 60).toFixed(1) + 'h' : mins + 'm'}); wasted attempts so far: ${h.wasted}, calls avoided: ${h.avoided}`);
  llmStats.lastError = `${name}: ${c.kind} limit until ${new Date(c.until).toISOString().slice(0, 16)}Z`; llmStats.lastErrorAt = Date.now();
}

/** At least one configured model can currently be called. When false the Research Brain is paused (it never trades, so the strategy simply stays in cash). */
export const llmUsable = () => chain().some(([name]) => !isDown(name));
/** When the first model comes back (ms epoch), or null if something is already usable or nothing is configured. */
export const llmResumeAt = () => (llmUsable() ? null : Math.min(...chain().map(([name]) => hs(name).downUntil)));
/** True once any model has hit a daily QUOTA (the others are probably close behind): the engine then spends what is left on the best candidates only. */
export const llmPressure = () => chain().some(([name]) => { const h = hs(name); return h.kind === 'quota' && h.downUntil > Date.now(); });
/** Per-provider status for the dashboard and logs. */
export const llmProviders = () => chain().map(([name]) => {
  const h = hs(name), down = h.downUntil > Date.now();
  return { name, state: down ? 'down' : 'ok', kind: down ? h.kind : null, until: down ? h.downUntil : null, reason: h.reason, wastedAttempts: h.wasted, avoidedCalls: h.avoided, outages: h.outages };
});

/**
 * Call the model chain until one returns valid JSON. Models that are down (quota / rate limit / bad key) are skipped without a request, and a call that fails
 * that way does NOT use the attempt budget (it cannot be retried; it takes that model out until its reset). Everything else (timeout, 5xx, unparseable output)
 * is TRANSIENT and uses `budget.left`: one signal makes at most L.maxAttemptsPerSignal such calls in total (the first call + 1 retry), across all models and across
 * generateSignal's corrective re-ask. The retry goes to the next usable model, or the same one with a stricter instruction if it is the only one left.
 * Returns null when nothing usable answered; the caller degrades gracefully and the coin is looked at again on a later scan.
 */
export async function llmJson(prompt, budget = { left: L.maxAttemptsPerSignal }) {
  const providers = chain();
  const strict = `${prompt}

IMPORTANT: respond with ONE valid JSON object only: no markdown, no commentary, no trailing commas.`;
  let stricter = false;                                                 // after an unparseable answer, ask again more firmly
  for (let round = 0; round < 2; round++) {                             // round 2 only happens for the "single model left" retry
    for (const [name, fn] of providers) {
      if (isDown(name)) { if (round === 0) hs(name).avoided++; continue; }
      if (budget.left <= 0) return null;
      budget.left--;
      try {
        const out = parseJson(await fn(stricter ? strict : prompt));
        if (out) return { json: out, provider: name };
        noteError('unparseable', `${name}: unparseable JSON`);
        warn(`${name} returned unparseable JSON (${budget.left} retr${budget.left === 1 ? 'y' : 'ies'} left for this signal)`);
        stricter = true;
      } catch (e) {
        const c = classifyUnrecoverable(e);
        if (c) { budget.left++; markDown(name, c, e); continue; }          // cannot succeed until the reset: refund the attempt, try the next model
        if (isTransient(e)) { noteError('transient', `${name}: ${e.message.replace(/\s+/g, ' ').slice(0, 100)}`); warn(`${name} busy/slow (${e.message.replace(/\s+/g, ' ').slice(0, 80)}) (${budget.left} retr${budget.left === 1 ? 'y' : 'ies'} left for this signal)`); continue; }
        noteError('hard', `${name}: ${e.message.replace(/\s+/g, ' ').slice(0, 100)}`);
        warn(`LLM call failed (${name}):`, e.message.replace(/\s+/g, ' ').slice(0, 160));
      }
    }
    if (budget.left <= 0 || !providers.some(([name]) => !isDown(name))) return null;
  }
  return null;
}

const STYLE = `Use probabilistic language ("the available evidence suggests", "factors that may have contributed"). Never claim certainty about causes of price moves. Do not invent data: only use the evidence provided below. Respond with a single JSON object and nothing else.`;

const lessonsBlock = (lessons) => lessons?.length
  ? `Lessons from your 5 most recent completed trades (weigh them, they are not rules):\n${lessons.map((l, i) => `${i + 1}. [${l.outcome}] ${l.symbol}: ${l.lesson}`).join('\n')}`
  : 'No prior trade lessons yet.';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** ctx: { symbol, name, price, btcRegime, timeframes, rvol, derivatives, news, macro, legislation, onchain, provenance } */
export async function generateSignal(ctx, lessons) {
  const prompt = `You are the Research Brain of a paper-trading system (long-only, spot). Assess whether ${ctx.symbol} (${ctx.name}) has a bullish setup over a horizon of 1 to 72 hours. Positions may last minutes, hours or 2+ days; many of the best are held for 1-2 days, so do not assume a quick exit: choose the horizon the higher timeframes (1h/4h/1d) actually support. A separate deterministic engine will verify candle confirmation and every risk rule; you only produce a structured signal.

${STYLE}

Reference price: ${ctx.price}
BTC 1h regime: ${ctx.btcRegime}
Multi-timeframe technicals (each timeframe: trendUp = EMA20>EMA50 and price>EMA50): ${JSON.stringify(ctx.timeframes)}
Relative volume (RVOL, last completed 15m vs 20-candle avg): ${ctx.rvol}
Why this coin is being looked at (trending/unusual activity flags): ${JSON.stringify(ctx.activity)}
Smart money: positions held right now by tracked traders who each have a verified win rate >= 75%: ${JSON.stringify(ctx.smartMoney)}
Order book (Tier 1, Coinbase level 2, full aggregated book; spread in %, depthUsd = resting USD within 0.5%/1% of mid, bid and ask side; a wide spread or thin depth means the quoted price is less reliable): ${JSON.stringify(ctx.orderBook)}
Derivatives (Tier 2, Coinglass): ${JSON.stringify(ctx.derivatives)}
Macro (Tier 3, FRED): ${JSON.stringify(ctx.macro)}
Crypto/market legislation (Tier 3, Congress.gov): ${JSON.stringify(ctx.legislation)}
Political, regulatory and central-bank events (Tier 3 = official White House / Federal Register / Federal Reserve / SEC / CFTC; Tier 4 = news outlets and an UNOFFICIAL Truth Social mirror; newest first): ${JSON.stringify(ctx.politics)}
On-chain (Tier 4, Etherscan): ${JSON.stringify(ctx.onchain)}
Recent headlines (Tier 4, with per-headline sentiment -1..1): ${JSON.stringify(ctx.news)}
Data provenance/timestamps: ${JSON.stringify(ctx.provenance)}

Rules:
- Several aggregators repeating the same underlying fact count as ONE independent source.
- If reliable sources materially disagree, lower confidence or return direction "neutral".
- A trending or unusually active coin is only a reason to LOOK, not to buy. Judge whether the move still has momentum or is exhausted/parabolic; chasing a vertical move is a real risk, so lower confidence (or return neutral) when it looks overextended or has no pullback to build on. Tracked traders holding a coin long is supporting evidence; tracked traders short is a strong reason to avoid it.
- Political items are market-wide context, not coin-specific evidence. Prefer Tier 3 over Tier 4; treat social-media posts and headlines as unverified. Count them under "macro_gov". If a high-impact event from the last 24 hours (rate decision, tariffs, sanctions, an executive order or SEC/CFTC action touching crypto or markets) makes the setup riskier, lower confidence and say so in key_risks. Never invent a causal link between an event and this coin.
- target_price and stop_price must be consistent with direction "bullish": stop_price < price < target_price. Stop distance must be inside this coin's band (${JSON.stringify(ctx.stopBand)}: min/max as fractions below price). It can NEVER be wider than ${config.risk.stopAbsMaxPct * 100}%, for any coin including memes; position size is derived from the stop, so a wider stop is not available.
- target_price is where a PARTIAL profit is taken, the rest then trails. Aim it inside this coin's target band (${JSON.stringify(ctx.targetBand)} as fractions above price; memes may go higher). Net R:R vs your stop must be at least ${config.risk.minRR}. Do not inflate the target to pass R:R; if the setup only supports a smaller move, return neutral.
- timeframe_hours is your intended holding period, between 1 and 72. Use 24-72 when the 4h/1d trend supports it and only use 6 or less for a genuinely short-lived setup.
- "supporting_sources" and "conflicting_sources" must only contain values from: "exchange_technicals", "derivatives", "macro_gov", "news_onchain", "smart_money".

${lessonsBlock(lessons)}

Return JSON with exactly these keys:
{"direction":"bullish"|"neutral"|"bearish","confidence":0-100,"target_price":number,"stop_price":number,"timeframe_hours":number,"supporting_sources":[...],"conflicting_sources":[...],"evidence_summary":"2-4 sentences, probabilistic wording","key_risks":"1-2 sentences"}`;

  // A formatting slip must not cost a valid setup: validate (leniently), and if the answer is unusable ask once more, saying what was wrong.
  if (!llmUsable()) { llmStats.skippedUnavailable++; return null; }   // nothing can answer: do not count it as a failed signal
  let problem = null;
  const budget = { left: L.maxAttemptsPerSignal };                 // ONE budget for this signal, shared with the corrective re-ask below
  llmStats.signals++;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llmJson(attempt === 0 ? prompt : `${prompt}\n\nYour previous answer was rejected: ${problem}. Return the corrected JSON object only.`, budget);
    if (!out) { llmStats.noSignal++; return null; }              // every model failed or timed out: the caller retries this coin later instead of rejecting it
    const v = validateSignal(out.json, ctx.price);
    if (v.ok) { llmStats.signalsOk++; llmStats.lastOkAt = Date.now(); llmStats.lastOkProvider = out.provider; return { provider: out.provider, ...v.signal }; }
    problem = v.problem; noteError('invalid', `invalid signal: ${problem}`.slice(0, 140));
    warn(`invalid LLM signal for ${ctx.symbol} (${problem})${attempt === 0 ? ', asking once more' : ''}`);
  }
  return null;
}

const SIGNAL_SOURCES = new Set(['exchange_technicals', 'derivatives', 'macro_gov', 'news_onchain', 'smart_money']);
const numLoose = (v) => { if (typeof v === 'string') v = v.replace(/[%$,\s]/g, ''); const n = Number(v); return v !== '' && v != null && Number.isFinite(n) ? n : null; };

/** Normalise and check a model answer. Accepts numeric strings, any-case direction, 0-1 confidence; requires stop < price < target for a bullish call. */
export function validateSignal(j, price) {
  if (!j || typeof j !== 'object') return { ok: false, problem: 'not a JSON object' };
  const direction = String(j.direction ?? '').trim().toLowerCase();
  if (!['bullish', 'neutral', 'bearish'].includes(direction)) return { ok: false, problem: `direction must be "bullish", "neutral" or "bearish" (got ${JSON.stringify(j.direction)})` };
  let confidence = numLoose(j.confidence);
  if (confidence == null) return { ok: false, problem: 'confidence must be a number from 0 to 100' };
  if (confidence > 0 && confidence <= 1 && !Number.isInteger(confidence)) confidence *= 100;   // 0.85 -> 85
  const target = numLoose(j.target_price), stop = numLoose(j.stop_price);
  if (direction === 'bullish') {
    if (target == null || stop == null) return { ok: false, problem: 'a bullish signal needs numeric target_price and stop_price' };
    if (price > 0 && !(stop < price && price < target)) return { ok: false, problem: `for a bullish signal stop_price (${stop}) < price (${price}) < target_price (${target}) must hold` };
  }
  const clean = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => SIGNAL_SOURCES.has(x)))];
  return {
    ok: true,
    signal: {
      direction, confidence: Math.max(0, Math.min(100, confidence)), target, stop, timeframeHours: numLoose(j.timeframe_hours),
      supporting: clean(j.supporting_sources), conflicting: clean(j.conflicting_sources),
      evidenceSummary: String(j.evidence_summary ?? '').slice(0, 1200), keyRisks: String(j.key_risks ?? '').slice(0, 600),
    },
  };
}

/** Structured post-mortem for a closed trade. trade/context are plain objects built by the engine. */
export async function reflectOnTrade(trade, ctx, lessons) {
  const win = trade.final_pnl > 0;
  const prompt = `You are writing the structured post-mortem for a completed PAPER trade. ${win
    ? 'This trade was profitable: analyze which factors plausibly contributed to the success instead of just marking it correct.'
    : 'This trade lost money: identify which assumptions, indicators, data sources or execution timing plausibly failed.'}

${STYLE}

Trade: ${JSON.stringify(trade)}
Context at entry: ${JSON.stringify(ctx)}
${lessonsBlock(lessons)}

Return JSON with exactly these keys:
{"actual_result":"realized movement and duration, 1-2 sentences","indicators_correct":["..."],"indicators_wrong":["..."],"news_impact":{"mattered":["..."],"irrelevant":["..."]},"lesson":"one actionable, probabilistic lesson","patterns":["short recurring-pattern tags, e.g. 'low-rvol breakout failure'"]}`;
  const out = await llmJson(prompt);
  if (!out) return null;
  const j = out.json;
  const arr = (a) => (Array.isArray(a) ? a.map(String).slice(0, 12) : []);
  return {
    actual_result: String(j.actual_result ?? ''), indicators_correct: arr(j.indicators_correct), indicators_wrong: arr(j.indicators_wrong),
    news_impact: { mattered: arr(j.news_impact?.mattered), irrelevant: arr(j.news_impact?.irrelevant) },
    lesson: String(j.lesson ?? ''), patterns: arr(j.patterns),
  };
}
