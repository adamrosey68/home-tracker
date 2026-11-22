-- Who can see a household, for the Settings screen. Members only, and only their email addresses.

create function public.household_people(hid uuid) returns table (email text, joined_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_member(hid) then raise exception 'not a member of this household'; end if;
  return query
    select u.email::text, m.joined_at, m.user_id = auth.uid()
    from household_members m join auth.users u on u.id = m.user_id
    where m.household_id = hid
    order by m.joined_at;
end;
$$;

revoke execute on function public.household_people(uuid) from public, anon;
grant execute on function public.household_people(uuid) to authenticated;
