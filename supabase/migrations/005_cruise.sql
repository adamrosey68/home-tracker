-- Cruise Tracker lives in this project too: same households, sign-in and sharing as Home Tracker.
-- Its tables are prefixed cruise_ (plus `cruises`) and its documents go in home-docs under <household>/cruise/.

-- Each device's notification address belongs to one app, so reminders only show up in the app they're about.
alter table public.push_subscriptions add column app text not null default 'home' check (app in ('home', 'cruise'));

create table public.cruises (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  line text,
  ship text,
  depart_date date,
  return_date date,
  depart_port text,
  cabin text,
  booking_ref text,
  price numeric(10, 2),
  travellers text,
  notes text,
  rating smallint check (rating between 1 and 5),
  review text,
  onboard_spend numeric(10, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cruises_household on public.cruises (household_id);

create table public.cruise_payments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  cruise_id uuid not null references public.cruises on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  amount numeric(10, 2) not null default 0,
  due_date date,
  paid_on date,
  remind_on date,
  -- Which reminder has gone out for the current due date: 'early' (on remind_on) or 'final' (the day before).
  reminded text check (reminded in ('early', 'final')),
  created_at timestamptz not null default now()
);
create index cruise_payments_cruise on public.cruise_payments (cruise_id);

create table public.cruise_days (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  cruise_id uuid not null references public.cruises on delete cascade,
  day date not null,
  port text not null check (char_length(port) between 1 and 80),
  arrive text,
  depart text,
  notes text,
  created_at timestamptz not null default now()
);
create index cruise_days_cruise on public.cruise_days (cruise_id);

create table public.cruise_bookings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  cruise_id uuid not null references public.cruises on delete cascade,
  kind text not null default 'excursion' check (kind in ('excursion', 'dining', 'spa', 'show', 'other')),
  name text not null check (char_length(name) between 1 and 120),
  day date,
  time text,
  price numeric(10, 2),
  reference text,
  notes text,
  created_at timestamptz not null default now()
);
create index cruise_bookings_cruise on public.cruise_bookings (cruise_id);

create table public.cruise_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  cruise_id uuid not null references public.cruises on delete cascade,
  text text not null check (char_length(text) between 1 and 120),
  due_date date,
  done boolean not null default false,
  position double precision not null default 0,
  reminded text check (reminded in ('final')),
  created_at timestamptz not null default now()
);
create index cruise_tasks_cruise on public.cruise_tasks (cruise_id);

create table public.cruise_docs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  cruise_id uuid not null references public.cruises on delete cascade,
  path text not null,
  name text not null,
  mime text not null,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index cruise_docs_cruise on public.cruise_docs (cruise_id);

-- New dates mean their reminders haven't been sent yet.
create function public.cruise_payments_touch() returns trigger
language plpgsql as $$
begin
  if new.due_date is distinct from old.due_date or new.remind_on is distinct from old.remind_on then
    new.reminded := null;
  end if;
  return new;
end;
$$;
create trigger cruise_payments_touch before update on public.cruise_payments
  for each row execute function public.cruise_payments_touch();

create function public.cruise_tasks_touch() returns trigger
language plpgsql as $$
begin
  if new.due_date is distinct from old.due_date then new.reminded := null; end if;
  return new;
end;
$$;
create trigger cruise_tasks_touch before update on public.cruise_tasks
  for each row execute function public.cruise_tasks_touch();

create function public.cruises_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger cruises_touch before update on public.cruises
  for each row execute function public.cruises_touch();

alter table public.cruises enable row level security;
alter table public.cruise_payments enable row level security;
alter table public.cruise_days enable row level security;
alter table public.cruise_bookings enable row level security;
alter table public.cruise_tasks enable row level security;
alter table public.cruise_docs enable row level security;

create policy "members manage cruises" on public.cruises for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "members manage cruise payments" on public.cruise_payments for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "members manage cruise days" on public.cruise_days for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "members manage cruise bookings" on public.cruise_bookings for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "members manage cruise tasks" on public.cruise_tasks for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "members manage cruise docs" on public.cruise_docs for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.cruises, public.cruise_payments, public.cruise_days,
  public.cruise_bookings, public.cruise_tasks, public.cruise_docs;

-- Joining someone else's household only removes your own one if neither app has anything in it.
create or replace function public.join_household(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into hid from households where share_code = upper(trim(code));
  if hid is null then raise exception 'No household found with that code'; end if;
  insert into household_members (household_id, user_id) values (hid, auth.uid()) on conflict do nothing;
  delete from households h
    where h.owner_id = auth.uid() and h.id <> hid
      and not exists (select 1 from items i where i.household_id = h.id)
      and not exists (select 1 from item_groups g where g.household_id = h.id)
      and not exists (select 1 from vehicles v where v.household_id = h.id)
      and not exists (select 1 from budget_lines b where b.household_id = h.id)
      and not exists (select 1 from cruises c where c.household_id = h.id)
      and not exists (select 1 from household_members m where m.household_id = h.id and m.user_id <> auth.uid());
  return hid;
end;
$$;
