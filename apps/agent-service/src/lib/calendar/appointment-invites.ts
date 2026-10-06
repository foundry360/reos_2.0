import {
  reportAppointmentEmailIssues,
  type AppointmentEmailIssue,
} from "@/lib/calendar/appointment-email-issues";
import { buildIcsInvite } from "@/lib/calendar/ics";
import { CONSULT_MINUTES } from "@/lib/calendar/consult-slots";
import {
  isValidEmailAddress,
  normalizeEmailAddress,
  resolveReplyToEmail,
} from "@/lib/email/email-utils";
import { getResendApiKey } from "@/lib/admin/resend";
import type { EmailPurpose } from "@/lib/email/email-purpose";
import { beginOutboundEmail, recordOutboundEmailOutcome } from "@/lib/email/outbound-email-ledger";
import { getResendSender, reosEmailTags, sendResendMessage } from "@/lib/email/resend";
import { outcomeOf } from "@/lib/messaging/provider-outcome";
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
  /** Shared video join URL (public Jitsi Meet). */
  conferenceUrl?: string | null;
  /** Host/moderator join URL for the agent invite. */
  hostConferenceUrl?: string | null;
  lead: AppointmentInvitePerson | null;
  /** Agent who should also receive the invite (assigned agent or creator). */
  agentUserId: string | null;
  /** Fallback reply-to / organizer when agent profile is unavailable. */
  organizerFallback?: AppointmentInvitePerson | null;
  /** Set when an existing appointment moved: same uid, higher sequence, "moved" wording. */
  update?: { sequence: number; previousLabel: string | null };
}

export interface SendAppointmentInvitesResult {
  inviteSent: boolean;
  leadSent: boolean;
  agentSent: boolean;
  errors: string[];
}

export async function resolveAgentRecipient(
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
 * Prefer contact assigned agent, then opportunity assigned agent, then the workspace owner.
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

  if (openOpp?.assigned_agent_id) return openOpp.assigned_agent_id;

  const { data: owner } = await db
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", params.tenantId)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return owner?.user_id ?? null;
}

export type AppointmentNotification = "invite" | "reschedule" | "cancellation";
export type AppointmentRecipientRole = "lead" | "agent";

/**
 * Set by this operation, never by a caller: the lead's copy is transactional
 * (the contact's email unsubscribe doesn't stop it), the agent's copy is
 * operational email to a REOS user.
 */
const PURPOSE_BY_ROLE: Record<AppointmentRecipientRole, EmailPurpose> = {
  lead: "transactional",
  agent: "operational",
};

/**
 * The identity of one appointment email: the appointment, what happened to it,
 * the calendar sequence the change was stored with (0 for the invite), and
 * who it is to. A repeat of the same operation finds the same record.
 */
export function appointmentEmailKey(
  appointmentId: string,
  notification: AppointmentNotification,
  sequence: number,
  role: AppointmentRecipientRole,
): string {
  return `appointment:${appointmentId}:${notification}:${sequence}:${role}`;
}

type AppointmentEmailResult =
  | { status: "sent" }
  | { status: "failed" | "unknown" | "pending" | "not_sent"; error: string };

const UNRESOLVED_ERROR = "An earlier attempt at this email wasn't confirmed, so it wasn't sent again.";

/**
 * One appointment email through the outbound record: a pending crm_emails row
 * before Resend is called, then Resend's answer (sent with its id, failed, or
 * unknown). A sent record is returned without sending again; a pending or
 * unknown one is never resent.
 */
