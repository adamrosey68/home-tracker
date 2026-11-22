-- Savings: accounts, and a dated record of money paid in and taken out. The balance is the sum of the record.

create table public.savings_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index savings_accounts_household on public.savings_accounts (household_id);

create table public.savings_moves (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  account_id uuid not null references public.savings_accounts on delete cascade,
  moved_on date not null default current_date,
  kind text not null check (kind in ('in', 'out')),
  amount numeric(12, 2) not null check (amount >= 0),
  what text check (char_length(what) <= 120),
  created_at timestamptz not null default now()
);
create index savings_moves_account on public.savings_moves (account_id, moved_on);

alter table public.savings_accounts enable row level security;
alter table public.savings_moves enable row level security;
create policy "members manage savings accounts" on public.savings_accounts for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "members manage savings moves" on public.savings_moves for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.savings_accounts, public.savings_moves;
