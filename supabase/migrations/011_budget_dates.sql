-- Budget lines can record when something started and when it expires, with a reminder before it does.

alter table public.budget_lines
  add column started_on date,
  add column ends_on date,
  add column remind boolean not null default true,
  add column reminded text check (reminded in ('early', 'final')),
  add constraint budget_lines_dates check (started_on is null or ends_on is null or ends_on >= started_on);

create index budget_lines_ends_on on public.budget_lines (ends_on) where ends_on is not null;
