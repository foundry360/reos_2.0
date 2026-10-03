-- Workspace working hours for the calendar and AI scheduling.
-- Shape: { "days": { "mon": [{ "start": "09:00", "end": "17:00" }], ... }, "showingsOnDaysOff": true }
-- NULL means the app defaults (Mon-Fri 9:00-17:00).
alter table public.tenants
  add column if not exists working_hours jsonb;
