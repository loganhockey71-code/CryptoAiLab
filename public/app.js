'use strict';
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null || !isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const price = (n) => (n == null ? '—' : n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toPrecision(4));
const pct = (n, d = 2) => (n == null || !isFinite(n) ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(d) + '%');
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? `${s | 0}s ago` : s < 5400 ? `${(s / 60) | 0}m ago` : `${(s / 3600).toFixed(1)}h ago`; };
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

let selected = 'BTC';
let latest = null;

/* ------------------------------------------------------------------ chart */
const chart = LightweightCharts.createChart($('#chart'), {
  layout: { background: { color: '#121722' }, textColor: '#9aa7bf' },
  grid: { vertLines: { color: '#1a2132' }, horzLines: { color: '#1a2132' } },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#232b3d' },
  rightPriceScale: { borderColor: '#232b3d' },
  crosshair: { mode: 1 },
  autoSize: true,
});
const series = chart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
let chartFor = null;

async function refreshChart() {
  try {
    const r = await fetch(`/api/candles/${encodeURIComponent(selected)}`);
    if (!r.ok) { series.setData([]); $('#chart-note').textContent = (await r.json()).error || 'no data'; return; }
    const d = await r.json();
    if (d.symbol !== selected) return;
    series.setData(d.candles);
    series.setMarkers(d.markers.filter((m) => d.candles.some((c) => c.time === m.time)));
    if (chartFor !== selected) { chart.timeScale().fitContent(); chartFor = selected; }
    $('#chart-note').textContent = `${d.candles.length} candles · live Coinbase feed`;
  } catch { /* retry next tick */ }
}
setInterval(refreshChart, 2000);

/* ----------------------------------------------------------------- render */
function renderStats(s) {
  const p = s.portfolio, h = s.health;
  const stat = (label, val, c = '') => `<div class="stat"><b class="${c}">${val}</b><span>${label}</span></div>`;
  const btc = s.btc.regime;
  $('#stats').innerHTML = [
    stat('Equity', money(p.equity)),
    stat('Cash', money(p.cash)),
    stat('Realized P&L', money(p.realized_pnl), cls(p.realized_pnl)),
    stat('Today (UTC)', pct(p.dailyPnlPct), cls(p.dailyPnlPct)),
    stat('BTC 1h EMA (info)', btc.toUpperCase(), btc === 'bullish' ? 'up' : btc === 'bearish' ? 'down' : 'warn'),
    `<a class="stat jump" href="#trade-history" title="Jump to Trade History"><b>${s.tradeCount ?? 0}</b><span>Trades ↓ history</span></a>`,
    stat('Open', `${s.positions.length}/${s.limits.maxPositions}`),
    stat('Feed', h.wsConnected ? (h.feedStale ? 'STALE' : 'LIVE') : 'OFFLINE', h.wsConnected && !h.feedStale ? 'up' : 'down'),
    stat('Scan', s.scan.running ? esc(s.scan.progress || 'running') : s.scan.finishedAt ? `#${s.scan.count} ${ago(s.scan.finishedAt)}` : 'starting', s.scan.lastError ? 'down' : ''),
  ].join('');

  const notes = [];
  if (!p.gate.allowed) notes.push(`Trading blocked: ${p.gate.reason}`);
  if (!h.supabase) notes.push('Supabase key missing: nothing is being persisted');
  if (!h.llm) notes.push('No LLM key: the optional AI second-look reviewer is off. The Brain still analyses and trades on its own.');
  if (s.scan.lastError) notes.push(`Last scan error: ${s.scan.lastError}`);
  const srcDown = Object.entries(h.sources).filter(([, v]) => !v.ok).map(([k, v]) => `${k} (${v.error})`);
  if (srcDown.length) notes.push(`Unreliable sources: ${srcDown.join('; ')}`);
  const b = $('#banner');
  if (notes.length) {
    b.classList.remove('hidden');
    b.innerHTML = `<div>${notes.map(esc).join('<br>')}</div>` + (p.manual_review_required ? '<button id="clear-review">I reviewed the model: resume</button>' : '');
    const btn = $('#clear-review');
    if (btn) btn.onclick = async () => { if (confirm('Clear the manual-review lock and allow trading again?')) await fetch('/api/manual-review/clear', { method: 'POST', headers: { 'x-requested-with': 'dashboard' } }); };
  } else b.classList.add('hidden');
}

const chgCell = (r) => { const f = (x) => (x == null ? '—' : `<span class="${cls(x)}">${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%</span>`); return `${f(r.chg1h)} <span class="muted">/</span> ${f(r.chg24h)}`; };

// "Rising" toggles: show only coins going up on every selected timeframe (1m candle green, 1h change > 0, 24h change > 0).
const upOn = new Set();
try { for (const k of JSON.parse(localStorage.getItem('upOn') || '[]')) upOn.add(k); } catch { /* storage unavailable: toggles still work this session */ }
// The most recently switched-on toggle also decides the ORDER: best performer on that timeframe first.
const perf = { m1: (r) => (r.candle ? (r.candle.c - r.candle.o) / r.candle.o : -Infinity), h1: (r) => r.chg1h ?? -Infinity, h24: (r) => r.chg24h ?? -Infinity };
const isUp = { m1: (r) => !!r.candle && r.candle.c > r.candle.o, h1: (r) => r.chg1h != null && r.chg1h > 0, h24: (r) => r.chg24h != null && r.chg24h > 0 };

