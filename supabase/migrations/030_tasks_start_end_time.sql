-- Task schedule window (start / end time)

alter table public.tasks
  add column if not exists start_at timestamptz;

alter table public.tasks
  add column if not exists end_at timestamptz;
