-- Money coming into a group, like DLA, can pay towards that group's outgoings: a list of {to: line id, amount}.

alter table public.budget_lines
  add column funds jsonb not null default '[]' check (jsonb_typeof(funds) = 'array' and jsonb_array_length(funds) <= 60);
