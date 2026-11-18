-- Loyalty and membership numbers belong to a person, not a holiday, so they sit at household level.
create table public.cruise_loyalty (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  person text not null check (char_length(person) between 1 and 80),
  company text,
  programme text,
  number text not null check (char_length(number) between 1 and 60),
  tier text,
  notes text,
  created_at timestamptz not null default now()
);
create index cruise_loyalty_household on public.cruise_loyalty (household_id);

alter table public.cruise_loyalty enable row level security;
create policy "members manage cruise loyalty" on public.cruise_loyalty for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.cruise_loyalty;
