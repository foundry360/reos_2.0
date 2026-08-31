-- Structured qualification fields Concierge collects during conversational intake.

alter table public.contacts
  add column if not exists target_location text,
  add column if not exists property_type text,
  add column if not exists budget text,
  add column if not exists timeline text,
  add column if not exists financing_status text,
  add column if not exists must_haves text,
  add column if not exists motivation text,
  add column if not exists preferences text;