async function sendAppointmentEmail(params: {
  tenantId: string;
  contactId: string;
  appointmentId: string;
  notification: AppointmentNotification;
  sequence: number;
  role: AppointmentRecipientRole;
  to: AppointmentInvitePerson;
  organizer: AppointmentInvitePerson;
  subject: string;
  bodyHtml: string;
  icsContent: string;
  filename: string;
  method: "REQUEST" | "CANCEL";
}): Promise<AppointmentEmailResult> {
  const sender = getResendSender();
  if (!sender) return { status: "not_sent", error: "Email sending is not configured." };
  const key = appointmentEmailKey(params.appointmentId, params.notification, params.sequence, params.role);
  const to = [{ email: params.to.email, name: params.to.name }];
  const agentName = params.organizer.name || "REOS";

  const attempt = await beginOutboundEmail({
    tenantId: params.tenantId,
    contactId: params.role === "lead" ? params.contactId : null,
    idempotencyKey: key,
    purpose: PURPOSE_BY_ROLE[params.role],
    threadId: `appointment:${params.appointmentId}`,
    fromEmail: sender.email,
    fromName: agentName,
    to,
    subject: params.subject,
    bodyHtml: params.bodyHtml,
    metadata: {
      appointment_id: params.appointmentId,
      appointment_notification: params.notification,
      recipient_role: params.role,
      sequence: params.sequence,
      organizer_email: params.organizer.email,
      reply_to: params.organizer.email,
    },
  });
  if (attempt.status === "already_sent") return { status: "sent" };
  if (attempt.status === "unresolved") return { status: attempt.sendStatus, error: UNRESOLVED_ERROR };
  if (attempt.status === "error") return { status: "not_sent", error: attempt.error };
  if (attempt.status === "conflict") return { status: "not_sent", error: "This email's record holds a different email, so it wasn't sent." };

  const result = await sendResendMessage({
    to,
    cc: [],
    subject: params.subject,
    bodyHtml: params.bodyHtml,
    replyTo: params.organizer.email,
    agentName,
    idempotencyKey: key,
    attachments: [
      { filename: params.filename, content: params.icsContent, contentType: `text/calendar; method=${params.method}` },
    ],
    tags: reosEmailTags(attempt.emailId),
  });
  const outcome = outcomeOf(result);
  await recordOutboundEmailOutcome({ tenantId: params.tenantId, emailId: attempt.emailId, outcome });
  if (outcome.status === "sent") return { status: "sent" };
  console.warn("Appointment email not sent:", params.notification, params.role, outcome.status);
  return { status: outcome.status, error: outcome.error };
}

function issueOf(role: AppointmentRecipientRole, result: AppointmentEmailResult): AppointmentEmailIssue | null {
  if (result.status === "sent") return null;
  return { role, kind: result.status === "unknown" || result.status === "pending" ? "not_confirmed" : "not_sent" };
}

async function appointmentContactId(tenantId: string, appointmentId: string): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;
  const { data } = await db
    .from("contact_activities")
    .select("contact_id")
    .eq("id", appointmentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return typeof data?.contact_id === "string" ? data.contact_id : null;
}

