-- A termly line only counts in the months a term is paid: paid_terms lists which terms (0-3) are paid that month,
-- and amount is what they add up to. Existing termly lines held a monthly average, so they start with nothing paid.

alter table public.budget_lines
  add column paid_terms smallint[] not null default '{}' check (cardinality(paid_terms) <= 4);

update public.budget_lines set amount = 0 where frequency = 'termly';
