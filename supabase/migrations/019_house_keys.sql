-- Keys: each key's name, a photo of it (in home-docs under <household>/keys/), and who has a copy.

create table public.house_keys (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  holders text[] not null default '{}' check (cardinality(holders) <= 20),
  note text check (char_length(note) <= 200),
  photo text,
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index house_keys_household on public.house_keys (household_id);

alter table public.house_keys enable row level security;
create policy "members manage keys" on public.house_keys for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.house_keys;
