import { buildIcsInvite } from "@/lib/calendar/ics";
import { CONSULT_MINUTES } from "@/lib/calendar/consult-slots";
import {
  isValidEmailAddress,
  normalizeEmailAddress,
  resolveReplyToEmail,
} from "@/lib/email/email-utils";
import { getResendApiKey } from "@/lib/admin/resend";
import { getResendSender } from "@/lib/email/resend";
import { buildResendPayload } from "@/lib/email/resend-payload";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface AppointmentInvitePerson {
  email: string;
  name: string | null;
}

export interface SendAppointmentInvitesParams {
  tenantId: string;
  appointmentId: string;
  summary: string;
  label: string;
  start: Date;
  end: Date;
  location?: string | null;
  /** Guest / shared video join URL (REOS redirect → JaaS). */
  conferenceUrl?: string | null;
  /** Host/moderator join URL for the agent invite. */
  hostConferenceUrl?: string | null;
  lead: AppointmentInvitePerson | null;
  /** Agent who should also receive the invite (assigned agent or creator). */
  agentUserId: string | null;
  /** Fallback reply-to / organizer when agent profile is unavailable. */
  organizerFallback?: AppointmentInvitePerson | null;
}

export interface SendAppointmentInvitesResult {
  inviteSent: boolean;
  leadSent: boolean;
  agentSent: boolean;
  errors: string[];
}

async function resolveAgentRecipient(
  userId: string,
): Promise<AppointmentInvitePerson | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const [{ data: profile }, userResult] = await Promise.all([
    db
      .from("profiles")
      .select("display_name, reply_to_email")
      .eq("id", userId)
      .maybeSingle(),
    db.auth.admin.getUserById(userId),
  ]);

  const loginEmail = userResult.data.user?.email?.trim().toLowerCase() ?? "";
  if (!loginEmail || !isValidEmailAddress(loginEmail)) return null;

  const email = resolveReplyToEmail(loginEmail, profile?.reply_to_email);
  const name =
    profile?.display_name?.trim() ||
    email.split("@")[0] ||
    "Agent";

  return { email, name };
}

/**
 * Prefer contact assigned agent, then opportunity assigned agent.
 */
export async function resolveAssignedAgentUserId(params: {
  tenantId: string;
  contactId: string;
  opportunityId?: string | null;
}): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  let { data: contact, error: contactError } = await db
    .from("contacts")
    .select("assigned_agent_id")
    .eq("id", params.contactId)
    .eq("tenant_id", params.tenantId)
    .maybeSingle();

  if (contactError && /assigned_agent_id|schema cache|column/i.test(contactError.message)) {
    contact = null;
  }

  if (contact?.assigned_agent_id) return contact.assigned_agent_id;

  if (params.opportunityId) {
    const { data: opportunity } = await db
      .from("opportunities")
      .select("assigned_agent_id")
      .eq("id", params.opportunityId)
      .eq("tenant_id", params.tenantId)
      .maybeSingle();
    if (opportunity?.assigned_agent_id) return opportunity.assigned_agent_id;
  }

  const { data: openOpp } = await db
    .from("opportunities")
    .select("assigned_agent_id")
    .eq("tenant_id", params.tenantId)
    .eq("contact_id", params.contactId)
    .not("assigned_agent_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return openOpp?.assigned_agent_id ?? null;
}

async function sendOneInviteEmail(params: {
  to: AppointmentInvitePerson;
  organizer: AppointmentInvitePerson;
  subject: string;
  bodyHtml: string;
  icsContent: string;
  filename: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const apiKey = await getResendApiKey();
  const sender = getResendSender();
  if (!apiKey || !sender) {
    return { ok: false, error: "Email sending is not configured." };
  }

  const { payload } = buildResendPayload({
    senderEmail: sender.email,
    senderProductName: sender.name || "REOS",
    agentName: params.organizer.name || "REOS",
    agentEmail: params.organizer.email,
    to: [{ email: params.to.email, name: params.to.name }],
    cc: [],
    subject: params.subject,
    bodyHtml: params.bodyHtml,
  });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...payload,
      attachments: [
        {
          filename: params.filename,
          content: Buffer.from(params.icsContent, "utf8").toString("base64"),
          content_type: "text/calendar; method=REQUEST",
        },
      ],
    }),
  });

  const data = (await response.json().catch(() => null)) as {
    id?: string;
    message?: string;
  } | null;

  if (!response.ok || !data?.id) {
    console.warn("Appointment invite send failed:", response.status, data?.message);
    return {
      ok: false,
      error: data?.message?.trim() || "Could not send calendar invite.",
    };
  }

  return { ok: true, id: data.id };
}

