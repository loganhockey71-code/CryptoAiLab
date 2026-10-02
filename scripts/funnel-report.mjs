// READ-ONLY funnel report: where do candidates drop out between "reached deep research" and "entered"? Run it periodically (and after each fix).
// Usage: node scripts/funnel-report.mjs [--hours 24] [--file rows.json]   (rows: status, skip_reason, created_at)
import fs from 'node:fs';
import { config } from '../src/config.js';

const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const hours = Number(opt('--hours', 24));

async function loadRows() {
  const file = opt('--file', null);
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { supabaseUrl, supabaseKey } = config.keys;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured in .env (or pass --file rows.json)');
  const { createClient } = await import('@supabase/supabase-js');
  const { data, error } = await createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } }).from('market_signals')
    .select('status,skip_reason,created_at').gte('created_at', new Date(Date.now() - hours * 3600_000).toISOString()).limit(10000);
  if (error) throw new Error(error.message);
  return data;
}

export function stage(r) {
  const t = r.skip_reason ?? '';
  if (r.status === 'entered') return '6 entered';
  if (r.status === 'confirmation_failed') return '5 failed candle confirmation';
  if (r.status === 'awaiting_confirmation' || r.status === 'confirmed') return '5 reached candle confirmation';
  if (/^price stream not verified fresh/.test(t)) return '1 stale price (thin market / feed)';
  if (/^Research Brain/.test(t)) return '2 Research Brain returned no signal';
  if (/^(technical|smart-money|confluence cannot)/.test(t)) return '3 pre-AI screen (technicals / smart money)';
  if (/^Research bias/.test(t)) return '4 AI neutral/bearish';
  if (/^(requirements|confluence \d)/.test(t)) return '4 failed confluence / requirements';
  return '9 other: ' + t.replace(/[0-9.]+/g, '#').slice(0, 60);
}

const rows = await loadRows();
const by = {};
for (const r of rows) by[stage(r)] = (by[stage(r)] ?? 0) + 1;
console.log(`Last ${hours}h: ${rows.length} evaluated setups`);
for (const [k, n] of Object.entries(by).sort()) console.log(`${String(n).padStart(5)}  ${(n / rows.length * 100).toFixed(0).padStart(3)}%  ${k.slice(2)}`);
const reach = (by['5 reached candle confirmation'] ?? 0) + (by['5 failed candle confirmation'] ?? 0) + (by['6 entered'] ?? 0);
console.log(`\nReached candle confirmation or beyond: ${reach} (${rows.length ? (reach / rows.length * 100).toFixed(1) : 0}%). Goal: more qualified setups here, with no requirement loosened.`);
