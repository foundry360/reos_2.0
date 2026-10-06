import { logSystemContactActivity } from "@/lib/crm/log-system-activity";
import { notifyMembers } from "@/lib/notifications/notify-members";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type AppointmentEmailRole = "lead" | "agent";
export type AppointmentEmailNotification = "invite" | "reschedule" | "cancellation";

/**
 * One appointment email that isn't confirmed sent:
 * "not_sent": the provider rejected it, or it was never handed over.
 * "not_confirmed": it may or may not have been sent.
 * "invite_not_confirmed": no cancellation was sent because the invite itself was never confirmed.
 */
export type AppointmentEmailIssue = {
  role: AppointmentEmailRole;
  kind: "not_sent" | "not_confirmed" | "invite_not_confirmed";
};

const NOUN: Record<AppointmentEmailNotification, string> = {
  invite: "Calendar invite",
  reschedule: "Reschedule notice",
  cancellation: "Cancellation",
};

function issueLine(notification: AppointmentEmailNotification, issue: AppointmentEmailIssue): string {
  const who = issue.role === "lead" ? "the lead" : "the agent";
  const noun = NOUN[notification].toLowerCase();
  switch (issue.kind) {
    case "not_sent":
      return issue.role === "lead"
        ? `Not sent to ${who}: the ${noun} email didn't go out. Let them know directly.`
        : `Not sent to ${who}: the ${noun} email didn't go out.`;
    case "not_confirmed":
      return issue.role === "lead"
        ? `Not confirmed for ${who}: the ${noun} email may or may not have arrived. Check with them before sending it again.`
        : `Not confirmed for ${who}: the ${noun} email may or may not have arrived.`;
    case "invite_not_confirmed":
      return issue.role === "lead"
        ? `Cancellation not sent to ${who} because the invite was never confirmed. Let them know directly.`
        : `Cancellation not sent to ${who} because the invite was never confirmed.`;
  }
}

/** The operator-facing record of appointment emails that aren't confirmed sent. No addresses or provider errors. */
export function describeAppointmentEmailIssues(
  notification: AppointmentEmailNotification,
  issues: AppointmentEmailIssue[],
  appointmentLabel: string,
): { title: string; body: string } {
  const kinds = new Set(issues.map((issue) => issue.kind));
  const noun = NOUN[notification];
  const title =
    kinds.size === 1 && kinds.has("invite_not_confirmed")
      ? "Cancellation not sent: invite not confirmed"
      : kinds.size === 1 && kinds.has("not_sent")
        ? `${noun} not sent`
        : kinds.size === 1 && kinds.has("not_confirmed")
          ? `${noun} not confirmed`
          : `${noun} needs attention`;
  return { title, body: [appointmentLabel, ...issues.map((issue) => issueLine(notification, issue))].join("\n") };
}

/**
 * Records appointment emails that aren't confirmed sent where the operator will
 * see them: an activity on the person, and a system notification to the
 * assigned agent. Never throws; the appointment change itself already happened.
 */
export async function reportAppointmentEmailIssues(params: {
  tenantId: string;
  contactId: string;
  notification: AppointmentEmailNotification;
  issues: AppointmentEmailIssue[];
  appointmentLabel: string;
  notifyUserId: string | null;
}): Promise<void> {
  if (params.issues.length === 0) return;
  try {
    const { title, body } = describeAppointmentEmailIssues(params.notification, params.issues, params.appointmentLabel);
    await logSystemContactActivity({
      tenantId: params.tenantId,
      contactId: params.contactId,
      activityType: "email",
      title,
      body,
    });
    const db = getSupabaseAdmin();
    if (!db || !params.notifyUserId) return;
    const notified = await notifyMembers(db, {
      tenantId: params.tenantId,
      userIds: [params.notifyUserId],
      category: "system",
      title,
      body,
      href: `/leads/${params.contactId}`,
    });
    if (notified.status === "failed") console.error("Appointment email issue notification failed:", notified.operation);
  } catch (error) {
    console.error("Appointment email issue report failed:", error instanceof Error ? error.name : "unknown");
  }
}
