-- A short note on a budget line, e.g. "Renews 30 Nov at £7.00 a month".

alter table public.budget_lines
  add column note text check (char_length(note) <= 200);
