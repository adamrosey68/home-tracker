-- Budget lines are monthly (the usual) or one-off. A group can be set to show and count only its monthly lines.
alter table public.budget_lines
  add column frequency text not null default 'monthly' check (frequency in ('monthly', 'one-off'));
alter table public.budget_groups
  add column monthly_only boolean not null default false;
