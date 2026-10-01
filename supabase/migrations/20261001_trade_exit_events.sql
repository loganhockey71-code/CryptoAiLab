-- Every exit leg (partial or final) of a trade is its own row, linked to its parent trade_logs row.
create table if not exists public.trade_exit_events (
  id            uuid primary key default gen_random_uuid(),
  trade_id      uuid not null references public.trade_logs(id) on delete cascade,
  price         numeric not null,
  size_usd      numeric not null,
  realized_pnl  numeric not null,          -- net of this leg's share of entry fee, exit fee and slippage
  exit_reason   text not null,
  iso_timestamp timestamptz not null default now(),
  is_final      boolean not null default false
);
create index if not exists trade_exit_events_trade_id_idx on public.trade_exit_events (trade_id);
alter table public.trade_exit_events enable row level security;   -- the app uses the service role, which bypasses RLS
