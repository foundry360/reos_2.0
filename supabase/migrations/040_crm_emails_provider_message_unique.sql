-- Remove existing duplicate provider messages, preferring the row with the
-- strongest CRM associations, before enforcing uniqueness.
with ranked as (
  select
    id,
    row_number() over (
      partition by tenant_id, provider, provider_message_id
      order by
        (user_id is not null) desc,
        (contact_id is not null) desc,
        (opportunity_id is not null) desc,
        (body_html is not null) desc,
        (body_text is not null) desc,
        created_at asc,
        id asc
    ) as duplicate_rank
  from public.crm_emails
  where provider_message_id is not null
)
delete from public.crm_emails
where id in (
  select id
  from ranked
  where duplicate_rank > 1
);

-- Prevent Gmail sync from recording the same provider message more than once.
create unique index if not exists crm_emails_provider_message_unique_idx
  on public.crm_emails (tenant_id, provider, provider_message_id)
  where provider_message_id is not null;
