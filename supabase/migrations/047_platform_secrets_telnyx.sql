-- Replace Twilio platform secrets with Telnyx

delete from public.platform_secrets
  where key in ('twilio_account_sid', 'twilio_auth_token');

alter table public.platform_secrets
  drop constraint if exists platform_secrets_key_check;

alter table public.platform_secrets
  add constraint platform_secrets_key_check check (
    key in (
      'openai_api_key',
      'telnyx_api_key',
      'telnyx_public_key',
      'stripe_secret_key',
      'stripe_webhook_secret',
      'resend_api_key'
    )
  );