function inviteBodyHtml(params: {
  recipientName: string | null;
  summary: string;
  label: string;
  location?: string | null;
  conferenceUrl?: string | null;
  forAgent: boolean;
  update?: { previousLabel: string | null };
}): string {
  const greeting = params.recipientName?.trim()
    ? `Hi ${params.recipientName.trim().split(" ")[0]},`
    : "Hi,";
  const from = params.update?.previousLabel ? ` from ${escapeHtml(params.update.previousLabel)}` : "";
  const roleLine = params.update
    ? params.forAgent
      ? `A consult on your REOS calendar was rescheduled${from}. Your calendar will update to the new time.`
      : `Your consult has been rescheduled${from}. Your calendar will update to the new time.`
    : params.forAgent
      ? "A consult was booked on your REOS calendar."
      : "Your consult is confirmed.";
  const conference = params.conferenceUrl?.trim();
  const location = params.location?.trim();
  const locationIsConference = Boolean(
    conference && location && location === conference,
  );
  const joinLine = conference
    ? `<p><strong>Join video:</strong> <a href="${escapeHtml(conference)}">${escapeHtml(conference)}</a></p>`
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

  const contactId = await appointmentContactId(params.tenantId, params.appointmentId);
  if (!contactId) {
    return {
      inviteSent: false,
      leadSent: false,
      agentSent: false,
      errors: ["The appointment couldn't be found, so no invite was sent."],
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
    sequence: params.update?.sequence ?? 0,
  });

  const filename = "invite.ics";
  const issues: AppointmentEmailIssue[] = [];
  const subject = params.update
    ? `Rescheduled: ${params.summary} (${params.label})`
    : `Calendar invite: ${params.summary}`;
  const update = params.update ? { previousLabel: params.update.previousLabel } : undefined;
  const operation = {
    tenantId: params.tenantId,
    contactId,
    appointmentId: params.appointmentId,
    notification: params.update ? ("reschedule" as const) : ("invite" as const),
    sequence: params.update?.sequence ?? 0,
    organizer,
    subject,
    icsContent,
    filename,
    method: "REQUEST" as const,
  };

  if (lead) {
    const sent = await sendAppointmentEmail({
      ...operation,
      role: "lead",
      to: lead,
      bodyHtml: inviteBodyHtml({
        recipientName: lead.name,
        summary: params.summary,
        label: params.label,
        location: physicalLocation,
        conferenceUrl,
        forAgent: false,
        update,
      }),
    });
    if (sent.status === "sent") leadSent = true;
    else errors.push(`Lead: ${sent.error}`);
    const issue = issueOf("lead", sent);
    if (issue) issues.push(issue);
  }

  if (agent) {
    const sent = await sendAppointmentEmail({
      ...operation,
      role: "agent",
      to: agent,
      bodyHtml: inviteBodyHtml({
        recipientName: agent.name,
        summary: params.summary,
        label: params.label,
        location: physicalLocation,
        conferenceUrl: hostConferenceUrl,
        forAgent: true,
        update,
      }),
    });
    if (sent.status === "sent") agentSent = true;
    else errors.push(`Agent: ${sent.error}`);
    const issue = issueOf("agent", sent);
    if (issue) issues.push(issue);
  }

  if (issues.length > 0) {
    await reportAppointmentEmailIssues({
      tenantId: params.tenantId,
      contactId,
      notification: operation.notification,
      issues,
      appointmentLabel: `${params.summary} · ${params.label}`,
      notifyUserId:
        params.agentUserId ?? (await resolveAssignedAgentUserId({ tenantId: params.tenantId, contactId })),
    });
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

export interface SendAppointmentCancellationParams {
  tenantId: string;
  appointmentId: string;
  summary: string;
  label: string;
  start: Date;
  end: Date;
  /** Higher than the last invite's sequence. */
  sequence: number;
  /** The appointment's metadata as the last invite left it (invite_* keys). */
  metadata: Record<string, unknown>;
}

function invitedEmail(metadata: Record<string, unknown>, sentKey: string, emailKey: string): string | null {
  const email = metadata[emailKey];
  return metadata[sentKey] === true && typeof email === "string" && isValidEmailAddress(email)
    ? normalizeEmailAddress(email)
    : null;
}

type InviteLedger = {
  /** Per role: the address of the latest confirmed invite or reschedule email. */
  sentTo: Partial<Record<AppointmentRecipientRole, string>>;
  /** Per role: an invite or reschedule email that may or may not have been sent. */
  unconfirmed: Partial<Record<AppointmentRecipientRole, true>>;
  organizerEmail: string | null;
};

/** What the outbound record says about this appointment's invites; null when it couldn't be read. */
async function readInviteLedger(tenantId: string, appointmentId: string): Promise<InviteLedger | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;
  const { data, error } = await db
    .from("crm_emails")
    .select("status, to_recipients, metadata")
    .eq("tenant_id", tenantId)
    .eq("metadata->>appointment_id", appointmentId);
  if (error) {
    console.error("Appointment invite record read error:", error.code ?? error.message);
    return null;
  }
  const ledger: InviteLedger = { sentTo: {}, unconfirmed: {}, organizerEmail: null };
  const latestSent: Partial<Record<AppointmentRecipientRole, number>> = {};
  let latestOrganizerSequence = -1;
  for (const row of data ?? []) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const notification = metadata.appointment_notification;
    const role = metadata.recipient_role;
    if (notification !== "invite" && notification !== "reschedule") continue;
    if (role !== "lead" && role !== "agent") continue;
    const sequence = typeof metadata.sequence === "number" ? metadata.sequence : 0;
    if (row.status === "sent") {
      const address = (Array.isArray(row.to_recipients) ? row.to_recipients[0] : null) as { email?: unknown } | null;
      if (typeof address?.email === "string" && sequence > (latestSent[role] ?? -1)) {
        latestSent[role] = sequence;
        ledger.sentTo[role] = address.email;
      }
      if (typeof metadata.organizer_email === "string" && sequence > latestOrganizerSequence) {
        latestOrganizerSequence = sequence;
        ledger.organizerEmail = metadata.organizer_email;
      }
    } else if (row.status === "pending" || row.status === "unknown") {
      ledger.unconfirmed[role] = true;
    }
  }
  return ledger;
}

const NONE_SENT: SendAppointmentInvitesResult = { inviteSent: false, leadSent: false, agentSent: false, errors: [] };

/**
 * Withdraw a sent invite: a METHOD:CANCEL .ics with the invite's uid, from the
 * organizer of the last invite, to only the people it was confirmed sent to.
 *
 * Per person, the outbound record decides: a sent invite or reschedule email
 * gets the cancellation. Appointments invited before that record existed rely
 * on the invite_* metadata, which was only ever set on a confirmed send. An
 * invite that failed, or was never sent, gets nothing. An invite whose outcome
 * is unknown or still pending gets nothing either, and is reported so the
 * agent can tell the person directly.
 */