function renderTable(s) {
  const q = $('#filter').value.trim().toLowerCase();
  const gate = s.btc.bullish;
  const tbody = $('#coins tbody');
  const rows = s.rows.filter((r) => (!q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) && [...upOn].every((k) => isUp[k](r)));
  const sortKey = [...upOn].pop();
  if (sortKey) rows.sort((a, b) => perf[sortKey](b) - perf[sortKey](a));
  const tfName = { m1: '1m', h1: '1h', h24: '24h' };
  $('#universe-note').textContent = upOn.size ? `${rows.length} of ${s.rows.length} rising on ${[...upOn].map((k) => tfName[k]).join(' + ')} · best ${tfName[sortKey]} first` : `${s.rows.length} tradable coins (every Coinbase USD market) by market cap`;
  document.querySelectorAll('#up-toggles .tog').forEach((b) => b.classList.toggle('on', upOn.has(b.dataset.tf)));
  tbody.innerHTML = rows.map((r) => {
    const c = r.candle;
    const candle = c ? `<span class="${c.c >= c.o ? 'up' : 'down'}">${c.c >= c.o ? '▲' : '▼'} ${pct((c.c - c.o) / c.o)}</span> <span class="muted">${price(c.l)}–${price(c.h)}</span>` : '<span class="muted">—</span>';
    const sig = r.signal.startsWith('IN') ? `<span class="pill good">${r.signal}</span>` : r.signal.startsWith('AWAIT') ? `<span class="pill amber">${r.signal}</span>` : `<span class="muted">${esc(r.signal)}</span>`;
    const gateCell = !r.cls ? '<span class="muted">—</span>' : `<span class="pill ${r.cls === 'HOT' ? 'hotc' : r.cls === 'AVOID' ? 'avoidc' : r.cls === 'WATCH' ? 'amber' : ''}">${r.cls}</span>`;
    const data = !r.tradable ? `<span class="muted" title="excluded">${esc(r.excluded)}</span>`
      : r.cooldownUntil ? `<span class="pill amber" title="2h stop-loss cooldown">cooldown</span>`
      : r.thin ? `<span class="pill amber" title="24h volume $${Math.round(r.volume24h).toLocaleString('en-US')}: tracked, but never entered (too thin to fill)">thin volume</span>`
      : r.health === 'ok' ? (r.stale ? '<span class="pill amber">stale tick</span>' : '<span class="pill good">ok</span>')
      : `<span class="pill bad" title="${esc(r.health)}">unreliable</span>`;
    const disc = r.discrepancy ? ` <span class="warn" title="${esc(r.discrepancy)}">⚠</span>` : '';
    const score = r.score == null ? '<span class="muted">—</span>' : `<span class="${r.score >= s.limits.minConfluence ? 'up' : ''}">${r.score.toFixed(0)}</span>`;
    return `<tr data-sym="${esc(r.symbol)}" class="${r.symbol === selected ? 'sel' : ''} ${r.tradable ? '' : 'off'}">
      <td class="muted" title="market-cap rank #${r.cgRank}">${r.rank}${disc}</td><td><b>${esc(r.symbol)}</b> <span class="muted">${esc(r.name)}</span>${r.hot ? ` <span class="pill hot" title="${esc((r.hotReasons || []).join(', '))}">${r.dump ? 'UNUSUAL' : 'HOT'}</span>` : r.dump ? ' <span class="pill bad" title="sharp drop">DUMP</span>' : ''}</td>
      <td class="r">${price(r.price)}</td><td class="r">${chgCell(r)}</td><td>${candle}</td><td>${sig}</td><td class="r">${score}</td><td>${gateCell}</td>
      <td class="r ${r.rvol > 1.5 ? 'up' : ''}">${r.rvol == null ? '—' : r.rvol.toFixed(2)}</td>
      <td class="r">${r.funding == null ? '—' : r.funding.toFixed(4) + '%'}</td>
      <td class="r ${cls(r.sentiment)}" title="${r.sentimentCount} headline(s)">${r.sentiment == null ? '—' : r.sentiment.toFixed(2)}</td><td>${data}</td></tr>`;
  }).join('');
}

function renderPositions(s) {
  const el = $('#positions');
  const pend = s.pending.map((p) => `<div class="item"><div class="meta"><b>${esc(p.symbol)}</b><span class="pill amber">awaiting candle confirmation</span><span>ref ${price(p.refPrice)}</span><span>score ${p.score}</span><span>${ago(p.createdAt)}</span></div></div>`).join('');
  if (!s.positions.length && !pend) { el.innerHTML = '<div class="empty">100% cash. No open paper positions.</div>'; return; }
  el.innerHTML = s.positions.map((p) => `<div class="item" data-sym="${esc(p.symbol)}" style="cursor:pointer">
    <div class="meta"><b>${esc(p.symbol)}</b><span class="pill ${p.side === 'short' ? 'bad' : 'good'}">${esc(p.side)}</span>${p.source === 'copy' ? '' : `<span class="pill own" title="${esc((p.trigger?.reasons || []).join(', '))}">${p.mode === 'exploration' ? 'EXPLORATION (tiny risk)' : 'AI ANALYSIS'}${p.trigger?.kind === 'mover' ? ' · mover' : ''}</span>`}${p.source === 'copy' ? `<span class="pill amber" title="${esc(p.trader)}">copy ${p.venue === 'onchain' ? 'on-chain ' : ''}${esc(p.trader.slice(0, 8))} · ${(p.traderWinRate * 100).toFixed(0)}% win rate</span>` : ''}<span>entry ${price(p.entry)}</span>${p.leaderPx ? `<span>leader ${price(p.leaderPx)}</span>` : ''}<span>now ${price(p.price)}</span>${p.target ? `<span>target ${price(p.target)}</span>` : ''}<span>${p.source === 'copy' ? 'hard stop' : 'stop'} ${price(p.stop)}</span>${p.trailing ? `<span>trail ${price(p.trailing)}</span>` : ''}${p.rr != null ? `<span>R:R ${p.rr.toFixed(2)}</span>` : ''}<span>${money(p.notional)}</span></div>
    <div><b class="${cls(p.pnl)}">${money(p.pnl)} (${pct(p.pnlPct)})</b> <span class="muted">net of fees/slippage · opened ${ago(p.openedAt)}</span></div>
    <div class="why"><b>Why it entered:</b> ${esc(p.why)}</div></div>`).join('') + pend;
}

const typeClass = { entered: 'good', exit: 'amber', skipped: '', confirmed: 'good', candidate: 'amber', breaker: 'bad', info: '', reflection: '' };
function renderDecisions(s) {
  const el = $('#decisions');
  el.innerHTML = s.decisions.length ? s.decisions.map((d) => `<div class="item"><div class="meta"><span>${hhmm(d.at)}</span><span class="pill ${typeClass[d.type] || ''}">${esc(d.type)}</span><b>${esc(d.symbol)}</b></div><div>${esc(d.message)}</div></div>`).join('')
    : '<div class="empty">No decisions yet. The first scan evaluates the whole Top 100.</div>';
}

function renderReflections(s) {
  const el = $('#reflections');
  const list = (a) => (a && a.length ? a.map(esc).join('; ') : '—');
  el.innerHTML = s.reflections.length ? s.reflections.map((r) => `<div class="item">
    <div class="meta"><b>${esc(r.symbol)}</b><span class="pill ${r.outcome === 'win' ? 'good' : 'bad'}">${esc(r.outcome)}</span><span class="${cls(r.final_pnl)}">${money(Number(r.final_pnl))}</span><span>${ago(new Date(r.created_at).getTime())}</span><span>${esc(r.market_regime)}</span></div>
    <div><b>Lesson:</b> ${esc(r.lesson)}</div>
    <div class="why"><b>Result:</b> ${esc(r.actual_result)}</div>
    <div class="why"><b>Held true:</b> ${list(r.indicators_correct)}</div>
    <div class="why"><b>Failed:</b> ${list(r.indicators_wrong)}</div>
    <div class="why"><b>News that mattered:</b> ${list(r.news_impact?.mattered)} · <b>irrelevant:</b> ${list(r.news_impact?.irrelevant)}</div>
    <div class="why"><b>Candle:</b> ${esc(r.candle_pattern)} · <b>Predicted:</b> ${esc(r.prediction)}</div></div>`).join('')
    : '<div class="empty">No completed trades yet. A post-mortem is written after every trade, win or lose.</div>';
}

