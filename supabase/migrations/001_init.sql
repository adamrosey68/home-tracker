-- Home Tracker schema. Run once in the Supabase SQL editor (or `supabase db push`).
-- A household holds the items (policies, bills, MOT, tax...). Everyone in household_members
-- can see and edit everything in it; people join with a share code.

create table public.households (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null default 'Our home' check (char_length(name) between 1 and 60),
  share_code text unique,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user on public.household_members (user_id);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  category text not null default 'other',
  title text not null check (char_length(title) between 1 and 120),
  provider text,
  reference text,
  covers text,
  cost numeric(10, 2),
  frequency text not null default 'yearly' check (frequency in ('monthly', 'quarterly', 'yearly', 'one-off')),
  renewal_date date,
  remind_days integer not null default 30 check (remind_days between 0 and 365),
  auto_renew boolean not null default false,
  phone text,
  website text,
  notes text,
  archived_at timestamptz,
  -- Which reminder has gone out for the current renewal_date: 'early' (remind_days before) or 'final' (the day before).
  reminded text check (reminded in ('early', 'final')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index items_household on public.items (household_id);
create index items_renewal on public.items (renewal_date) where archived_at is null;

create table public.item_docs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items on delete cascade,
  household_id uuid not null references public.households on delete cascade,
  path text not null,
  name text not null,
  mime text not null,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index item_docs_item on public.item_docs (item_id);

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- A new renewal date means its reminders haven't been sent yet.
create function public.items_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.renewal_date is distinct from old.renewal_date or new.remind_days is distinct from old.remind_days then
    new.reminded := null;
  end if;
  return new;
end;
$$;
create trigger items_touch before update on public.items
  for each row execute function public.items_touch();

-- security definer so policies can check membership without recursing through its own policy.
create function public.is_member(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from household_members where household_id = hid and user_id = auth.uid());
$$;

create function public.add_owner_as_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into household_members (household_id, user_id) values (new.id, new.owner_id) on conflict do nothing;
  return new;
end;
$$;
create trigger households_owner_member after insert on public.households
  for each row execute function public.add_owner_as_member();

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.items enable row level security;
alter table public.item_docs enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "members read households" on public.households for select
  using (owner_id = auth.uid() or public.is_member(id));
create policy "users create own households" on public.households for insert
  with check (owner_id = auth.uid());
create policy "members rename households" on public.households for update
  using (public.is_member(id)) with check (public.is_member(id));
create policy "owners delete households" on public.households for delete
  using (owner_id = auth.uid());

create policy "members see members" on public.household_members for select
  using (user_id = auth.uid() or public.is_member(household_id));
create policy "leave or remove members" on public.household_members for delete
  using (user_id = auth.uid() or exists (select 1 from households h where h.id = household_id and h.owner_id = auth.uid()));

create policy "members manage items" on public.items for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "members manage docs" on public.item_docs for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "own push subscriptions" on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The signed-in person's household (the one they joined most recently), created on first use.
create function public.my_household() returns uuid
language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select household_id into hid from household_members where user_id = auth.uid() order by joined_at desc limit 1;
  if hid is null then
    insert into households (owner_id) values (auth.uid()) returning id into hid;
  end if;
  return hid;
end;
$$;

create function public.create_share_code(hid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  c text;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if not is_member(hid) then raise exception 'not a member of this household'; end if;
  select share_code into c from households where id = hid;
  if c is not null then return c; end if;
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from households where share_code = c);
  end loop;
  update households set share_code = c where id = hid;
  return c;
end;
$$;

-- Joining moves you into the other household. Your own one is removed if it has nothing in it.
create function public.join_household(code text) returns uuid
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
      and not exists (select 1 from household_members m where m.household_id = h.id and m.user_id <> auth.uid());
  return hid;
end;
$$;

alter publication supabase_realtime add table public.items, public.item_docs, public.household_members;

-- Documents: private bucket, files under <household id>/<item id>/<doc id>.<ext>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('home-docs', 'home-docs', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;

create policy "members read docs" on storage.objects for select to authenticated
  using (bucket_id = 'home-docs' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "members add docs" on storage.objects for insert to authenticated
  with check (bucket_id = 'home-docs' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "members delete docs" on storage.objects for delete to authenticated
  using (bucket_id = 'home-docs' and public.is_member(((storage.foldername(name))[1])::uuid));
