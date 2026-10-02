// READ-ONLY audit: did setups that passed AI + confluence but FAILED candle confirmation go on to work?
// Usage: node scripts/audit-confirmation.mjs [--file rows.json] [--min 100]
// For each confirmation_failed signal it fetches Coinbase candles and records the move from the reference price at 15m/1h/4h/24h/72h,
// plus which came first, the signal's own target or its stop. Horizons that have not elapsed yet are left out, never guessed.
import fs from 'node:fs';
import { config } from '../src/config.js';

const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MIN = Number(opt('--min', 100)), HORIZONS = [['15m', 15], ['1h', 60], ['4h', 240], ['24h', 1440], ['72h', 4320]];
const pct = (x) => (x * 100).toFixed(2) + '%';

async function loadRows() {
  const file = opt('--file', null);
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { supabaseUrl, supabaseKey } = config.keys;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured in .env (or pass --file rows.json)');
  const { createClient } = await import('@supabase/supabase-js');
  const { data, error } = await createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } }).from('market_signals')
    .select('symbol,created_at,reference_price,target_price,stop_price,confluence_score,confirmation,skip_reason').eq('status', 'confirmation_failed').order('created_at');
  if (error) throw new Error(error.message);
  return data;
}

async function candles(product, fromMs, toMs) {            // 1m candles, 300 per request
  const out = [];
  for (let s = fromMs; s < toMs; s += 300 * 60_000) {
    const e = Math.min(toMs, s + 300 * 60_000);
    const r = await fetch(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`, { headers: { 'User-Agent': 'crypto-ai-lab-audit/1.0' } });
    if (!r.ok) throw new Error(`${product} candles -> ${r.status}`);
    out.push(...await r.json());
    await new Promise((x) => setTimeout(x, 200));
  }
  return out.sort((a, b) => a[0] - b[0]);                  // [time, low, high, open, close, volume]
}

export function outcome(row, rows, now = Date.now()) {
  const t0 = Date.parse(row.created_at), ref = Number(row.reference_price), tp = Number(row.target_price), sp = Number(row.stop_price);
  const res = { symbol: row.symbol, at: row.created_at, score: Number(row.confluence_score) };
  for (const [name, m] of HORIZONS) {
    const c = t0 + m * 60_000 <= now ? rows.filter((x) => x[0] * 1000 <= t0 + m * 60_000).pop() : null;
    res[name] = c ? c[4] / ref - 1 : null;
  }
  res.first = null;
  for (const c of rows) { if (c[1] <= sp) { res.first = 'stop'; break; } if (c[2] >= tp) { res.first = 'target'; break; } }
  return res;
}

const signals = await loadRows();
const results = [];
for (const s of signals) {
  const t0 = Date.parse(s.created_at);
  results.push(outcome(s, await candles(`${s.symbol}-USD`, t0, Math.min(Date.now(), t0 + 72 * 3600_000))));
}
console.table(results.map((r) => ({ symbol: r.symbol, at: r.at.slice(0, 16), score: r.score, ...Object.fromEntries(HORIZONS.map(([n]) => [n, r[n] == null ? 'n/a' : pct(r[n])])), first: r.first ?? '-' })));
console.log(`\n${results.length} failed-confirmation setups (need >= ${MIN} for a verdict).`);
for (const [name] of HORIZONS) {
  const v = results.map((r) => r[name]).filter((x) => x != null);
  if (v.length) console.log(`${name}: n=${v.length}, up ${v.filter((x) => x > 0).length}/${v.length}, mean ${pct(v.reduce((a, b) => a + b, 0) / v.length)}, mean after round-trip costs (0.3%) ${pct(v.reduce((a, b) => a + b, 0) / v.length - 0.003)}`);
}
const decided = results.filter((r) => r.first);
console.log(`Target before stop: ${decided.filter((r) => r.first === 'target').length}, stop before target: ${decided.filter((r) => r.first === 'stop').length}, undecided: ${results.length - decided.length}`);
if (results.length < MIN) console.log('VERDICT: not enough data. Do not change the confirmation rule yet.');
