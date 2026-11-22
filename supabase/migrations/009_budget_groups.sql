-- Groups of outgoings in the monthly budget (e.g. "Vikki's outgoings"). A group is shared by every month;
-- in_total says whether its lines count towards the main Going out and Left over figures.
create table public.budget_groups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  in_total boolean not null default true,
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index budget_groups_household on public.budget_groups (household_id);

alter table public.budget_lines
  add column group_id uuid references public.budget_groups on delete cascade,
  -- Chosen icon; null means pick one from the line's name.
  add column icon text;

alter table public.budget_groups enable row level security;
create policy "members manage budget groups" on public.budget_groups for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.budget_groups;
