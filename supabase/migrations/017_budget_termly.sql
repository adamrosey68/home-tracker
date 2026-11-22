-- Termly budget lines, like a child's drama classes: up to four term amounts that add up to a yearly cost.

alter table public.budget_lines drop constraint budget_lines_frequency_check;
alter table public.budget_lines
  add constraint budget_lines_frequency_check check (frequency in ('monthly', 'termly', 'one-off')),
  add column terms jsonb not null default '[]' check (jsonb_typeof(terms) = 'array' and jsonb_array_length(terms) <= 4);
