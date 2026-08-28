import { headers } from "next/headers";
import { OpenAIIntegrationCard } from "./_components/openai-integration-card";
import { ResendIntegrationCard } from "./_components/resend-integration-card";
import { StripeIntegrationCard } from "./_components/stripe-integration-card";
import { TwilioIntegrationCard } from "./_components/twilio-integration-card";
import { fetchIntegrationsOverview } from "@/lib/admin/platform-secrets";
import { getStripeWebhookUrl } from "@/lib/admin/stripe";
import { PageHeading } from "@/components/shell/page-heading";
import { IconIntegrations } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

export default async function AdminIntegrationsPage() {
  const overview = await fetchIntegrationsOverview();
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : "https://your-app.vercel.app";
  const webhookUrl = getStripeWebhookUrl(origin);

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconIntegrations />}
          title="Integrations"
          subtitle="Platform credentials for OpenAI, Twilio, Resend, and Stripe. Stored keys override environment variables and are never shown after save."
          tone="accent"
        />
      </div>

      <div className={styles.integrationsStack}>
        <OpenAIIntegrationCard overview={overview} />
        <TwilioIntegrationCard overview={overview} />
        <ResendIntegrationCard overview={overview} />
        <StripeIntegrationCard overview={overview} webhookUrl={webhookUrl} />
      </div>
    </>
  );
}
