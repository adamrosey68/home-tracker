-- Groups (e.g. "Buildings and contents") hold one current provider plus the history of past ones.
-- An item in a group is a past provider when archived_at is set.
create table public.item_groups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  area text not null check (area in ('home', 'bills', 'car', 'family')),
  name text not null check (char_length(name) between 1 and 60),
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index item_groups_household on public.item_groups (household_id);

alter table public.item_groups enable row level security;
create policy "members manage groups" on public.item_groups for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter table public.items
  add column group_id uuid references public.item_groups on delete cascade,
  add column start_date date,
  -- A chosen reminder date. When empty, the reminder goes remind_days before renewal_date.
  add column remind_on date;
create index items_group on public.items (group_id);

create or replace function public.items_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.renewal_date is distinct from old.renewal_date or new.remind_days is distinct from old.remind_days
     or new.remind_on is distinct from old.remind_on then
    new.reminded := null;
  end if;
  return new;
end;
$$;

alter publication supabase_realtime add table public.item_groups;
