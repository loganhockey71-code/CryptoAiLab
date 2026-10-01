// THE RESEARCH BRAIN: asynchronous LLM that outputs structured JSON only. It never places orders.
import { config, warn } from './config.js';

const { gemini, openrouter } = config.keys;
export const llmAvailable = () => !!(gemini || openrouter);

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
  if (!res.ok) throw new Error(`gemini -> ${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
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
  if (!res.ok) throw new Error(`openrouter -> ${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}

function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

export async function llmJson(prompt) {
  const providers = [];
  if (gemini) for (const m of config.models.gemini) providers.push([`gemini:${m}`, (p) => callGemini(p, m)]);
  if (openrouter) providers.push(['openrouter', callOpenRouter]);
  for (const [name, fn] of providers) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = parseJson(await fn(prompt));
        if (out) return { json: out, provider: name };
        warn(`${name} returned unparseable JSON`);
      } catch (e) {
        const transient = /-> (429|500|502|503|504)/.test(e.message) || e.name === 'TimeoutError';
        if (name.startsWith('gemini') && transient) { warn(`${name} busy, trying next model`); break; }
        warn(`LLM call failed (${name}, attempt ${attempt + 1}):`, e.message.replace(/\s+/g, ' ').slice(0, 160));
        if (transient && attempt < 2) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
      }
      break;
    }
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
  const prompt = `You are the Research Brain of a paper-trading system (long-only, spot). Assess whether ${ctx.symbol} (${ctx.name}) has a bullish setup over roughly the next 1-6 hours. A separate deterministic engine will verify candle confirmation and every risk rule; you only produce a structured signal.

${STYLE}

Reference price: ${ctx.price}
BTC 1h regime: ${ctx.btcRegime}
Multi-timeframe technicals (each timeframe: trendUp = EMA20>EMA50 and price>EMA50): ${JSON.stringify(ctx.timeframes)}
Relative volume (RVOL, last completed 15m vs 20-candle avg): ${ctx.rvol}
Why this coin is being looked at (trending/unusual activity flags): ${JSON.stringify(ctx.activity)}
Smart money: positions held right now by tracked traders who each have a verified win rate >= 75%: ${JSON.stringify(ctx.smartMoney)}
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
- target_price and stop_price must be consistent with direction "bullish": stop_price < price < target_price. Stop distance should be inside this coin's band (${JSON.stringify(ctx.stopBand)}: min/max as fractions below price). Only go wider than the band when you have very high conviction (confidence >= ${config.risk.stopOverrideConfidence}); never wider than ${config.risk.stopAbsMaxPct * 100}% (memes: never wider than their max).
- target_price is where a PARTIAL profit is taken, the rest then trails. Aim it inside this coin's target band (${JSON.stringify(ctx.targetBand)} as fractions above price; memes may go higher). Net R:R vs your stop must be at least ${config.risk.minRR}. Do not inflate the target to pass R:R; if the setup only supports a smaller move, return neutral.
- "supporting_sources" and "conflicting_sources" must only contain values from: "exchange_technicals", "derivatives", "macro_gov", "news_onchain", "smart_money".

${lessonsBlock(lessons)}

Return JSON with exactly these keys:
{"direction":"bullish"|"neutral"|"bearish","confidence":0-100,"target_price":number,"stop_price":number,"timeframe_hours":number,"supporting_sources":[...],"conflicting_sources":[...],"evidence_summary":"2-4 sentences, probabilistic wording","key_risks":"1-2 sentences"}`;

  const out = await llmJson(prompt);
  if (!out) return null;
  const j = out.json;
  const direction = ['bullish', 'neutral', 'bearish'].includes(j.direction) ? j.direction : null;
  const confidence = num(j.confidence), target = num(j.target_price), stop = num(j.stop_price);
  if (!direction || confidence == null || (direction === 'bullish' && (target == null || stop == null))) {
    warn(`invalid LLM signal for ${ctx.symbol}`);
    return null;
  }
  const valid = new Set(['exchange_technicals', 'derivatives', 'macro_gov', 'news_onchain', 'smart_money']);
  const clean = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => valid.has(x)))];
  return {
    provider: out.provider, direction, confidence: Math.max(0, Math.min(100, confidence)),
    target, stop, timeframeHours: num(j.timeframe_hours),
    supporting: clean(j.supporting_sources), conflicting: clean(j.conflicting_sources),
    evidenceSummary: String(j.evidence_summary ?? '').slice(0, 1200), keyRisks: String(j.key_risks ?? '').slice(0, 600),
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
