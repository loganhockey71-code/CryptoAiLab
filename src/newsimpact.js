// News -> structured market impact. Pure functions, no I/O, no LLM: a transparent keyword taxonomy over headlines the app already reads (crypto RSS, official feeds, Congress, FRED).
// Per event: what happened -> affected coins -> bullish / bearish / uncertain -> strength -> duration -> already priced in or not.
// This is a HEURISTIC reader, not an oracle: an event is only reported when a headline actually matches, ambiguous headlines are 'uncertain', and nothing is invented.

const H = 3600_000;

// scope 'market' hits every coin, 'coin' only the coins named in the headline. dir: +1 bullish, -1 bearish. strength 0..1. hours = how long the effect plausibly lasts.
const RULES = [
  { id: 'etf_inflow', re: /\betf\b.*(approv|inflow|launch|record|greenlight)|spot (bitcoin|ether|eth|sol|xrp)\b.*etf.*(approv|launch)|etf inflows?/i, dir: 1, strength: 0.7, hours: 48, scope: 'coin', label: 'ETF approval / inflows' },
  { id: 'etf_outflow', re: /\betf\b.*(outflow|reject|delay|denied|withdraw)|etf outflows?/i, dir: -1, strength: 0.55, hours: 36, scope: 'coin', label: 'ETF outflows / rejection' },
  { id: 'hack', re: /\b(hack(ed|s)?|exploit(ed)?|drained|stolen|breach|rug ?pull|security incident|bridge attack)\b/i, dir: -1, strength: 0.8, hours: 72, scope: 'coin', label: 'Hack / exploit' },
  { id: 'unlock', re: /\b(token )?unlock|vesting (cliff|schedule)|cliff unlock/i, dir: -1, strength: 0.45, hours: 48, scope: 'coin', label: 'Token unlock' },
  { id: 'upgrade', re: /\b(mainnet|hard ?fork|network upgrade|protocol upgrade|v\d+ (launch|upgrade)|halving|dencun|pectra|fusaka)\b/i, dir: 1, strength: 0.35, hours: 24, scope: 'coin', label: 'Upgrade / launch', sellNews: true },
  { id: 'listing', re: /\b(lists?|listing|will list|adds? support for)\b.*\b(coinbase|binance|robinhood|upbit|kraken)\b|\b(coinbase|binance|robinhood|upbit)\b.*\b(lists?|listing|adds)\b/i, dir: 1, strength: 0.5, hours: 12, scope: 'coin', label: 'Exchange listing', sellNews: true },
  { id: 'delist', re: /\bdelist/i, dir: -1, strength: 0.6, hours: 48, scope: 'coin', label: 'Delisting' },
  { id: 'sec_action', re: /\b(sec|cftc|doj)\b.*(sues?|charges?|lawsuit|complaint|subpoena|investigat)/i, dir: -1, strength: 0.6, hours: 72, scope: 'coin', label: 'Regulator action' },
  { id: 'sec_relief', re: /\b(sec|cftc)\b.*(dismiss|drops? (case|lawsuit)|settle|no action|approv)|lawsuit (dismissed|dropped)/i, dir: 1, strength: 0.55, hours: 48, scope: 'coin', label: 'Regulatory relief' },
  { id: 'reg_ban', re: /\b(bans?|banned|outlaws?|prohibits?|cracks? down on|crackdown on)\b.*\b(crypto|bitcoin|stablecoins?|exchanges?)\b/i, dir: -1, strength: 0.6, hours: 72, scope: 'market', label: 'Crypto ban / crackdown' },
  { id: 'reg_clarity', re: /\b(clarity act|genius act|stablecoin bill|market structure bill|crypto bill)\b.*(pass|sign|advance|approve|vote)|strategic bitcoin reserve|bitcoin reserve/i, dir: 1, strength: 0.55, hours: 72, scope: 'market', label: 'Pro-crypto legislation' },
  { id: 'rate_cut', re: /\b(rate cut|cuts? (interest )?rates?|dovish|easing|lower(s|ed)? rates?|pause(s|d)? (rate )?hikes?)\b/i, dir: 1, strength: 0.5, hours: 48, scope: 'market', label: 'Rate cut / dovish Fed' },
  { id: 'rate_hike', re: /\b(rate hike|raises? (interest )?rates?|hawkish|higher for longer|tightening|hikes? rates?)\b/i, dir: -1, strength: 0.5, hours: 48, scope: 'market', label: 'Rate hike / hawkish Fed' },
  { id: 'inflation_hot', re: /\b(cpi|pce|inflation)\b.*(hotter|higher than|rises?|rose|accelerat|surge|jumps?|above)/i, dir: -1, strength: 0.45, hours: 36, scope: 'market', label: 'Inflation hotter' },
  { id: 'inflation_cool', re: /\b(cpi|pce|inflation)\b.*(cooler|lower than|eases|ease[sd]|slows?|falls?|fell|below|cools?)/i, dir: 1, strength: 0.45, hours: 36, scope: 'market', label: 'Inflation cooling' },
  { id: 'dollar_up', re: /\b(dollar|dxy|greenback)\b.*(surge|strengthen|rall|jumps?|climbs?|highest|gains?)/i, dir: -1, strength: 0.35, hours: 36, scope: 'market', label: 'Dollar strength' },
  { id: 'dollar_down', re: /\b(dollar|dxy|greenback)\b.*(weaken|slides?|falls?|drops?|lowest|slump)/i, dir: 1, strength: 0.35, hours: 36, scope: 'market', label: 'Dollar weakness' },
  { id: 'oil_spike', re: /\b(oil|crude|brent|wti|gasoline|gas prices?|energy)\b.*(surge|spike|soar|jump|rall|record|highest)/i, dir: -1, strength: 0.35, hours: 48, scope: 'market', label: 'Oil / energy spike' },
  { id: 'oil_drop', re: /\b(oil|crude|brent|wti|gasoline|gas prices?)\b.*(plunge|tumbl|slump|drop|falls?|slides?|lowest)/i, dir: 1, strength: 0.25, hours: 48, scope: 'market', label: 'Oil / energy drop' },
  { id: 'war', re: /\b(missile|airstrike|invasion|invades|escalat\w+|declares? war|military strike|attack(s|ed)? on|nuclear threat|troops (enter|cross))\b/i, dir: -1, strength: 0.5, hours: 48, scope: 'market', label: 'Geopolitical escalation' },
  { id: 'peace', re: /\b(ceasefire|cease-fire|peace (deal|talks|agreement)|truce|de-escalat\w+)\b/i, dir: 1, strength: 0.4, hours: 48, scope: 'market', label: 'De-escalation' },
  { id: 'tariff', re: /\b(tariffs?|trade war|import dut(y|ies)|sanctions?)\b.*(impose|new|raise|hike|announce|threat|slap|escalat)|\b(imposes?|announces?|threatens?|slaps?)\b.*\b(tariffs?|sanctions?)\b/i, dir: -1, strength: 0.5, hours: 48, scope: 'market', label: 'Tariffs / sanctions' },
  { id: 'tariff_relief', re: /\b(tariffs?|sanctions?|trade (deal|truce))\b.*(pause|delay|suspend|lift|ease|roll ?back|deal|agreement|truce)|\b(pauses?|delays?|lifts?|eases?)\b.*\b(tariffs?|sanctions?)\b/i, dir: 1, strength: 0.5, hours: 48, scope: 'market', label: 'Tariff / sanctions relief' },
  { id: 'insolvency', re: /\b(bankrupt\w*|insolven\w*|halts? withdrawals?|chapter 11|collapse of)\b/i, dir: -1, strength: 0.7, hours: 96, scope: 'coin', label: 'Insolvency / withdrawals halted' },
  { id: 'adoption', re: /\b(treasury (purchase|buys?)|buys? (more )?(bitcoin|btc|ether|eth|sol)|adopts?|partnership with|integrat\w+ (with )?(visa|mastercard|paypal|stripe|blackrock)|institutional (adoption|buying))\b/i, dir: 1, strength: 0.35, hours: 24, scope: 'coin', label: 'Adoption / institutional buying', sellNews: true },
  { id: 'long_liquidations', re: /\blong (liquidations?|positions? (liquidated|wiped))|\blongs? (liquidated|wiped out|rekt)|crypto (sell-?off|crash|rout)/i, dir: -1, strength: 0.4, hours: 12, scope: 'market', label: 'Long liquidations / sell-off' },
  { id: 'short_squeeze', re: /\bshort (liquidations?|squeeze)|\bshorts? (liquidated|squeezed|wiped out)/i, dir: 1, strength: 0.25, hours: 12, scope: 'market', label: 'Short squeeze (shorts liquidated)', sellNews: true },
];

