import { createClient } from '@supabase/supabase-js';
import { config, warn, log } from './config.js';

const { supabaseUrl, supabaseKey } = config.keys;
const client = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null;

if (!client) warn('Supabase not configured (SUPABASE_SERVICE_ROLE_KEY missing in .env): running in memory-only mode, nothing is persisted.');
else log('Supabase connected:', supabaseUrl);

export const dbEnabled = !!client;

// Every helper swallows errors (logging them) so a database hiccup can never crash the trading loop.
async function run(label, fn) {
  if (!client) return null;
  try {
    const { data, error } = await fn(client);
    if (error) { warn(`db ${label}:`, error.message); return null; }
    return data;
  } catch (e) {
    warn(`db ${label} threw:`, e.message);
    return null;
  }
}

export const db = {
  loadPortfolio: () => run('loadPortfolio', (c) => c.from('portfolio').select('*').eq('id', 1).maybeSingle()),
  savePortfolio: (p) => run('savePortfolio', (c) => c.from('portfolio').upsert({ ...p, id: 1, updated_at: new Date().toISOString() })),

  upsertCoins: (rows) => run('upsertCoins', (c) => c.from('top_100_coins').upsert(rows, { onConflict: 'coingecko_id' })),
  loadCoins: () => run('loadCoins', (c) => c.from('top_100_coins').select('*')),
  deactivateCoins: (ids) => ids.length
    ? run('deactivateCoins', (c) => c.from('top_100_coins').update({ active: false, removed_at: new Date().toISOString() }).in('coingecko_id', ids))
    : null,
  setCooldown: (id, until) => run('setCooldown', (c) => c.from('top_100_coins').update({ cooldown_until: until }).eq('coingecko_id', id)),

  upsertTraders: (rows) => rows.length ? run('upsertTraders', (c) => c.from('tracked_traders').upsert(rows, { onConflict: 'source,address' })) : null,
  loadTraders: () => run('loadTraders', (c) => c.from('tracked_traders').select('*')),

  insertSignal: (s) => run('insertSignal', (c) => c.from('market_signals').insert(s).select().single()),
  updateSignal: (id, patch) => run('updateSignal', (c) => c.from('market_signals').update(patch).eq('id', id)),
  recentSignals: (n = 100) => run('recentSignals', (c) => c.from('market_signals').select('*').order('created_at', { ascending: false }).limit(n)),

  insertTrade: (t) => run('insertTrade', (c) => c.from('trade_logs').insert(t).select().single()),
  updateTrade: (id, patch) => run('updateTrade', (c) => c.from('trade_logs').update(patch).eq('id', id)),
  openTrades: () => run('openTrades', (c) => c.from('trade_logs').select('*').eq('status', 'open')),
  recentTrades: (n = 100) => run('recentTrades', (c) => c.from('trade_logs').select('*').order('entry_time', { ascending: false }).limit(n)),
  closedTradesSince: (iso) => run('closedTradesSince', (c) => c.from('trade_logs').select('*').eq('status', 'closed').gte('exit_time', iso).order('exit_time')),

  /** Total closed trades ever (not capped like the in-memory history). */
  countClosedTrades: async () => {
    if (!client) return null;
    try {
      const { count, error } = await client.from('trade_logs').select('id', { count: 'exact', head: true }).eq('status', 'closed');
      if (error) { warn('db countClosedTrades:', error.message); return null; }
      return count;
    } catch (e) { warn('db countClosedTrades threw:', e.message); return null; }
  },

  insertExitEvent: (e) => run('insertExitEvent', (c) => c.from('trade_exit_events').insert(e)),

  insertReflection: (r) => run('insertReflection', (c) => c.from('trade_reflections').insert(r).select().single()),
  recentReflections: (n = 5) => run('recentReflections', (c) => c.from('trade_reflections').select('*').order('created_at', { ascending: false }).limit(n)),
};
