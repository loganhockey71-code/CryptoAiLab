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
    stat('BTC 1h regime', btc.toUpperCase(), btc === 'bullish' ? 'up' : btc === 'bearish' ? 'down' : 'warn'),
    stat('Open', `${s.positions.length}/${s.limits.maxPositions}`),
    stat('Feed', h.wsConnected ? (h.feedStale ? 'STALE' : 'LIVE') : 'OFFLINE', h.wsConnected && !h.feedStale ? 'up' : 'down'),
    stat('Scan', s.scan.running ? esc(s.scan.progress || 'running') : s.scan.finishedAt ? `#${s.scan.count} ${ago(s.scan.finishedAt)}` : 'starting', s.scan.lastError ? 'down' : ''),
  ].join('');

  const notes = [];
  if (!p.gate.allowed) notes.push(`Trading blocked: ${p.gate.reason}`);
  if (!h.supabase) notes.push('Supabase key missing: nothing is being persisted');
  if (!h.llm) notes.push('No LLM key: Research Brain offline, staying 100% cash');
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

function renderTable(s) {
  const q = $('#filter').value.trim().toLowerCase();
  const gate = s.btc.bullish;
  const tbody = $('#coins tbody');
  const rows = s.rows.filter((r) => !q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const tradable = s.rows.filter((r) => r.tradable).length;
  $('#universe-note').textContent = `${s.rows.length} tradable coins by market cap`;
  tbody.innerHTML = rows.map((r) => {
    const c = r.candle;
    const candle = c ? `<span class="${c.c >= c.o ? 'up' : 'down'}">${c.c >= c.o ? '▲' : '▼'} ${pct((c.c - c.o) / c.o)}</span> <span class="muted">${price(c.l)}–${price(c.h)}</span>` : '<span class="muted">—</span>';
    const sig = r.signal.startsWith('IN') ? `<span class="pill good">${r.signal}</span>` : r.signal.startsWith('AWAIT') ? `<span class="pill amber">${r.signal}</span>` : `<span class="muted">${esc(r.signal)}</span>`;
    const gateCell = !r.tradable ? '<span class="muted">n/a</span>' : gate ? '<span class="pill good">open</span>' : '<span class="pill bad">closed</span>';
    const data = !r.tradable ? `<span class="muted" title="excluded">${esc(r.excluded)}</span>`
      : r.cooldownUntil ? `<span class="pill amber" title="2h stop-loss cooldown">cooldown</span>`
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
    <div class="meta"><b>${esc(p.symbol)}</b><span class="pill ${p.side === 'short' ? 'bad' : 'good'}">${esc(p.side)}</span>${p.source === 'copy' ? '' : `<span class="pill own" title="${esc((p.trigger?.reasons || []).join(', '))}">OWN IDEA${p.trigger?.kind === 'mover' ? ' · trending/unusual mover' : ''}</span>`}${p.source === 'copy' ? `<span class="pill amber" title="${esc(p.trader)}">copy ${p.venue === 'onchain' ? 'on-chain ' : ''}${esc(p.trader.slice(0, 8))} · ${(p.traderWinRate * 100).toFixed(0)}% win rate</span>` : ''}<span>entry ${price(p.entry)}</span>${p.leaderPx ? `<span>leader ${price(p.leaderPx)}</span>` : ''}<span>now ${price(p.price)}</span>${p.target ? `<span>target ${price(p.target)}</span>` : ''}<span>${p.source === 'copy' ? 'hard stop' : 'stop'} ${price(p.stop)}</span>${p.trailing ? `<span>trail ${price(p.trailing)}</span>` : ''}${p.rr != null ? `<span>R:R ${p.rr.toFixed(2)}</span>` : ''}<span>${money(p.notional)}</span></div>
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

const reasonLabel = { stop_loss: 'hit stop-loss', trailing_stop: 'trailing stop', momentum_reversal: 'momentum reversed', leader_exit: 'trader exited', leader_flip: 'trader flipped', leader_exit_while_offline: 'trader exited (offline)', circuit_breaker_daily_loss: 'daily loss cap' };
const sourceLabel = (t) => (t.source === 'copy_hyperliquid' ? `copy · Hyperliquid ${t.trader ? t.trader.slice(0, 6) : ''}` : t.source === 'copy_zerion' ? `copy · on-chain ${t.trader ? t.trader.slice(0, 6) : ''}` : 'LLM strategy');
const typePill = (t) => (t.origin === 'mimic'
  ? `<span class="pill amber">MIMIC</span> <span class="muted">${esc(sourceLabel(t).replace('copy · ', ''))}</span>`
  : `<span class="pill own">OWN IDEA</span> <span class="muted" title="${esc((t.triggerReasons || []).join(', '))}">${t.trigger === 'mover' ? 'trending / unusual mover' : 'regular scan'}</span>`);
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

function render(s) {
  latest = s;
  renderStats(s); renderTable(s); renderPositions(s); renderHistory(s.history); renderNews(s.newsFeed); renderCopy(s.copy); renderDecisions(s); renderReflections(s);
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

/* ------------------------------------------------------------- live stream */
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => { try { render(JSON.parse(m.data)); } catch (e) { console.error(e); } };
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}
connect();
refreshChart();