// A headline that denies, doubts or speculates is not an event: "unaffected", "little chance", "could", "potential", a question mark... Hedged items are reported as 'uncertain', weak, and never trigger a veto.
const HEDGE = /\b(unaffected|not affected|isn'?t affected|no (sign|risk|impact|evidence|chance)|little chance|low chance|denies|denied|dismiss(es|ed)? (rumou?rs?|reports?)|rul(e|es|ed) out|false|fake|rumou?rs?|speculat\w+|could|might|may|potential(ly)?|possible|possibly|would|ahead of|helped pioneer|former|expects?|odds|traders (now )?see|analysts? (say|expect|see)|plans? to|considering|weighs?|mulls?)\b|\bif\b|\?\s*$/i;
const escRe =(s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAJOR_ALIASES = { BTC: ['bitcoin', 'btc'], ETH: ['ethereum', 'ether', 'eth'], SOL: ['solana', 'sol'], XRP: ['xrp', 'ripple'], BNB: ['bnb', 'binance coin'], DOGE: ['dogecoin', 'doge'], ADA: ['cardano', 'ada'], AVAX: ['avalanche', 'avax'], LINK: ['chainlink', 'link'] };

/** Does the headline name this coin? Symbol needs 3+ characters (or a known alias) and a word boundary, so "ONE" or "NEAR" do not match ordinary words by accident. */
export function mentionsCoin(title, coin) {
  const names = [...(MAJOR_ALIASES[coin.symbol] ?? [])];
  if (coin.name) names.push(coin.name.toLowerCase());
  if (coin.symbol.length >= 3) names.push(coin.symbol.toLowerCase());
  return names.some((n) => n.length >= 3 && new RegExp(`\\b${escRe(n)}\\b`, 'i').test(title));
}

/**
 * Turn raw headlines into events. items: [{ title, source, tier, publishedAt, kind }]. coins: [{ symbol, name }] used to resolve which coins a coin-scoped event names.
 * An item that matches both a bullish and a bearish rule is reported once as 'uncertain' with the stronger rule's strength halved.
 */
export function extractEvents(items, coins, now = Date.now()) {
  const events = [];
  for (const it of items ?? []) {
    if (!it?.title) continue;
    const age = it.publishedAt ? (now - it.publishedAt) / H : null;
    const hits = RULES.filter((r) => r.re.test(it.title));
    if (!hits.length) continue;
    const bull = hits.filter((r) => r.dir > 0), bear = hits.filter((r) => r.dir < 0);
    const top = hits.slice().sort((a, b) => b.strength - a.strength)[0];
    const hedged = HEDGE.test(it.title), conflict = bull.length > 0 && bear.length > 0;
    const mixed = conflict || hedged;
    const named = coins.filter((c) => mentionsCoin(it.title, c)).map((c) => c.symbol);
    if (top.scope === 'coin' && !named.length) continue;                       // a coin-specific event that names no coin we know is not usable
    const tierMul = it.tier === 3 ? 1 : it.tier === 4 && it.kind === 'social' ? 0.6 : 0.85;   // official > reputable news > unverified social
    events.push({
      what: it.title.slice(0, 200), source: it.source, tier: it.tier ?? 4, label: conflict ? `${bull[0].label} vs ${bear[0].label}` : top.label, rule: top.id,
      scope: top.scope, coins: top.scope === 'market' ? [] : named, publishedAt: it.publishedAt ?? null, ageHours: age != null ? +age.toFixed(1) : null,
      direction: mixed ? 'uncertain' : top.dir > 0 ? 'bullish' : 'bearish', dir: mixed ? 0 : top.dir, hedged,
      strength: +(top.strength * tierMul * (hedged ? 0.4 : mixed ? 0.5 : 1)).toFixed(2), durationHours: top.hours, sellTheNews: !!top.sellNews,
    });
  }
  return dedupe(events);
}

/** Several outlets repeating one fact are ONE event (CLAUDE.md: no duplicate counting across aggregators). Same rule + same coins + within 12h = one. */
function dedupe(events) {
  const out = [];
  for (const e of events.sort((a, b) => (a.ageHours ?? 999) - (b.ageHours ?? 999))) {
    const dup = out.find((x) => x.rule === e.rule && x.direction === e.direction && JSON.stringify(x.coins) === JSON.stringify(e.coins) && Math.abs((x.ageHours ?? 0) - (e.ageHours ?? 0)) <= 12);
    if (dup) { dup.corroboratedBy = (dup.corroboratedBy ?? 0) + 1; if (e.tier < dup.tier) { dup.tier = e.tier; dup.source = e.source; } continue; }
    out.push({ ...e });
  }
  return out;
}

/** Strength left after time: full for the first half of its duration, then fading linearly to zero at 1.5x the duration. Unknown age counts as half strength. */
export function decayed(e) {
  if (e.ageHours == null) return e.strength * 0.5;
  const f = e.ageHours <= e.durationHours * 0.5 ? 1 : Math.max(0, 1 - (e.ageHours - e.durationHours * 0.5) / e.durationHours);
  return e.strength * f;
}

/**
 * Has price already reacted? Compare the coin's move since the headline with the direction. `since` = % move (fraction) since publication; null when we have no price history that far back.
 * A bullish headline after the coin has already run +4% is mostly priced in (and a "sell the news" candidate); a bullish headline with no move yet is not.
 */
export function pricedIn(event, sincePct, atrPct) {
  if (sincePct == null || event.dir === 0) return 'unknown';
  const aligned = sincePct * event.dir;
  const unit = Math.max(atrPct ?? 0.01, 0.005);
  if (aligned >= unit * 3) return 'yes';
  if (aligned >= unit * 1.2) return 'partly';
  return 'no';
}

/**
 * Net effect of the events on ONE coin. effect in -1..1 (what the Brain adds to its score), dangerous = a fresh, strong, negative event the Brain must not trade into.
 * moveSince(publishedAt) -> fraction move of the coin since then (or null). Events already priced in count for less; bullish events that are priced in on a sellTheNews rule count as 0.
 */
export function coinImpact(events, coin, moveSince, atrPct) {
  const rel = events.filter((e) => e.scope === 'market' || e.coins.includes(coin.symbol));
  let sum = 0, danger = null;
  const used = rel.map((e) => {
    const d = decayed(e);
    const pi = e.publishedAt && moveSince ? pricedIn(e, moveSince(e.publishedAt), atrPct) : 'unknown';
    const pm = pi === 'yes' ? (e.dir > 0 && e.sellTheNews ? 0 : 0.35) : pi === 'partly' ? 0.65 : 1;
    const contrib = e.dir * d * pm;
    sum += contrib;
    const officialOrCorroborated = e.tier === 3 || (e.corroboratedBy ?? 0) >= 1;
    const canVeto = e.scope === 'market' ? d >= 0.55 && officialOrCorroborated : d >= 0.45;      // one unofficial headline can never veto the whole market
    if (e.dir < 0 && canVeto && !e.hedged && pi !== 'yes') danger = danger && danger.d >= d ? danger : { d, why: `${e.label}: "${e.what.slice(0, 90)}"` };
    return { what: e.what, label: e.label, scope: e.scope, direction: e.direction, strength: +d.toFixed(2), durationHours: e.durationHours, ageHours: e.ageHours, pricedIn: pi, source: e.source, tier: e.tier, effect: +contrib.toFixed(2) };
  }).filter((e) => e.strength > 0.05);
  return { effect: +Math.max(-1, Math.min(1, sum)).toFixed(2), dangerous: !!danger, danger: danger?.why ?? null, events: used.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, 6) };
}

/** Market-wide read: net direction of every market-scope event plus macro readings from FRED (oil, dollar, VIX, yields) when available. */
export function marketImpact(events, macro) {
  const mk = events.filter((e) => e.scope === 'market');
  const net = mk.reduce((s, e) => s + e.dir * decayed(e), 0);
  const risks = [];
  for (const e of mk.filter((x) => x.dir < 0 && decayed(x) >= 0.3)) risks.push({ kind: 'news', text: `${e.label}: ${e.what.slice(0, 110)}`, severity: +decayed(e).toFixed(2), source: e.source });
  const m = macro?.ok ? macro.data : null;
  if (m?.vix?.value >= 25) risks.push({ kind: 'macro', text: `VIX ${m.vix.value} (fear elevated, as of ${m.vix.asOf})`, severity: m.vix.value >= 30 ? 0.8 : 0.5, source: 'FRED' });
  if (m?.oil?.changePct >= 5) risks.push({ kind: 'macro', text: `WTI oil +${m.oil.changePct.toFixed(1)}% over the last week ($${m.oil.value})`, severity: 0.4, source: 'FRED' });
  if (m?.dollar?.changePct >= 1) risks.push({ kind: 'macro', text: `US dollar index +${m.dollar.changePct.toFixed(1)}% over the last week`, severity: 0.4, source: 'FRED' });
  if (m?.us10y_yield && m?.us2y_yield && m.us2y_yield.value > m.us10y_yield.value) risks.push({ kind: 'macro', text: `yield curve inverted (2y ${m.us2y_yield.value}% > 10y ${m.us10y_yield.value}%)`, severity: 0.25, source: 'FRED' });
  const macroTilt = (m?.vix?.value >= 25 ? -0.3 : 0) + (m?.oil?.changePct >= 5 ? -0.1 : 0) + (m?.dollar?.changePct >= 1 ? -0.1 : 0);
  return { effect: +Math.max(-1, Math.min(1, net + macroTilt)).toFixed(2), risks, eventCount: mk.length };
}
