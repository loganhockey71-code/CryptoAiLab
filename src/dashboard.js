// Pure helpers behind the dashboard's Categories, Alerts, AI Leaderboard and Hot pages. No I/O, no randomness: every number here is
// either a plain transform of real input or explicitly absent (never invented) when its input is missing.

/** Which category tags apply to one coin: 'major' by rank, plus any CoinGecko category slug whose fetched id set contains this coin.
 *  bySlug: Map<slug, Set<coingecko_id>>. coin: { id (coingecko id), rank (trade rank, 1 = biggest) }. Never empty: 'uncategorized' when nothing else matches. */
export function categoriesFor(coin, bySlug, categoryList, majorRank) {
  const tags = [];
  if (coin.rank != null && coin.rank <= majorRank) tags.push('major');
  for (const { slug } of categoryList) if (bySlug.get(slug)?.has(coin.id)) tags.push(slug);
  return tags.length ? tags : ['uncategorized'];
}

/** Ring-buffer insert, newest first, capped. Mutates and returns `alerts`. `now`/`cap` are injectable for deterministic tests. */
export function pushAlert(alerts, entry, { cap = 300, now = Date.now() } = {}) {
  alerts.unshift({ at: now, ...entry });
  if (alerts.length > cap) alerts.length = cap;
  return alerts;
}

/** AI Leaderboard rows: today's live opportunities (already ranked, already carrying score/pUp/ev/rr/setup), each joined with its
 *  setup's measured record from closed paper trades. A setup with fewer than `minSample` closed trades is labeled `thin: true`
 *  rather than given a win rate that isn't backed by enough data; a setup with zero closed trades gets `history: null`. */
export function buildLeaderboard(opportunities, closedTrades, { minSample = 8, topN = 20 } = {}) {
  const bySetup = new Map();
  for (const t of closedTrades) {
    if (!t.setup) continue;
    const g = bySetup.get(t.setup) ?? { n: 0, wins: 0, sumPnlPct: 0 };
    g.n++; if (t.pnl > 0) g.wins++; g.sumPnlPct += t.pnlPct ?? 0;
    bySetup.set(t.setup, g);
  }
  return opportunities.slice(0, topN).map((o) => {
    const g = o.setupId ? bySetup.get(o.setupId) : null;
    const history = !g ? null : g.n >= minSample ? { n: g.n, winRate: +(g.wins / g.n).toFixed(2), avgPnlPct: +(g.sumPnlPct / g.n).toFixed(4) } : { n: g.n, thin: true };
    return { symbol: o.symbol, name: o.name, action: o.action, verdict: o.verdict, cls: o.cls, score: o.score, scores: o.scores, pUp: o.pUp, pUpSource: o.pUpSource, ev: o.ev, evLB: o.evLB, rr: o.rr, setup: o.setup, setupId: o.setupId, history };
  });
}

/** A transparent "what's hot" score: the sum of whichever signals are actually present for this coin, each named in `parts` so the
 *  UI can show the breakdown instead of a hidden number. A missing input contributes nothing and is absent from `parts`/`available`
 *  (not zero) so the UI can tell "no signal" apart from "neutral signal". Only upward momentum counts (buying weakness is a
 *  different, separate strategy, not "hot"). */
export function hotScore(row, { trendingBonus = 1.5 } = {}) {
  const parts = {};
  if (row.rvol != null) parts.volume = +row.rvol.toFixed(2);
  if (row.chg1h != null && row.chg1h > 0) parts.momentum1h = +(row.chg1h * 20).toFixed(2);
  if (row.chg24h != null && row.chg24h > 0) parts.momentum24h = +(row.chg24h * 8).toFixed(2);
  if (row.trending) parts.trending = trendingBonus;
  if (row.sentiment != null && row.sentimentCount > 0) parts.sentiment = +Math.max(0, row.sentiment).toFixed(2);
  const total = +Object.values(parts).reduce((a, b) => a + b, 0).toFixed(2);
  return { total, parts, available: Object.keys(parts) };
}
