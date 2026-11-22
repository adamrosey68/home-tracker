-- What was actually spent against a budget line, e.g. each shop against the month's Food budget.

create table public.budget_spends (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  line_id uuid not null references public.budget_lines on delete cascade,
  place text not null check (char_length(place) between 1 and 80),
  amount numeric(10, 2) not null,
  pending boolean not null default false,
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index budget_spends_line on public.budget_spends (line_id);

alter table public.budget_spends enable row level security;
create policy "members manage spends" on public.budget_spends for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.budget_spends;