function inviteBodyHtml(params: {
  recipientName: string | null;
  summary: string;
  label: string;
  location?: string | null;
  conferenceUrl?: string | null;
  forAgent: boolean;
}): string {
  const greeting = params.recipientName?.trim()
    ? `Hi ${params.recipientName.trim().split(" ")[0]},`
    : "Hi,";
  const roleLine = params.forAgent
    ? "A consult was booked on your REOS calendar."
    : "Your consult is confirmed.";
  const conference = params.conferenceUrl?.trim();
  const location = params.location?.trim();
  const locationIsConference = Boolean(
    conference && location && location === conference,
  );
  const joinLabel = params.forAgent ? "Join as host (start the meeting)" : "Join video";
  const joinLine = conference
    ? `<p><strong>${joinLabel}:</strong> <a href="${escapeHtml(conference)}">${escapeHtml(conference)}</a></p>`
    : "";
  const hostNote = params.forAgent && conference
    ? `<p>Open your host link first so guests are not stuck waiting for a moderator. No separate Jitsi login is required.</p>`
    : "";
  const locationLine =
    location && !locationIsConference
      ? `<p>Location: ${escapeHtml(location)}</p>`
      : "";
  return [
    `<p>${greeting}</p>`,
    `<p>${roleLine}</p>`,
    `<p><strong>${escapeHtml(params.summary)}</strong><br/>${escapeHtml(params.label)}</p>`,
    locationLine,
    joinLine,
    hostNote,
    `<p>A calendar invite is attached — add it to your calendar to keep the time.</p>`,
    `<p>Reply to this email if you need to reschedule.</p>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Email calendar invites (ICS) to the lead and assigned/creating agent via Resend.
 */
export async function sendAppointmentInvites(
  params: SendAppointmentInvitesParams,
): Promise<SendAppointmentInvitesResult> {
  const errors: string[] = [];
  let leadSent = false;
  let agentSent = false;

  if (!(await getResendApiKey()) || !getResendSender()) {
    return {
      inviteSent: false,
      leadSent: false,
      agentSent: false,
      errors: ["Email sending is not configured."],
    };
  }

  const agent =
    (params.agentUserId ? await resolveAgentRecipient(params.agentUserId) : null) ??
    params.organizerFallback ??
    null;

  const lead =
    params.lead?.email && isValidEmailAddress(params.lead.email)
      ? {
          email: normalizeEmailAddress(params.lead.email),
          name: params.lead.name,
        }
      : null;

  if (!lead && !agent) {
    return {
      inviteSent: false,
      leadSent: false,
      agentSent: false,
      errors: ["No invite recipients available."],
    };
  }

  const organizer: AppointmentInvitePerson = agent ?? {
    email: getResendSender()!.email,
    name: getResendSender()!.name || "REOS",
  };

  const attendees: AppointmentInvitePerson[] = [];
  if (lead) attendees.push(lead);
  if (agent && (!lead || agent.email !== lead.email)) attendees.push(agent);

  const conferenceUrl = params.conferenceUrl?.trim() || null;
  const hostConferenceUrl = params.hostConferenceUrl?.trim() || conferenceUrl;
  const physicalLocation =
    params.location?.trim() &&
    params.location.trim() !== conferenceUrl &&
    params.location.trim() !== hostConferenceUrl
      ? params.location.trim()
      : null;
  const location = physicalLocation || conferenceUrl || null;
  const descriptionParts = [
    params.summary,
    params.label,
    physicalLocation ? `Location: ${physicalLocation}` : null,
    conferenceUrl ? `Join video: ${conferenceUrl}` : null,
    "Booked via REOS.",
  ].filter(Boolean);

  const icsContent = buildIcsInvite({
    uid: `${params.appointmentId}@reos`,
    summary: params.summary,
    description: descriptionParts.join("\n"),
    location,
    start: params.start,
    end: params.end,
    organizer,
    attendees,
  });

  const filename = "invite.ics";
  const subject = `Calendar invite: ${params.summary}`;

  if (lead) {
    const sent = await sendOneInviteEmail({
      to: lead,
      organizer,
      subject,
      bodyHtml: inviteBodyHtml({
        recipientName: lead.name,
        summary: params.summary,
        label: params.label,
        location: physicalLocation,
        conferenceUrl,
        forAgent: false,
      }),
      icsContent,
      filename,
    });
    if (sent.ok) leadSent = true;
    else errors.push(`Lead: ${sent.error}`);
  }

  if (agent) {
    const sent = await sendOneInviteEmail({
      to: agent,
      organizer,
      subject,
      bodyHtml: inviteBodyHtml({
        recipientName: agent.name,
        summary: params.summary,
        label: params.label,
        location: physicalLocation,
        conferenceUrl: hostConferenceUrl,
        forAgent: true,
      }),
      icsContent,
      filename,
    });
    if (sent.ok) agentSent = true;
    else errors.push(`Agent: ${sent.error}`);
  }

  const inviteSent = leadSent || agentSent;

  if (inviteSent) {
    const db = getSupabaseAdmin();
    if (db) {
      const { data: existing } = await db
        .from("contact_activities")
        .select("metadata")
        .eq("id", params.appointmentId)
        .eq("tenant_id", params.tenantId)
        .maybeSingle();
      const prior =
        existing?.metadata &&
        typeof existing.metadata === "object" &&
        !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};
      const { error: metaError } = await db
        .from("contact_activities")
        .update({
          metadata: {
            ...prior,
            invite_sent_at: new Date().toISOString(),
            invite_lead_sent: leadSent,
            invite_agent_sent: agentSent,
            invite_lead_email: lead?.email ?? null,
            invite_agent_email: agent?.email ?? null,
          },
        })
        .eq("id", params.appointmentId)
        .eq("tenant_id", params.tenantId);
      if (metaError && !/metadata|schema cache|column/i.test(metaError.message)) {
        console.warn("Could not store invite metadata:", metaError.message);
      }
    }
  }

  return { inviteSent, leadSent, agentSent, errors };
}

export function defaultAppointmentEnd(start: Date, end?: Date | null): Date {
  if (end && end.getTime() > start.getTime()) return end;
  return new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);
}
