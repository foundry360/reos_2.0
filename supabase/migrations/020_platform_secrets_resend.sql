-- Allow Resend API key in platform_secrets

alter table public.platform_secrets
  drop constraint if exists platform_secrets_key_check;

alter table public.platform_secrets
  add constraint platform_secrets_key_check check (
    key in (
      'openai_api_key',
      'twilio_account_sid',
      'twilio_auth_token',
      'stripe_secret_key',
      'stripe_webhook_secret',
      'resend_api_key'
    )
  );