export async function sendAppointmentCancellation(
  params: SendAppointmentCancellationParams,
): Promise<SendAppointmentInvitesResult> {
  const issues: AppointmentEmailIssue[] = [];
  const result = await cancelAppointmentInvites(params, issues);
  if (issues.length > 0) {
    const contactId = await appointmentContactId(params.tenantId, params.appointmentId);
    if (contactId) {
      await reportAppointmentEmailIssues({
        tenantId: params.tenantId,
        contactId,
        notification: "cancellation",
        issues,
        appointmentLabel: `${params.summary} · ${params.label}`,
        notifyUserId: await resolveAssignedAgentUserId({ tenantId: params.tenantId, contactId }),
      });
    }
  }
  return result;
}

async function cancelAppointmentInvites(
  params: SendAppointmentCancellationParams,
  issues: AppointmentEmailIssue[],
): Promise<SendAppointmentInvitesResult> {
  const ledger = await readInviteLedger(params.tenantId, params.appointmentId);
  if (!ledger) {
    return { ...NONE_SENT, errors: ["Couldn't check which invites were sent, so no cancellation was emailed."] };
  }
  const leadEmail =
    ledger.sentTo.lead ?? invitedEmail(params.metadata, "invite_lead_sent", "invite_lead_email");
  const agentEmail =
    ledger.sentTo.agent ?? invitedEmail(params.metadata, "invite_agent_sent", "invite_agent_email");

  const errors: string[] = [];
  if (!leadEmail && ledger.unconfirmed.lead) {
    errors.push("Lead: the invite was never confirmed as sent, so no cancellation was emailed. Let them know directly.");
    issues.push({ role: "lead", kind: "invite_not_confirmed" });
  }
  if (!agentEmail && ledger.unconfirmed.agent) {
    errors.push("Agent: the invite was never confirmed as sent, so no cancellation was emailed.");
    issues.push({ role: "agent", kind: "invite_not_confirmed" });
  }
  if (!leadEmail && !agentEmail) return { ...NONE_SENT, errors };

  const sender = getResendSender();
  if (!(await getResendApiKey()) || !sender) {
    return { ...NONE_SENT, errors: [...errors, "Email sending is not configured."] };
  }
  const contactId = await appointmentContactId(params.tenantId, params.appointmentId);
  if (!contactId) {
    return { ...NONE_SENT, errors: [...errors, "The appointment couldn't be found, so no cancellation was emailed."] };
  }

  // The invite's organizer was the agent when there was one, else the sender.
  const storedAgentEmail = ledger.organizerEmail ?? params.metadata.invite_agent_email;
  const organizer: AppointmentInvitePerson =
    typeof storedAgentEmail === "string" && isValidEmailAddress(storedAgentEmail)
      ? { email: normalizeEmailAddress(storedAgentEmail), name: null }
      : { email: sender.email, name: sender.name || "REOS" };

  const recipients: AppointmentInvitePerson[] = [];
  if (leadEmail) recipients.push({ email: leadEmail, name: null });
  if (agentEmail && agentEmail !== leadEmail) recipients.push({ email: agentEmail, name: null });

  const icsContent = buildIcsInvite({
    uid: `${params.appointmentId}@reos`,
    summary: params.summary,
    description: [params.summary, params.label, "Cancelled via REOS."].join("\n"),
    start: params.start,
    end: params.end,
    organizer,
    attendees: recipients,
    sequence: params.sequence,
    method: "CANCEL",
  });

  let leadSent = false;
  let agentSent = false;
  for (const to of recipients) {
    const forAgent = to.email === agentEmail && to.email !== leadEmail;
    const sent = await sendAppointmentEmail({
      tenantId: params.tenantId,
      contactId,
      appointmentId: params.appointmentId,
      notification: "cancellation",
      sequence: params.sequence,
      role: forAgent ? "agent" : "lead",
      to,
      organizer,
      subject: `Cancelled: ${params.summary} (${params.label})`,
      bodyHtml: [
        "<p>Hi,</p>",
        `<p>${forAgent ? "A consult on your REOS calendar was cancelled." : "Your consult has been cancelled."}</p>`,
        `<p><strong>${escapeHtml(params.summary)}</strong><br/>${escapeHtml(params.label)}</p>`,
        "<p>The attached update removes it from your calendar.</p>",
      ].join("\n"),
      icsContent,
      filename: "cancel.ics",
      method: "CANCEL",
    });
    if (sent.status === "sent") {
      if (forAgent) agentSent = true;
      else leadSent = true;
    } else {
      errors.push(`${forAgent ? "Agent" : "Lead"}: ${sent.error}`);
    }
    const issue = issueOf(forAgent ? "agent" : "lead", sent);
    if (issue) issues.push(issue);
  }
  return { inviteSent: leadSent || agentSent, leadSent, agentSent, errors };
}

export function defaultAppointmentEnd(start: Date, end?: Date | null): Date {
  if (end && end.getTime() > start.getTime()) return end;
  return new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);
}
