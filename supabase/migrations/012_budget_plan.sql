-- A payment plan on a budget line: stages of monthly payments, e.g. £21 a month until Feb 2028 then £19 until Feb 2029.
-- Each stage is {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "amount": number}; payments fall on the "from" day each month.

alter table public.budget_lines
  add column plan jsonb not null default '[]' check (jsonb_typeof(plan) = 'array');
