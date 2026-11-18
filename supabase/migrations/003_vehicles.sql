-- A vehicle's own details (registration, make, logbook info...). Car groups such as Tax or
-- Insurance can belong to one, so they're shown under it.
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  registration text not null check (char_length(registration) between 1 and 12),
  nickname text,
  make text,
  model text,
  -- Free-form details as [{"label": "Fuel type", "value": "Petrol"}, ...], in display order.
  details jsonb not null default '[]'::jsonb,
  notes text,
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index vehicles_household on public.vehicles (household_id);

alter table public.vehicles enable row level security;
create policy "members manage vehicles" on public.vehicles for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter table public.item_groups add column vehicle_id uuid references public.vehicles on delete set null;

alter publication supabase_realtime add table public.vehicles;
