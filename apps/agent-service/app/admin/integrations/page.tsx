import { headers } from "next/headers";
import { OpenAIIntegrationCard } from "./_components/openai-integration-card";
import { StripeIntegrationCard } from "./_components/stripe-integration-card";
import { TwilioIntegrationCard } from "./_components/twilio-integration-card";
import { fetchIntegrationsOverview } from "@/lib/admin/platform-secrets";
import { getStripeWebhookUrl } from "@/lib/admin/stripe";
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
        <div>
          <h1 className={styles.pageTitle}>Integrations</h1>
          <p className={styles.pageSubtitle}>
            Platform credentials for OpenAI, Twilio, and Stripe. Stored keys override
            environment variables and are never shown after save.
          </p>
        </div>
      </div>

      <div className={styles.integrationsStack}>
        <OpenAIIntegrationCard overview={overview} />
        <TwilioIntegrationCard overview={overview} />
        <StripeIntegrationCard overview={overview} webhookUrl={webhookUrl} />
      </div>
    </>
  );
}
