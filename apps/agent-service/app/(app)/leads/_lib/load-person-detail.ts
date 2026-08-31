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
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { createClient } from "@/lib/supabase/server";
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

  if (!contact) notFound();

  const kind: PersonKind = contact.record_type === "contact" ? "contact" : "lead";
  if (kind !== expectedKind) {
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
    (kind === "contact" ? "Unknown contact" : "Unknown lead");

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
        .select("channel, status, external_page_id, metadata")
        .eq("tenant_id", tenantId)
        .in("channel", ["messenger", "instagram"]),
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
  };
}
