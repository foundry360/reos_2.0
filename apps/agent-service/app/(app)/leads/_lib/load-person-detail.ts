import { notFound, redirect } from "next/navigation";
import {
  DEFAULT_CONTACT_TYPE,
  formatContactTypeLabel,
  isContactType,
} from "@/lib/crm/contact-type";
import {
  fetchActivitiesForContact,
  fetchTasksForContact,
} from "@/lib/crm/person-activity-lists";
import { formatLeadStatusLabel } from "@/lib/leads/lead-status";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import { fetchOpportunitiesForContact } from "@/lib/opportunities/opportunities-list";
import { syncContactGmailMessages } from "@/lib/email/gmail-sync";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { createClient } from "@/lib/supabase/server";
import { ensureAiSummary, ensureScoreAndTemperature } from "@/lib/db/contacts";
import { reconcileContactByEmailOrPhone } from "@/lib/db/contact-merge";
import {
  ensureAppointmentSetOpportunity,
  syncIntakeOpportunityStage,
} from "@/lib/opportunities/create-from-booking";
import { formatPhoneDisplay } from "@/lib/phone-display";
import {
  fetchMetaChannelAvatar,
  fetchMetaSenderProfile,
} from "@/lib/meta/profile";
import type { MetaChannelMetadata } from "@/lib/meta/channel-account";
import type { PersonDetailData } from "./person-detail-types";

