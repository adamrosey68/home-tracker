-- A price check can be for the holiday itself (travel_id null) or for one of its flights or transport bookings.
alter table public.cruise_prices add column travel_id uuid references public.cruise_travel on delete cascade;
