/**
 * Why an email is being sent, which decides whether the contact's email
 * unsubscribe stops it. Pure module (no `@/` imports) so it runs under node --test.
 *
 * The purpose is fixed by the server-side operation that sends the email, never
 * by a caller or by the content:
 * - marketing: journey send_email (including journey-built reminders).
 * - conversational: CRM compose, a person writing to the contact.
 * - transactional: appointment invite, reschedule and cancellation to the lead.
 * - operational: workspace and account email to REOS users (the agent's copy of
 *   an appointment email); not addressed to the contact, so the contact's
 *   unsubscribe doesn't apply.
 */

export type EmailPurpose = "marketing" | "conversational" | "transactional" | "operational";

/** Only transactional and operational email is exempt; anything else, unrecognised included, is blocked. */
export function unsubscribeBlocks(purpose: EmailPurpose): boolean {
  return purpose !== "transactional" && purpose !== "operational";
}
