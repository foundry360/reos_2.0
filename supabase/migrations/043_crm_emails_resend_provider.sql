-- REOS-native outbound CRM email uses Resend while Gmail/Outlook remain
-- optional history/sync providers.

alter table public.crm_emails
  drop constraint if exists crm_emails_provider_check;

alter table public.crm_emails
  add constraint crm_emails_provider_check
  check (provider in ('gmail', 'outlook', 'resend'));

-- Rows saved before this migration used provider=gmail + metadata.delivery_provider
-- so the check constraint would accept them. Promote those to provider=resend.
update public.crm_emails
set provider = 'resend'
where provider = 'gmail'
  and metadata->>'delivery_provider' = 'resend';
