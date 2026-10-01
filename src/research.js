// THE RESEARCH BRAIN: asynchronous LLM that outputs structured JSON only. It never places orders.
import { config, warn } from './config.js';

const { gemini, openrouter } = config.keys;
export const llmAvailable = () => !!(gemini || openrouter);

async function callGemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.models.gemini}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': gemini },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
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
  if (gemini) providers.push(['gemini', callGemini]);
  if (openrouter) providers.push(['openrouter', callOpenRouter]);
  for (const [name, fn] of providers) {
    try {
      const out = parseJson(await fn(prompt));
      if (out) return { json: out, provider: name };
      warn(`${name} returned unparseable JSON`);
    } catch (e) { warn('LLM call failed:', e.message); }
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
Derivatives (Tier 2, Coinglass): ${JSON.stringify(ctx.derivatives)}
Macro (Tier 3, FRED): ${JSON.stringify(ctx.macro)}
Crypto legislation (Tier 3, Congress.gov): ${JSON.stringify(ctx.legislation)}
On-chain (Tier 4, Etherscan): ${JSON.stringify(ctx.onchain)}
Recent headlines (Tier 4, with per-headline sentiment -1..1): ${JSON.stringify(ctx.news)}
Data provenance/timestamps: ${JSON.stringify(ctx.provenance)}

Rules:
- Several aggregators repeating the same underlying fact count as ONE independent source.
- If reliable sources materially disagree, lower confidence or return direction "neutral".
- target_price and stop_price must be consistent with direction "bullish": stop_price < price < target_price. Stop distance should be between 2.5% and 4% below price.
- "supporting_sources" and "conflicting_sources" must only contain values from: "exchange_technicals", "derivatives", "macro_gov", "news_onchain".

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
  const valid = new Set(['exchange_technicals', 'derivatives', 'macro_gov', 'news_onchain']);
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
