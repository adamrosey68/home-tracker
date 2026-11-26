-- Each shop against a budget (like Food) can carry the day it was spent.

alter table public.budget_spends
  add column spent_on date not null default current_date;

create index budget_spends_line_date on public.budget_spends (line_id, spent_on);