export async function loadPersonDetail(
  id: string,
  expectedKind: PersonKind,
): Promise<PersonDetailData> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) notFound();

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
      contact_type,
      qualification_score,
      lead_temperature,
      ai_summary,
      agent_brief,
      recommended_next_action,
      intent,
      target_location,
      property_type,
      budget,
      timeline,
      financing_status,
      must_haves,
      motivation,
      preferences,
      opted_out,
      appt_booked,
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

  if (!contact) notFound();

  // Collapse FB/IG (or other) duplicates that share email or SMS phone.
  const identitiesForMerge = Array.isArray(contact.contact_identities)
    ? contact.contact_identities
    : contact.contact_identities
      ? [contact.contact_identities]
      : [];
  const smsForMerge = identitiesForMerge.find((entry) => entry.channel === "sms");
  if (contact.email?.trim() || smsForMerge?.external_id) {
    const survivorId = await reconcileContactByEmailOrPhone(contact.id, {
      email: contact.email,
      phone: smsForMerge?.external_id ?? null,
    });
    if (survivorId !== contact.id) {
      redirect(`${personBasePath(expectedKind)}/${survivorId}`);
    }
    // Re-load in case another duplicate was merged into this record.
    const { data: refreshed } = await supabase
      .from("contacts")
      .select(
        `
        id,
        first_name,
        last_name,
        email,
        record_type,
        lead_status,
        contact_type,
        qualification_score,
        lead_temperature,
        ai_summary,
        agent_brief,
        recommended_next_action,
        intent,
        target_location,
        property_type,
        budget,
        timeline,
        financing_status,
        must_haves,
        motivation,
        preferences,
        opted_out,
        appt_booked,
        created_at,
        updated_at,
        contact_identities (
          channel,
          external_id
        )
      `,
      )
      .eq("id", contact.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (refreshed) Object.assign(contact, refreshed);
  }

  const kind: PersonKind = contact.record_type === "contact" ? "contact" : "lead";
  if (kind !== expectedKind) {
    redirect(`${personBasePath(kind)}/${id}`);
  }

  // Backfill AI summary / score from qualification columns when the agent skipped them.
  if (!contact.ai_summary?.trim()) {
    const filled = await ensureAiSummary(contact.id, { force: false });
    if (filled) contact.ai_summary = filled;
  }
  if (
    contact.qualification_score == null ||
    !contact.lead_temperature?.trim()
  ) {
    const scored = await ensureScoreAndTemperature(contact.id, { force: false });
    if (scored) {
      contact.qualification_score = scored.score;
      contact.lead_temperature = scored.temperature;
    }
  }

  // Sync Intake opportunity stage from CRM (AI Qualifying / Qualified / Appointment Set).
  await syncIntakeOpportunityStage(contact.id);
  if (contact.appt_booked && contact.record_type === "contact") {
    await ensureAppointmentSetOpportunity(contact.id);
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
    (kind === "contact" ? "Unknown client" : "Unknown lead");

  const contactType =
    kind === "contact"
      ? isContactType(contact.contact_type ?? "")
        ? contact.contact_type
        : DEFAULT_CONTACT_TYPE
      : isContactType(contact.contact_type ?? "")
        ? contact.contact_type
        : null;

  const [opportunityRows, tasks, activities, messagesRes, channelAccountsRes, phoneRes] =
    await Promise.all([
      fetchOpportunitiesForContact(tenantId, contact.id),
      fetchTasksForContact(tenantId, contact.id),
      fetchActivitiesForContact(tenantId, contact.id, { limit: 50, personKind: kind }),
      supabase
        .from("messages")
        .select("id, direction, body, channel, created_at")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: true })
        .limit(200),
      supabase
        .from("channel_accounts")
        .select("channel, status, external_page_id, external_account_id, metadata")
        .eq("tenant_id", tenantId)
        .in("channel", ["messenger", "instagram", "email"]),
      supabase
        .from("tenant_phone_numbers")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("is_primary", true)
        .maybeSingle(),
    ]);

  if (messagesRes.error) {
    console.error("person messages failed:", messagesRes.error.message);
  }

  let avatarUrl: string | null = null;
  const avatarSelect = await supabase
    .from("contacts")
    .select("avatar_url")
    .eq("id", contact.id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!avatarSelect.error) {
    avatarUrl = avatarSelect.data?.avatar_url?.trim() || null;
  }

  if (!avatarUrl) {
    const metaIdentity =
      identities.find((entry) => entry.channel === "messenger") ??
      identities.find((entry) => entry.channel === "instagram");
    const metaChannel = metaIdentity
      ? (channelAccountsRes.data ?? []).find(
          (row) =>
            row.channel === metaIdentity.channel &&
            row.status === "connected" &&
            row.external_page_id,
        )
      : null;
    const pageToken = (metaChannel?.metadata as MetaChannelMetadata | null)?.access_token?.trim();
    if (metaIdentity?.external_id && pageToken) {
      const profile = await fetchMetaSenderProfile(metaIdentity.external_id, pageToken);
      if (profile?.avatarUrl) {
        avatarUrl = profile.avatarUrl;
        if (!avatarSelect.error) {
          const { error: avatarError } = await supabase
            .from("contacts")
            .update({ avatar_url: avatarUrl })
            .eq("id", contact.id)
            .eq("tenant_id", tenantId);
          if (avatarError) {
            console.error("contact avatar update failed:", avatarError.message);
          }
        }
      }
    }
  }

  const connectedMeta = new Set(
    (channelAccountsRes.data ?? [])
      .filter(
        (row) =>
          row.status === "connected" &&
          row.external_page_id &&
          Boolean((row.metadata as { access_token?: string } | null)?.access_token),
      )
      .map((row) => row.channel),
  );
  const smsReady = Boolean(phoneRes.data?.id) && Boolean(sms?.external_id);

  const pageAvatarByChannel = new Map<string, string | null>();
  await Promise.all(
    (channelAccountsRes.data ?? [])
      .filter(
        (row) =>
          (row.channel === "messenger" || row.channel === "instagram") &&
          row.status === "connected" &&
          row.external_page_id,
      )
      .map(async (row) => {
        const metadata = (row.metadata ?? {}) as MetaChannelMetadata;
        const cached = metadata.page_avatar_url?.trim() || null;
        if (cached) {
          pageAvatarByChannel.set(row.channel, cached);
          return;
        }
        const pageToken = metadata.access_token?.trim();
        if (!pageToken || !row.external_page_id) {
          pageAvatarByChannel.set(row.channel, null);
          return;
        }
        const avatar = await fetchMetaChannelAvatar({
          channel: row.channel as "messenger" | "instagram",
          pageId: row.external_page_id,
          pageAccessToken: pageToken,
          instagramBusinessAccountId: metadata.instagram_business_account_id,
        });
        pageAvatarByChannel.set(row.channel, avatar);
        if (avatar) {
          const { error: cacheError } = await supabase
            .from("channel_accounts")
            .update({
              metadata: {
                ...metadata,
                page_avatar_url: avatar,
              },
            })
            .eq("tenant_id", tenantId)
            .eq("channel", row.channel);
          if (cacheError) {
            console.warn("channel avatar cache failed:", cacheError.message);
          }
        }
      }),
  );

  const messagingChannels = [
    {
      channel: "sms" as const,
      label: "SMS",
      externalId: sms?.external_id ?? "",
      connected: Boolean(phoneRes.data?.id),
      available: smsReady && !contact.opted_out,
      pageAvatarUrl: null as string | null,
    },
    {
      channel: "messenger" as const,
      label: "Messenger",
      externalId:
        identities.find((entry) => entry.channel === "messenger")?.external_id ?? "",
      connected: connectedMeta.has("messenger"),
      available:
        connectedMeta.has("messenger") &&
        Boolean(identities.find((entry) => entry.channel === "messenger")?.external_id),
      pageAvatarUrl: pageAvatarByChannel.get("messenger") ?? null,
    },
    {
      channel: "instagram" as const,
      label: "Instagram",
      externalId:
        identities.find((entry) => entry.channel === "instagram")?.external_id ?? "",
      connected: connectedMeta.has("instagram"),
      available:
        connectedMeta.has("instagram") &&
        Boolean(identities.find((entry) => entry.channel === "instagram")?.external_id),
      pageAvatarUrl: pageAvatarByChannel.get("instagram") ?? null,
    },
  ];

  const emailAccount = (channelAccountsRes.data ?? []).find(
    (row) => row.channel === "email" && row.status === "connected",
  );
  const emailConnected = Boolean(emailAccount?.metadata);

  if (emailConnected && contact.email?.trim()) {
    await syncContactGmailMessages({
      tenantId,
      contactId: contact.id,
      contactEmail: contact.email.trim(),
      opportunityId: opportunityRows[0]?.id ?? null,
    });
  }

  const emailsRes = await supabase
    .from("crm_emails")
    .select(
      "id, direction, from_email, from_name, to_recipients, cc_recipients, subject, body_html, body_text, snippet, sent_at, received_at, thread_id",
    )
    .eq("tenant_id", tenantId)
    .eq("contact_id", contact.id)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (emailsRes.error && !/crm_emails|schema cache|relation/i.test(emailsRes.error.message)) {
    console.error("person emails failed:", emailsRes.error.message);
  }

  return {
    id: contact.id,
    kind,
    name,
    firstName: contact.first_name?.trim() || "",
    lastName: contact.last_name?.trim() || "",
    email: contact.email?.trim() || null,
    phone,
    avatarUrl,
    leadStatus: contact.lead_status ?? "New",
    statusLabel: formatLeadStatusLabel(contact.lead_status),
    contactType,
    contactTypeLabel: formatContactTypeLabel(contactType),
    score: contact.qualification_score,
    temperature: contact.lead_temperature,
    optedOut: Boolean(contact.opted_out),
    aiSummary: contact.ai_summary?.trim() || null,
    intent: contact.intent?.trim() || null,
    targetLocation: contact.target_location?.trim() || null,
    propertyType: contact.property_type?.trim() || null,
    budget: contact.budget?.trim() || null,
    timeline: contact.timeline?.trim() || null,
    financingStatus: contact.financing_status?.trim() || null,
    mustHaves: contact.must_haves?.trim() || null,
    motivation: contact.motivation?.trim() || null,
    preferences: contact.preferences?.trim() || null,
    agentBrief: contact.agent_brief?.trim() || null,
    recommendedNextAction: contact.recommended_next_action?.trim() || null,
    createdAt: contact.created_at,
    updatedAt: contact.updated_at,
    opportunities: opportunityRows.map((row) => ({
      id: row.id,
      name: row.name,
      stageLabel: row.stageLabel,
      amountCents: row.amountCents,
      expectedCloseDate: row.expectedCloseDate,
      updatedAt: row.updatedAt,
    })),
    tasks,
    activities,
    messages: (messagesRes.data ?? []).map((row) => ({
      id: row.id,
      channel: row.channel ?? "sms",
      direction: row.direction === "outbound" ? ("outbound" as const) : ("inbound" as const),
      body: row.body ?? "",
      createdAt: row.created_at,
    })),
    messagingChannels: messagingChannels.map((option) => ({
      channel: option.channel,
      label: option.label,
      externalId: option.externalId,
      connected: option.connected,
      available: option.available,
      pageAvatarUrl: option.pageAvatarUrl,
    })),
    emails: (emailsRes.data ?? []).map((row) => ({
      id: row.id,
      direction: row.direction === "inbound" ? ("inbound" as const) : ("outbound" as const),
      fromEmail: row.from_email,
      fromName: row.from_name,
      toRecipients: Array.isArray(row.to_recipients) ? row.to_recipients : [],
      ccRecipients: Array.isArray(row.cc_recipients) ? row.cc_recipients : [],
      subject: row.subject,
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      snippet: row.snippet,
      sentAt: row.sent_at,
      receivedAt: row.received_at,
      threadId: row.thread_id,
    })),
    emailConnected,
  };
}