const reasonLabel = { brain_sell: 'AI SELL: structure broke', stop_loss: 'hit stop-loss', downtrend_exit: 'downtrend: cut early', trailing_stop: 'trailing stop', momentum_reversal: 'momentum reversed', leader_exit: 'trader exited', leader_flip: 'trader flipped', leader_exit_while_offline: 'trader exited (offline)', circuit_breaker_daily_loss: 'daily loss cap' };
const sourceLabel = (t) => (t.source === 'copy_hyperliquid' ? `copy · Hyperliquid ${t.trader ? t.trader.slice(0, 6) : ''}` : t.source === 'copy_zerion' ? `copy · on-chain ${t.trader ? t.trader.slice(0, 6) : ''}` : 'LLM strategy');
const typePill = (t) => (t.mode === 'exploration' ? `<span class="pill amber">EXPLORATION</span> <span class="muted">lower R:R test, tiny risk</span>` : t.origin === 'mimic'
  ? `<span class="pill amber">MIMIC</span> <span class="muted">${esc(sourceLabel(t).replace('copy · ', ''))}</span>`
  : `<span class="pill own">OWN IDEA</span> <span class="muted" title="${esc((t.triggerReasons || []).join(', '))}">${t.trigger === 'brain' ? 'AI analysis' : t.trigger === 'mover' ? 'trending / unusual mover' : 'regular scan'}</span>`);
