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
      <td class="muted" title="market-cap rank #${r.cgRank}">${r.rank}${disc}</td><td><b>${esc(r.symbol)}</b> <span class="muted">${esc(r.name)}</span></td>
      <td class="r">${price(r.price)}</td><td>${candle}</td><td>${sig}</td><td class="r">${score}</td><td>${gateCell}</td>
      <td class="r ${r.rvol > 1.5 ? 'up' : ''}">${r.rvol == null ? '—' : r.rvol.toFixed(2)}</td>
      <td class="r">${r.funding == null ? '—' : r.funding.toFixed(4) + '%'}</td>
      <td class="r ${cls(r.sentiment)}" title="${r.sentimentCount} headline(s)">${r.sentiment == null ? '—' : r.sentiment.toFixed(2)}</td><td>${data}</td></tr>`;
  }).join('');
}

function renderPositions(s) {
  const el = $('#positions');
  const pend = s.pending.map((p) => `<div class="item"><div class="meta"><b>${esc(p.symbol)}</b><span class="pill amber">awaiting candle confirmation</span><span>ref ${price(p.refPrice)}</span><span>score ${p.score}</span><span>${ago(p.createdAt)}</span></div></div>`).join('');
  if (!s.positions.length && !pend) { el.innerHTML = '<div class="empty">100% cash. No open paper positions.</div>'; return; }
  el.innerHTML = s.positions.map((p) => `<div class="item">
    <div class="meta"><b>${esc(p.symbol)}</b><span>entry ${price(p.entry)}</span><span>now ${price(p.price)}</span><span>target ${price(p.target)}</span><span>stop ${price(p.stop)}</span>${p.trailing ? `<span>trail ${price(p.trailing)}</span>` : ''}<span>R:R ${p.rr.toFixed(2)}</span><span>${money(p.notional)}</span></div>
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

function render(s) {
  latest = s;
  renderStats(s); renderTable(s); renderPositions(s); renderDecisions(s); renderReflections(s);
}

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
