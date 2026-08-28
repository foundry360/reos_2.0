import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatLeadStatusLabel } from "@/lib/leads/lead-status";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { createClient } from "@/lib/supabase/server";
import { displayValue } from "@/lib/display-value";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { PageHeading } from "@/components/shell/page-heading";
import { IconLeads } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LeadDetailPage({ params }: PageProps) {
  const { id } = await params;
  const { tenantId } = await resolveCurrentTenant();

  if (!tenantId) {
    notFound();
  }

  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select(
      `
      id,
      first_name,
      last_name,
      email,
      record_type,
      lead_status,
      qualification_score,
      lead_temperature,
      ai_summary,
      opted_out,
      created_at,
      updated_at,
      contact_identities (
        channel,
        external_id
      )
    `,
    )
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!contact) {
    notFound();
  }

  const kind: PersonKind = contact.record_type === "contact" ? "contact" : "lead";
  if (kind !== "lead") {
    redirect(`${personBasePath(kind)}/${id}`);
  }

  const identities = Array.isArray(contact.contact_identities)
    ? contact.contact_identities
    : contact.contact_identities
      ? [contact.contact_identities]
      : [];
  const sms = identities.find((entry) => entry.channel === "sms");
  const phone = sms?.external_id
    ? formatPhoneDisplay(
        sms.external_id.startsWith("+")
          ? sms.external_id
          : `+${sms.external_id.replace(/\D/g, "")}`,
      )
    : null;

  const name =
    [contact.first_name?.trim(), contact.last_name?.trim()].filter(Boolean).join(" ") ||
    phone ||
    "Unknown lead";

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconLeads />}
          title={name}
          tone="brand"
          eyebrow={
            <Link href="/leads" className={styles.tableCellLink}>
              ← Back to leads
            </Link>
          }
        />
      </div>

      <div className={styles.card} style={{ padding: "1.25rem" }}>
        <div className={styles.highlightsGrid}>
          <div className={styles.displayField}>
            <span className={styles.displayLabel}>Phone</span>
            <span className={styles.displayValue}>{phone ?? displayValue(null)}</span>
          </div>
          <div className={styles.displayField}>
            <span className={styles.displayLabel}>Email</span>
            <span className={styles.displayValue}>
              {contact.email?.trim() || displayValue(null)}
            </span>
          </div>
          <div className={styles.displayField}>
            <span className={styles.displayLabel}>Status</span>
            <span className={styles.displayValue}>
              {formatLeadStatusLabel(contact.lead_status)}
            </span>
          </div>
          <div className={styles.displayField}>
            <span className={styles.displayLabel}>Score</span>
            <span className={styles.displayValue}>
              {contact.qualification_score != null
                ? contact.qualification_score
                : displayValue(null)}
            </span>
          </div>
          <div className={styles.displayField}>
            <span className={styles.displayLabel}>Temperature</span>
            <span className={styles.displayValue}>
              {contact.lead_temperature ?? displayValue(null)}
            </span>
          </div>
          <div className={styles.displayField}>
            <span className={styles.displayLabel}>Opted out</span>
            <span className={styles.displayValue}>{contact.opted_out ? "Yes" : "No"}</span>
          </div>
        </div>

        {contact.ai_summary ? (
          <div style={{ marginTop: "1.25rem" }}>
            <span className={styles.displayLabel}>AI summary</span>
            <p className={styles.displayValue} style={{ marginTop: "0.35rem", whiteSpace: "pre-wrap" }}>
              {contact.ai_summary}
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}
