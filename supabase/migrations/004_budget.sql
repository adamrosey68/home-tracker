-- Monthly budget: money coming in and bills going out, one set of lines per month.

create table public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  month date not null check (extract(day from month) = 1),
  kind text not null check (kind in ('in', 'out')),
  name text not null check (char_length(name) between 1 and 80),
  amount numeric(10, 2) not null default 0,
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index budget_lines_household_month on public.budget_lines (household_id, month);

alter table public.budget_lines enable row level security;
create policy "members manage budget" on public.budget_lines for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.budget_lines;
