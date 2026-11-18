-- Cruise Tracker becomes a holiday tracker: any kind of holiday, its flights and transport,
-- and a cruise watcher with price checks for booked cruises and ones we're thinking about.

alter table public.cruises
  add column kind text not null default 'cruise' check (kind in ('cruise', 'beach', 'city', 'touring', 'ski', 'other')),
  -- 'watching' is a cruise we're thinking about; it stays out of the holiday lists until it's booked.
  add column status text not null default 'booked' check (status in ('booked', 'watching')),
  add column destination text,
  add column accommodation text,
  add column url text;

create table public.cruise_travel (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  cruise_id uuid not null references public.cruises on delete cascade,
  kind text not null default 'flight' check (kind in ('flight', 'transfer', 'car', 'train', 'parking', 'other')),
  carrier text,
  number text,
  from_place text,
  to_place text,
  depart_day date,
  depart_time text,
  arrive_day date,
  arrive_time text,
  reference text,
  price numeric(10, 2),
  notes text,
  created_at timestamptz not null default now()
);
create index cruise_travel_cruise on public.cruise_travel (cruise_id);

create table public.cruise_prices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  cruise_id uuid not null references public.cruises on delete cascade,
  checked_on date not null default current_date,
  price numeric(10, 2) not null,
  note text,
  created_at timestamptz not null default now()
);
create index cruise_prices_cruise on public.cruise_prices (cruise_id);

alter table public.cruise_travel enable row level security;
alter table public.cruise_prices enable row level security;
create policy "members manage cruise travel" on public.cruise_travel for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "members manage cruise prices" on public.cruise_prices for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.cruise_travel, public.cruise_prices;