const held = (a, b) => { const m = Math.max(0, (b - a) / 60000); return m < 90 ? `${m.toFixed(0)}m` : m < 2880 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`; };

function renderHistory(h) {
  if (!h) return;
  const s = h.stats;
  const chip = (label, val, c = '') => `<div class="chip"><b class="${c}">${val}</b><span>${label}</span></div>`;
  $('#history-stats').innerHTML = s.count
    ? [chip('Trades', s.count), chip('Won', s.wins, 'up'), chip('Lost', s.losses, 'down'), chip('Win rate', (s.winRate * 100).toFixed(0) + '%', s.winRate >= 0.5 ? 'up' : 'down'), chip('Net P&L', money(s.net), cls(s.net)),
       chip('Own ideas', `${h.byOrigin.own.wins}W–${h.byOrigin.own.losses}L · ${money(h.byOrigin.own.net)}`, cls(h.byOrigin.own.net)), chip('Mimic', `${h.byOrigin.mimic.wins}W–${h.byOrigin.mimic.losses}L · ${money(h.byOrigin.mimic.net)}`, cls(h.byOrigin.mimic.net)), chip('Avg win', money(s.avgWin), 'up'), chip('Avg loss', money(s.avgLoss), 'down'), chip('Best', money(s.best), cls(s.best)), chip('Worst', money(s.worst), cls(s.worst))].join('')
    : '';
  $('#history').innerHTML = h.trades.length
    ? `<table><thead><tr><th>Result</th><th>Closed</th><th>Coin</th><th>Side</th><th>Type</th><th class="r">Entry</th><th class="r">Exit</th><th class="r">Size</th><th class="r">Net P&amp;L</th><th class="r">Net %</th><th>Why it closed</th><th class="r">Held</th></tr></thead><tbody>${h.trades.map((t) => `<tr data-sym="${esc(t.symbol)}">
        <td><span class="pill ${t.result}">${t.result === 'win' ? 'WIN' : 'LOSS'}</span></td><td class="muted" title="${esc(new Date(t.closedAt).toLocaleString())}">${ago(t.closedAt)}</td>
        <td><b>${esc(t.symbol)}</b></td><td><span class="pill ${t.side === 'short' ? 'bad' : 'good'}">${esc(t.side)}</span></td><td title="${esc(t.trader || '')}">${typePill(t)}</td>
        <td class="r">${price(t.entry)}</td><td class="r">${price(t.exit)}</td><td class="r">${money(t.notional)}</td>
        <td class="r ${cls(t.pnl)}"><b>${t.pnl >= 0 ? '+' : ''}${money(t.pnl)}</b></td><td class="r ${cls(t.pnl)}">${pct(t.pnlPct)}</td>
        <td class="muted">${esc(reasonLabel[t.reason] || t.reason)}</td><td class="r muted">${held(t.openedAt, t.closedAt)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No closed trades yet. Every trade the app closes will appear here with a WIN or LOSS, net of fees and slippage.</div>';
}

const kindLabel = { executive: 'White House / executive', central_bank: 'Federal Reserve', regulator: 'SEC / CFTC', politics: 'politics', world: 'world', markets: 'markets', social: 'Truth Social (unofficial)', crypto: 'crypto news', legislation: 'Congress' };
function renderNews(n) {
  if (!n) return;
  const bad = n.feeds.filter((f) => !f.ok).length;
  $('#news-status').textContent = n.at ? `${n.items.length} items · ${n.feeds.length - bad}/${n.feeds.length} feeds up · updated ${ago(n.at)}` : 'waiting for first scan…';
  $('#news-feeds').innerHTML = n.feeds.map((f) => `<span class="feedtag ${f.ok ? 'ok' : 'bad'}" title="${esc(f.error || (f.count + ' items'))}">${f.ok ? '●' : '○'} ${esc(f.name)} · T${f.tier}${f.ok ? ' · ' + f.count : ''}</span>`).join('');
  $('#news').innerHTML = n.items.length ? n.items.map((i) => `<div class="item"><div class="meta"><span>${ago(i.publishedAt)}</span><span class="pill ${i.tier === 3 ? 'good' : ''}">${esc(kindLabel[i.kind] || i.kind)}</span><span>${esc(i.source)}</span><span class="muted">tier ${i.tier}</span></div>
      <div>${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : esc(i.title)}</div></div>`).join('')
    : '<div class="empty">Nothing yet. Feeds are read on every scan (about every 5 minutes) and cached for 10.</div>';
}

function renderCopy(c) {
  if (!c) return;
  const k = c.counts, hlS = c.sources.hyperliquid, zr = c.sources.zerion;
  const phase = (d) => (d.phase === 'evaluating traders' || d.phase === 'evaluating wallets' ? `scoring ${d.evaluated}/${d.total}${d.scorable != null ? ` (${d.scorable} with enough trades)` : ''}` : d.phase !== 'idle' ? d.phase : 'idle');
  $('#copy-status').textContent = `${k.qualified} qualified (${k.preferred} at ≥80%) of ${k.evaluated} scored · tracking ${k.tracking} · ` +
    `Hyperliquid: ${hlS.connected ? 'live' : 'offline'}, ${phase(hlS.discovery)} · Zerion: ${zr.enabled ? phase(zr.discovery) : 'OFF (no API key)'}` +
    (zr.birdeye ? ` · Birdeye: ${zr.birdeye.status}${zr.birdeye.lastAt ? ` (${zr.birdeye.lastFound} wallets, ${zr.birdeye.callsToday}/${zr.birdeye.cap} calls today)` : ''}` : '');
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const streakPill = (t) => {
    const s = t.streak;
    if (!s || !s.losses) return '';
    const cls2 = s.state === 'ok' ? 'amber' : 'bad';
    const rel = s.state === 'review' || s.state === 'removed' ? ` <button data-release="${esc(t.address)}">release</button>` : '';
    return `<br><span class="pill ${cls2}" title="${esc(s.label)}">${s.state === 'removed' ? 'removed' : s.state === 'review' ? 'review needed' : s.state === 'paused' ? 'paused' : s.losses + ' loss'}</span>${rel}`;
  };
  const badge = (t) => (t.tracking ?`<span class="pill good">tracking${t.tier === 'preferred' ? ' · ≥80%' : ' · ≥75%'}</span>` : t.status === 'qualified' ? '<span class="pill amber">qualified (bench)</span>' : '<span class="pill bad">rejected</span>') + streakPill(t);
  const src = (t) => t.source === 'zerion' ? `<span class="pill" title="${esc((t.chains || []).join(', '))}">on-chain</span>` : '<span class="pill">Hyperliquid</span>';
  const rows = c.traders.map((t) => `<tr>
    <td>${src(t)}</td>
    <td title="${esc(t.address)}"><b>${esc(t.name || short(t.address))}</b>${t.name ? `<br><span class="muted">${esc(short(t.address))}</span>` : ''}</td>
    <td>${badge(t)}</td><td class="r ${t.winRate >= 0.8 ? 'up' : t.winRate >= 0.75 ? '' : 'down'}"><b>${(t.winRate * 100).toFixed(0)}%</b></td>
    <td class="r">${t.trades}</td><td class="r">${t.profitFactor >= 99 ? '∞' : t.profitFactor.toFixed(1)}</td><td class="r ${cls(t.netPnl)}">${money(t.netPnl)}</td>
    <td class="r">${t.perDay.toFixed(1)}</td><td class="r">${t.days}d</td><td class="r">${money(t.accountValue)}</td>
    <td>${t.holding.length ? esc(t.holding.join(', ')) : '<span class="muted">flat / not copied</span>'}</td>
    <td class="muted" style="white-space:normal;min-width:180px">${esc(t.reason || '')}</td></tr>`).join('');
  const notes = [];
  if (!zr.enabled) notes.push(`<div class="empty" style="padding:8px 12px">On-chain copy trading is off: ${esc(zr.status)}. Add ZERION_API_KEY to .env and restart.</div>`);
  else if (zr.status !== 'ok') notes.push(`<div class="empty warn" style="padding:8px 12px">Zerion: ${esc(zr.status)}</div>`);
  $('#copy').innerHTML = notes.join('') + (c.traders.length
    ? `<table><thead><tr><th>Source</th><th>Trader / wallet</th><th>Status</th><th class="r">Win rate</th><th class="r">Closed trades</th><th class="r">Profit factor</th><th class="r">Net P&amp;L (${c.rules.windowDays}d)</th><th class="r">Closes/day</th><th class="r">History</th><th class="r">Account</th><th>Holding (copied)</th><th>Why rejected</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty">Scanning the Hyperliquid leaderboard and on-chain wallets and scoring traders. Nobody is copied until they pass: win rate ≥ 75%, ≥ 30 closed trades, 7+ days of history, profit factor ≥ 1.5.</div>`);
}

function renderRadar(r) {
  if (!r) return;
  const chip = (label, val, c = '') => `<div class="chip"><b class="${c}">${val}</b><span>${label}</span></div>`;
  const rej = Object.entries(r.rejected || {}).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
  $('#radar-chips').innerHTML = [
    chip('Coins monitored', r.monitored.toLocaleString('en-US')), chip('Tradable here', r.tradable), chip('Watch only', r.watchOnly.toLocaleString('en-US')),
    chip('Shortlist', `${r.shortlistSize}/${r.shortlistTarget}`), chip('Deep research slots', r.researchMax), chip('Last sweep', r.sweeping ? 'sweeping…' : r.sweepAt ? ago(r.sweepAt) : '—', r.error ? 'warn' : ''),
    chip('AI signals OK', r.research?.rate == null ? '—' : `${(r.research.rate * 100).toFixed(0)}% of ${r.research.signals}`, r.research?.rate != null && r.research.rate < 0.8 ? 'warn' : ''), chip('AI models usable', r.research?.providers ? `${r.research.providers.filter((x) => x.state === 'ok').length}/${r.research.providers.length}${r.research.resumeAt ? ' · back ' + new Date(r.research.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}` : '—', r.research?.providers?.some((x) => x.state === 'down') ? 'warn' : ''), chip('Last AI error', r.research?.lastError ? `${esc(r.research.lastError.slice(0, 40))} · ${ago(r.research.lastErrorAt)}` : 'none'),
    chip('Tradable refresh', r.hotAt ? ago(r.hotAt) : '—'), chip('Next full sweep', r.nextSweepAt ? (r.nextSweepAt > Date.now() ? 'in ' + Math.round((r.nextSweepAt - Date.now()) / 60000) + 'm' : 'due') : '—'),
    chip('CoinGecko calls 24h', r.coingecko ? r.coingecko.callsLast24h.toLocaleString('en-US') : '—', r.coingecko?.pausedUntil ? 'warn' : ''),
    chip('Screened out', rej || 'none'),
  ].join('');
  const rows = (list, fmt) => (list.length ? list.map(fmt).join('') : '<div class="empty">Nothing yet.</div>');
  const why = (x) => esc((x.reasons || []).slice(0, 3).join(' · ') || '—');
  $('#radar-queue').innerHTML = rows(r.researchQueue, (x) => `<div class="radar-row"><span><b>${esc(x.symbol)}</b> <span class="muted">${why(x)}</span></span><span>${x.priority}</span></div>`);
  $('#radar-short').innerHTML = rows(r.shortlist, (x) => `<div class="radar-row"><span><b>${esc(x.symbol)}</b> <span class="muted">${why(x)}</span></span><span>${x.score}</span></div>`);
  $('#radar-watch').innerHTML = rows(r.watchMovers, (x) => `<div class="radar-row"><span><b>${esc(x.symbol)}</b> <span class="muted">${esc(x.name)}${x.cgRank ? ` · #${x.cgRank}` : ''}</span></span><span class="${cls(x.chg24h)}">${x.chg1h == null ? '—' : (x.chg1h * 100).toFixed(1) + '%'} / ${x.chg24h == null ? '—' : (x.chg24h * 100).toFixed(1) + '%'}</span></div>`);
}

/* -------------------------------------------------------------- the Brain */
const TRN = { strong_up: ['▲▲', 'up'], up: ['▲', 'up'], range: ['■', 'fl'], down: ['▼', 'dn'], strong_down: ['▼▼', 'dn'] };
const trendTags = (t) => (t ? Object.entries(t).map(([k, v]) => { const [g, c] = TRN[v] || ['?', 'fl']; return `<i class="${c}" title="${esc(String(v).replace('_', ' '))}">${k} ${g}</i>`; }).join('') : '—');
const sdText = (f) => (f ? `1h ${esc(String(f.h1).replace('_', ' '))}${f.h1shift && f.h1shift !== 'none' ? ' · ' + esc(f.h1shift.replace('_', ' ')) : ''}; 15m ${esc(String(f.m15).replace('_', ' '))}${f.absorption ? ' · ' + esc(f.absorption.replace(/_/g, ' ')) : ''}` : '—');
const clsPill = (c) => `<span class="pill ${c === 'HOT' ? 'hotc' : c === 'AVOID' ? 'avoidc' : c === 'WATCH' ? 'amber' : ''}">${esc(c)}</span>`;
const newsText = (n) => (n && n.events && n.events.length ? n.events.slice(0, 2).map((e) => `${esc(e.label)} <span class="${e.direction === 'bullish' ? 'up' : e.direction === 'bearish' ? 'down' : 'muted'}">${esc(e.direction)}</span> (${e.pricedIn === 'unknown' ? 'priced-in unknown' : e.pricedIn === 'no' ? 'not priced in' : 'priced in: ' + esc(e.pricedIn)})`).join('; ') : '<span class="muted">no relevant headline</span>');

function renderBrain(b) {
  if (!b) return;
  ruleSet = b.rules;
  const rg = b.regime;
  const chip = (label, val, c = '') => `<div class="chip"><b class="${c}">${val}</b><span>${label}</span></div>`;
  const rc = !rg ? 'warn' : rg.score >= 0.25 ? 'up' : rg.score <= -0.25 ? 'down' : 'warn';
  $('#regime').innerHTML = rg ? `<div class="chips" style="padding:0 0 8px;border:0">${chip('Regime', esc(rg.label.replace(/_/g, ' ')), rc)}${chip('Score', rg.score, rc)}${chip('Breadth', b.breadth == null ? '—' : (b.breadth * 100).toFixed(0) + '%')}${chip('Coins analysed', b.analysed)}${chip('LONG', b.counts.BUY || 0, 'up')}${chip('SHORT', b.counts.SHORT || 0, 'down')}${chip('WAIT', b.counts.WAIT || 0)}${chip('AVOID', b.counts.AVOID || 0, 'down')}${chip('News effect', b.market ? (b.market.effect >= 0 ? '+' : '') + b.market.effect : '—', b.market && b.market.effect < -0.15 ? 'down' : b.market && b.market.effect > 0.15 ? 'up' : '')}</div>
    ${rg.notes.map((n) => `<p class="muted" style="margin:2px 0">${esc(n)}</p>`).join('')}
    <p class="muted" style="margin:4px 0">Regime is a <b>modifier</b>: probability ${rg.probShiftLong >= 0 ? '+' : ''}${((rg.probShiftLong || 0) * 100).toFixed(1)}pt for longs, size ${rg.riskMult}x${rg.severe ? ' · <span class="down">SEVERE: new longs blocked</span>' : ''}.</p>
    ${b.funnel ? `<h3 style="margin:10px 0 4px;font-size:12px" class="muted">OPPORTUNITY FUNNEL</h3><div class="funnel">${[['Monitored', b.funnel.monitored], ['Liquid', b.funnel.liquid], ['Tradable', b.funnel.tradable], ['Quality', b.funnel.quality], ['RS movers', b.funnel.relStrengthMovers], ['Shortlist', b.funnel.shortlist], ['Deep analysis', b.funnel.deep], ['Setups', b.funnel.setups], ['Ready', b.funnel.ready]].map(([k, v]) => `<span><b>${(v ?? 0).toLocaleString('en-US')}</b>${k}</span>`).join('<em>›</em>')}</div>` : ''}
    <h3 style="margin:10px 0 4px;font-size:12px" class="muted">NEWS EVENTS READ <span class="muted" style="font-weight:400">what happened → affected coins → direction → strength → priced in?</span></h3>
    ${b.events && b.events.length ? b.events.slice(0, 8).map((e) => `<div class="item" style="padding:5px 0"><span class="pill ${e.direction === 'bullish' ? 'good' : e.direction === 'bearish' ? 'bad' : ''}">${esc(e.direction)}</span> <b>${esc(e.label)}</b> <span class="muted">· ${e.scope === 'market' ? 'whole market' : esc((e.coins || []).join(', '))} · strength ${e.strength} · lasts ~${e.durationHours}h · ${e.ageHours == null ? 'age ?' : e.ageHours + 'h ago'} · tier ${e.tier}</span><div class="muted">${esc(e.what)}</div></div>`).join('') : '<div class="muted">No headline matched a known market-moving pattern in the last day.</div>'}`
    : '<div class="empty">Waiting for the first scan…</div>';
  $('#risks').innerHTML = (b.risks || []).length ? b.risks.map((r) => `<div class="item"><span class="sev ${r.severity >= 0.7 ? 'hi' : ''}"><b style="width:${Math.round(r.severity * 100)}%"></b></span><span class="pill ${r.severity >= 0.7 ? 'bad' : 'amber'}">${esc(r.kind)}</span> ${esc(r.text)}</div>`).join('') : '<div class="empty">No elevated risks detected.</div>';
  const opps = b.opportunities || [];
  $('#opp-note').textContent = opps.length ? `${opps.filter((o) => o.action === 'BUY').length} LONG · ${opps.filter((o) => o.action === 'SHORT').length} SHORT · ${opps.filter((o) => o.action === 'WATCH').length} WAIT · ${b.analysed} coins analysed · WAIT is the default: a good direction needs a good entry price` : 'stays in cash when nothing has an edge';
  $('#opps').innerHTML = opps.length ? opps.slice(0, 18).map(oppCard).join('') : '<div class="empty" style="grid-column:1/-1">No coin has a setup right now. The AI is waiting instead of forcing a trade: that is the correct state when there is no edge.</div>';
  $('#avoid').innerHTML = (b.avoid || []).length ? b.avoid.map((o) => `<div class="item" data-sym="${esc(o.symbol)}" style="cursor:pointer"><div class="meta"><b>${esc(o.symbol)}</b>${clsPill('AVOID')}<span class="tr">${trendTags(o.trend)}</span><span>score ${o.score}</span></div><div class="why">${esc((o.vetoes || []).slice(0, 2).join(' · '))}</div></div>`).join('') : '<div class="empty">Nothing flagged.</div>';
  renderLearning(b.learning, b.rules, b.positions);
}

let ruleSet = null;
const verdictPill = (o) => `<span class="pill ${o.verdict === 'LONG' ? 'good' : o.verdict === 'SHORT' ? 'bad' : 'amber'}">${esc(o.verdict || o.action)}</span>`;
const scoreBar = (label, v) => `<div class="sc ${v >= 60 ? 'ok' : 'low'}"><span>${label}</span><b>${v == null ? '—' : v}</b><i><u style="width:${Math.max(0, Math.min(100, v || 0))}%"></u></i></div>`;
const chaseText = (c) => (c ? `<span class="${c.verdict === 'fresh' ? 'up' : c.verdict === 'late' ? 'warn' : 'down'}"><b>${esc(c.verdict)}</b></span> (score ${c.score}): ${c.moveAtr} ATR moved in 12 bars · ${c.distLevelAtr} ATR from the level · ${(c.expectedMoveUsed * 100).toFixed(0)}% of the move used${c.atLevel ? ' · <i>back at the level (retest)</i>' : ''}${c.spikeSpent ? ' · volume spike already spent' : ''}${c.stretched ? ' · stretched' : ''}` : '—');
const rsText = (r) => (r ? `${pct(r.vs1h)} vs market (1h) · ${pct(r.vsBTC24)} vs BTC · ${pct(r.vsETH24)} vs ETH · ${pct(r.vsMkt24)} vs market (24h)` : '—');
const whyList = (w) => (w ? [['Why this coin', w.coin], ['Why this direction', w.direction], ['Why this price', w.price], ['Why NOW', w.now && w.now.length ? w.now : ['<span class="down">no concrete reason to enter at this price right now: WAIT</span>']], ['What confirms it', w.confirms], ['What invalidates it', w.invalidates], ['What could make it fail', w.failure]]
  .filter(([, a]) => a && a.length).map(([k, a]) => `<div class="wy"><span class="k">${k}</span><span>${a.map((x) => (String(x).startsWith('<span') ? x : esc(x))).join(' · ')}</span></div>`).join('') : '');

function oppCard(o) {
  const live = o.action === 'BUY' || o.action === 'SHORT';
  const lv = (x) => (x == null ? '—' : price(x));
  const sc = o.scores || {};
  return `<div class="opp ${live ? 'buy' : ''}" data-sym="${esc(o.symbol)}">
    <h4>${esc(o.symbol)} <span class="muted" style="font-weight:400">${esc(o.name)}</span> ${verdictPill(o)}${clsPill(o.cls)}${o.setup ? `<span class="pill own">${esc(o.setup)}</span>` : ''}${o.exploration ? `<span class="pill amber" title="${esc(o.exploration.reason)}">EXPLORATION · risk ${(o.exploration.riskPct * 100).toFixed(2)}%</span>` : ''}
      <span class="big"><b>${o.score}</b> composite (floor ${o.floor ?? '—'})<br>P(target first) ${(o.pUp * 100).toFixed(0)}% · EV ${o.ev == null ? '—' : o.ev + 'R'}${o.evLB != null ? ` (lower bound ${o.evLB}R)` : ''}<br>data confidence ${o.confidence == null ? '—' : (o.confidence * 100).toFixed(0) + '%'}</span></h4>
    <div class="scs">${scoreBar('Direction', sc.direction)}${scoreBar('Timing', sc.timing)}${scoreBar('Geometry', sc.geometry)}</div>
    <div class="facts">
      <span class="k">Signal</span><span>${esc(o.verdict || o.action)} · confidence ${(o.pUp * 100).toFixed(0)}% <span class="muted">(${esc(o.pUpSource || '')})</span></span>
      <span class="k">Trend</span><span class="tr">${trendTags(o.trend)}</span>
      <span class="k">Supply/demand</span><span>${sdText(o.flow)}${o.families ? ` · independent families agreeing: ${o.families.count} (${esc((o.families.agree || []).join(', ') || 'none')})` : ''}</span>
      <span class="k">Candles</span><span>${o.candles && o.candles.length ? esc(o.candles.join(', ').replace(/_/g, ' ')) : '<span class="muted">no pattern</span>'}</span>
      <span class="k">Volume</span><span>${o.volume ? `${(o.volume.rvol15 ?? 0).toFixed(1)}x (15m) · ${(o.volume.rvol1h ?? 0).toFixed(1)}x (1h)` : '—'}</span>
      <span class="k">Momentum</span><span>${o.momentum ? `RSI ${o.momentum.rsi1h ?? '—'} · 6-bar ${pct(o.momentum.roc6)} · ${o.momentum.ext1h} ATR from mean${o.momentum.overextended ? ' <span class="warn">(extended)</span>' : ''} <span class="muted">(one family: not counted as confirmation)</span>` : '—'}</span>
      <span class="k">Relative strength</span><span>${rsText(o.relStrength)}</span>
      <span class="k">Anti-chasing</span><span>${chaseText(o.chase)}</span>
      <span class="k">News effect</span><span>${newsText(o.news)}${o.news ? ` · net ${o.news.effect >= 0 ? '+' : ''}${o.news.effect}` : ''}</span>
    </div>
    <div class="plan"><span>entry zone <b>${o.entryZone ? lv(o.entryZone.lo) + '–' + lv(o.entryZone.hi) : '—'}</b></span><span>stop <b class="down">${lv(o.stop)}</b></span><span>target <b class="up">${lv(o.target)}</b></span><span>R:R <b>${o.rr ?? '—'}</b></span><span>needs <b>${o.targetR ?? '—'}R</b> (history: ~${o.realisticR ?? '—'}R)</span><span>hold <b>${o.holdHours ? '~' + o.holdHours + 'h' : '—'}</b></span></div>
    <div class="whyblock">${whyList(o.why)}</div>
    ${o.waitingFor && o.waitingFor.length ? `<div class="wait"><b>WAITING FOR:</b> ${o.waitingFor.map(esc).join(' · ')}</div>` : ''}
    ${o.vetoes && o.vetoes.length ? `<div class="why"><b>Blocked by:</b> ${o.vetoes.slice(0, 4).map(esc).join(' · ')}</div>` : ''}
    ${(o.cautions && o.cautions.length) || (o.penalties && o.penalties.length) ? `<div class="why"><b>Cautions / score penalties (not blockers):</b> ${[...(o.cautions || []), ...(o.penalties || [])].slice(0, 5).map(esc).join(' · ')}</div>` : ''}
    ${o.other && o.other.setup ? `<div class="why"><b>Other side (${esc(o.other.side)}):</b> ${esc(o.other.verdict)} · ${esc(o.other.setup)} · direction ${o.other.scores.direction}</div>` : ''}
    ${o.adjustments && o.adjustments.length ? `<div class="why"><b>Learned rules applied:</b> ${o.adjustments.map((a) => esc(a.why) + ' (' + (a.delta > 0 ? '+' : '') + a.delta + ')').join('; ')}</div>` : ''}
  </div>`;
}

function explorationHtml(x) {
  if (!x || !x.enabled) return '';
  const bar = `<div class="sc ${x.progress >= 0.5 ? 'ok' : 'low'}" style="max-width:420px"><span>progress</span><b>${x.n} / ${x.targetDecisive}</b><i><u style="width:${Math.round(x.progress * 100)}%"></u><s style="left:${Math.round(100 * x.targetPrelim / x.targetDecisive)}%"></s></i></div>`;
  return `<h3>Exploration mode (paper, tiny ${(x.risk.min * 100).toFixed(2)}–${(x.risk.max * 100).toFixed(2)}% risk): do setups that fail ONLY the 2.5R rule have positive expectancy?</h3>
    ${bar}<p class="muted">Marker = ${x.targetPrelim} trades (preliminary). The normal rules, including the protected 2.5R minimum, change only by a human decision after this evidence.</p>
    <p><span class="pill ${/^positive/.test(x.verdict) ? 'good' : /^negative/.test(x.verdict) ? 'bad' : 'amber'}">${esc(x.verdict)}</span> ${esc(x.text)}</p>
    <p class="muted">Exploration P&amp;L so far: <b class="${cls(x.pnlUsd)}">${money(x.pnlUsd)}</b> (self-stops at -2% of starting capital) · open exploration positions: ${x.open ?? 0}${x.paused ? ` · <span class="down">PAUSED: ${esc(x.paused)}</span>` : ' · active'}</p>
    ${x.n ? `<p>closed ${x.n} · win rate ${(x.winRate * 100).toFixed(0)}% · expectancy <b class="${cls(x.avgR)}">${x.avgR}R</b> (95%: ${x.lower95 ?? '—'} to ${x.upper95 ?? '—'}) · total ${x.totalR}R · profit factor ${x.profitFactor ?? '—'} · avg best ${pct(x.avgMfe)} / worst ${pct(x.avgMae)}</p>
    <table class="mini"><thead><tr><th>Net R:R at entry</th><th class="r">n</th><th class="r">Win</th><th class="r">Expectancy</th><th class="r">95% bounds</th><th>Evidence</th></tr></thead><tbody>${x.buckets.map((b) => `<tr><td>${b.label}</td><td class="r">${b.n}</td><td class="r">${b.n ? (b.winRate * 100).toFixed(0) + '%' : '—'}</td><td class="r ${cls(b.avgR)}">${b.n ? b.avgR + 'R' : '—'}</td><td class="r">${b.n > 1 ? b.lower95 + ' / ' + b.upper95 : '—'}</td><td class="muted">${b.positive ? 'positive on its own' : b.n < 15 ? 'needs 15+' : 'not demonstrated'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No exploration trade has closed yet.</p>'}`;
}

function renderLearning(L, rules, positions) {
  if (!L) return;
  const st = (x) => (x && x.n ? `${x.n} measured · win rate ${(x.winRate * 100).toFixed(0)}% · avg ${x.avgR >= 0 ? '+' : ''}${x.avgR}R · target first ${(x.targetFirst * 100).toFixed(0)}% · avg best ${pct(x.avgMfe)} / worst ${pct(x.avgMae)}` : 'none measured yet');
  const rows = (arr, f) => (arr && arr.length ? arr.map(f).join('') : '');
  const rel = L.reliability, lc = L.lossClusters, nw = L.news, hist = L.historical;
  $('#learning').innerHTML = `<div class="rep">
    ${L.sufficiency && L.sufficiency.length ? L.sufficiency.map((n) => `<p class="note">⚠ ${esc(n)}</p>`).join('') : ''}
    <p class="muted">Entry rules in force: direction, timing and geometry are blended into ONE composite and coins are RANKED against each other (weights ${rules.weights.wDirection}/${rules.weights.wTiming}/${rules.weights.wGeometry}; a very weak part and chasing pull it down). A coin needs a composite above its floor (${rules.minComposite}, tighter in a weak BTC regime, looser for exceptional relative strength), EV ≥ ${rules.minEV}R <b>and</b> still positive after allowing for estimate uncertainty (${rules.evSeK} standard errors), the protected net R:R ≥ ${rules.minRR} and stop ≤ 4%, no real veto (severe market, catastrophic coin news, extreme downtrend with no reversal, extremely thin book, no volatility), and some trigger. ${rules.discovered} discovered setups loaded. Tracked traders: ${esc(rules.copyTrading)}.</p>
    ${explorationHtml(L.exploration)}
    <h3>Open positions: HOLD / SELL</h3>${positions && positions.length ? positions.map((p) => `<p><b>${esc(p.symbol)}</b> <span class="pill ${p.action === 'SELL' ? 'bad' : 'good'}">${esc(p.action)}</span> ${esc(p.reasons[0] || '')}${p.invalidation ? ` <span class="muted">(thesis breaks below ${price(p.invalidation)})</span>` : ''}</p>`).join('') : '<p class="muted">No open positions.</p>'}
    <h3>Real paper trades</h3><p>${st(L.trades)}</p>
    <h3>Counterfactuals: every setup AND every coin the brain declined, measured from real candles</h3>
    <p>${st(L.counterfactual)} · ${L.pending} waiting to mature</p>
    ${L.byKind ? `<p class="muted">evaluated setups ${L.byKind.decisions} · declined coins (plain ATR plan) ${L.byKind.ignored}: ${st(L.byKind.ignoredStats)}<br>longs: ${st(L.byKind.longs)}<br>shorts (not executed): ${st(L.byKind.shorts)}</p>` : ''}
    <h3>Probability: predicted vs actual (with sample sizes)</h3>
    <p class="muted">History file: ${hist ? `${hist.rows.toLocaleString('en-US')} walk-forward observations over ${hist.days} days${hist.walkForward ? ` · unseen-data Brier ${hist.walkForward.brierModel} (zero-drift prior ${hist.walkForward.brierZeroDriftPrior}, base rate ${hist.walkForward.brierTrainBaseRate})` : ''}` : 'none yet (run npm run calibrate)'}.</p>
    ${rel && rel.n ? `<p>Live record: ${rel.n} measured, Brier ${rel.brier} (always-predict-the-base-rate: ${rel.baseBrier}), base rate ${(rel.baseRate * 100).toFixed(0)}%</p><table class="mini"><thead><tr><th>Predicted</th><th class="r">n</th><th class="r">Mean predicted</th><th class="r">Actually hit</th></tr></thead><tbody>${rel.bins.map((b) => `<tr><td>${b.range}</td><td class="r">${b.n}</td><td class="r">${(b.predicted * 100).toFixed(0)}%</td><td class="r">${(b.actual * 100).toFixed(0)}%</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No measured live predictions yet: the probabilities are not yet proven on this record.</p>'}
    <h3>Loss clusters: repeated causes of losses (hypotheses for a human, never auto-applied)</h3>
    ${lc && lc.clusters && lc.clusters.length ? `<table class="mini"><thead><tr><th>Cause</th><th class="r">Losses</th><th class="r">Lift</th><th class="r">Avg R</th><th>Consistent?</th></tr></thead><tbody>${lc.clusters.slice(0, 8).map((c) => `<tr title="${esc(c.hypothesis || '')}"><td>${esc(c.tag)}${c.flagged ? ' <span class="pill bad">cluster</span>' : ''}</td><td class="r">${c.losses}/${c.entries}</td><td class="r">${c.lift}x</td><td class="r ${cls(c.avgR)}">${c.avgR}</td><td class="muted">${c.persistent ? 'both halves' : '—'}</td></tr>`).join('')}</tbody></table>${lc.clusters.filter((c) => c.hypothesis).map((c) => `<p class="note">${esc(c.hypothesis)}</p>`).join('')}` : `<p class="muted">${esc((lc && lc.note) || 'No clusters yet.')}</p>`}
    <h3>News: did price actually react? (event → expected direction → reaction)</h3>
    ${nw && nw.rows.length ? `<table class="mini"><thead><tr><th>Headline type</th><th class="r">n</th><th class="r">Moved as expected</th><th class="r">Avg move (ATR)</th><th class="r">Delay</th><th>Weight</th></tr></thead><tbody>${nw.rows.map((r) => `<tr title="${esc(r.note)}"><td>${esc(r.label)}</td><td class="r">${r.n}</td><td class="r">${(r.alignedRate * 100).toFixed(0)}%</td><td class="r">${r.meanAlignedAtr}</td><td class="r">${r.avgDelayH == null ? '—' : r.avgDelayH + 'h'}</td><td><span class="pill ${r.status === 'predictive' ? 'good' : r.status === 'not predictive' ? 'bad' : ''}">${esc(r.status)} · ${r.trust}x</span></td></tr>`).join('')}</tbody></table>` : ''}
    <p class="muted">${nw ? `${nw.logged} events logged, ${nw.measured} with a measured 4h reaction. Until a headline type is measured to work, its weight is 0.5x; a reaction is a measurement, not proof the article caused it.` : ''}</p>
    <h3>Rules learned (walk-forward validated: same sign on an earlier AND a later slice of time)</h3>
    ${L.rules && L.rules.length ? `<table class="mini"><thead><tr><th>Rule</th><th>Status</th><th class="r">Train</th><th class="r">Test</th><th class="r">Score</th></tr></thead><tbody>${L.rules.map((r) => `<tr title="${esc(r.why)}"><td>${esc(r.desc)}</td><td><span class="pill ${r.status === 'active' ? 'good' : ''}">${esc(r.status)}</span></td><td class="r">${r.trainR}R (${r.nTrain})</td><td class="r">${r.testR}R (${r.nTest})</td><td class="r">${r.delta ? (r.delta > 0 ? '+' : '') + r.delta : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No buckets have samples yet.</p>'}
    <h3>Do the vetoes earn their keep? (what the setups they blocked actually did)</h3>
    ${L.vetoes && L.vetoes.length ? `<table class="mini"><thead><tr><th>Veto</th><th class="r">Blocked</th><th class="r">Avg R</th><th class="r">Missed big moves</th><th>Verdict</th></tr></thead><tbody>${L.vetoes.slice(0, 10).map((v) => `<tr><td>${esc(v.text)}</td><td class="r">${v.blocked}</td><td class="r ${cls(v.avgR)}">${v.avgR}</td><td class="r">${v.missedMoves}</td><td class="muted">${esc(v.verdict)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Needs 5+ measured blocked setups per veto.</p>'}
    <h3>Missed opportunities: "a coin went up and the AI did not catch it earlier"</h3>
    ${L.missed && L.missed.list.length ? `<p class="muted">${L.missed.count} moves of ≥ 8% in the last 24h · flagged early on ${L.missed.early}. Most common reasons: ${L.missed.topReasons.slice(0, 3).map((r) => `${esc(r.text)} (${r.n})`).join('; ')}.</p>${L.missed.list.map((m) => `<p>• ${esc(m.text)}</p>`).join('')}` : '<p class="muted">No coin moved ≥ 8% in a way we can review yet (checked every 30 minutes).</p>'}
    <h3>Last closed trades: why they won or lost</h3>
    ${L.recentTrades && L.recentTrades.length ? L.recentTrades.map((t) => `<p><b>${esc(t.symbol)}</b> <span class="pill ${t.R > 0 ? 'good' : 'bad'}">${t.R > 0 ? 'WIN' : 'LOSS'} ${t.R}R</span> ${esc(t.setup || '')} (score ${t.score}) · ${esc(t.hit)} · best ${pct(t.mfe)} / worst ${pct(t.mae)}<br><span class="muted">${esc(t.why || '')}</span></p>`).join('') : '<p class="muted">No closed AI trades yet.</p>'}
  </div>`;
}

$('#opps').addEventListener('click', (e) => { const c = e.target.closest('[data-sym]'); if (c) { selected = c.dataset.sym; $('#chart-symbol').textContent = selected; refreshChart(); } });
$('#avoid').addEventListener('click', (e) => { const c = e.target.closest('[data-sym]'); if (c) { selected = c.dataset.sym; $('#chart-symbol').textContent = selected; refreshChart(); } });

function render(s) {
  latest = s;
  renderStats(s); renderBrain(s.brain); renderTable(s); renderPositions(s); renderHistory(s.history); renderNews(s.newsFeed); renderRadar(s.radar); renderCopy(s.copy); renderDecisions(s); renderReflections(s);
}

$('#copy').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-release]');
  if (b && confirm('Release this trader after your review? Their loss streak is cleared and they are re-scored before any new copy.')) {
    await fetch('/api/traders/release', { method: 'POST', headers: { 'x-requested-with': 'dashboard', 'content-type': 'application/json' }, body: JSON.stringify({ address: b.dataset.release }) });
  }
});

$('#positions').addEventListener('click', (e) => {
  const it = e.target.closest('[data-sym]');
  if (!it) return;
  selected = it.dataset.sym;
  $('#chart-symbol').textContent = selected;
  refreshChart();
});

$('#coins tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-sym]');
  if (!tr) return;
  selected = tr.dataset.sym;
  $('#chart-symbol').textContent = selected;
  document.querySelectorAll('#coins tbody tr.sel').forEach((x) => x.classList.remove('sel'));
  tr.classList.add('sel');
  refreshChart();
});
$('#filter').addEventListener('input', () => latest && renderTable(latest));
$('#up-toggles').addEventListener('click', (e) => {
  const b = e.target.closest('.tog');
  if (!b) return;
  const k = b.dataset.tf;
  upOn.has(k) ? upOn.delete(k) : upOn.add(k);
  try { localStorage.setItem('upOn', JSON.stringify([...upOn])); } catch { /* ignore */ }
  if (latest) renderTable(latest);
});

/* ------------------------------------------------------------- live stream */
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => { try { render(JSON.parse(m.data)); } catch (e) { console.error(e); } };
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}
connect();
refreshChart();
