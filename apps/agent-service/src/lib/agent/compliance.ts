import type { ContactContext } from "@/lib/coordinator";
import type { AgentBackend } from "@/lib/agent/backend";

/**
 * Opt-out and opt-in keywords. A keyword counts only as the whole message
 * (case, surrounding whitespace, and trailing . or ! ignored), so "cancel my
 * appointment" or "end of the month works" is never an opt-out.
 *
 * CANCEL, END, QUIT, and STOPALL are carrier (CTIA) opt-out keywords for SMS and
 * are honored there; in Messenger and Instagram they're ordinary words. START
 * and UNSTOP are the SMS opt-in keywords; they only re-subscribe a contact that
 * is opted out, and only over SMS.
 */
const OPT_OUT_KEYWORDS = new Set([
  "stop",
  "unsubscribe",
  "remove me",
  "don't text",
  "do not text",
  "dont text",
  "stop texting",
  "please stop",
  "not interested",
]);
const SMS_OPT_OUT_KEYWORDS = new Set(["cancel", "end", "quit", "stopall"]);
const SMS_OPT_IN_KEYWORDS = new Set(["start", "unstop"]);

export const OPT_OUT_REPLY = "You have been unsubscribed.";
export const OPT_IN_REPLY = "You're subscribed again. Reply STOP to opt out.";

function normalize(body: string): string {
  return body.trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
}

export function isOptOutMessage(body: string, channel = "sms"): boolean {
  const normalized = normalize(body);
  return OPT_OUT_KEYWORDS.has(normalized) || (channel === "sms" && SMS_OPT_OUT_KEYWORDS.has(normalized));
}

export function isOptInMessage(body: string, channel = "sms"): boolean {
  return channel === "sms" && SMS_OPT_IN_KEYWORDS.has(normalize(body));
}

/**
 * What compliance decides before the agent runs. `blocked`: the agent must not
 * run; `reply` (possibly empty) is the only thing to send. Not blocked: the
 * agent runs as usual.
 */
export type ComplianceDecision = { blocked: false } | { blocked: true; reply: string; optedOut: boolean };

export async function applyCompliance(
  backend: AgentBackend,
  ctx: ContactContext,
  body: string,
  channel: string,
): Promise<ComplianceDecision> {
  if (ctx.optedOut) {
    if (!isOptInMessage(body, channel)) return { blocked: true, reply: "", optedOut: true };
    if (ctx.contactId) await backend.patchContact(ctx.contactId, { opted_out: false });
    ctx.optedOut = false;
    return { blocked: true, reply: OPT_IN_REPLY, optedOut: false };
  }
  if (!isOptOutMessage(body, channel)) return { blocked: false };
  if (ctx.contactId) {
    await backend.patchContact(ctx.contactId, {
      opted_out: true,
      ready_to_book: false,
    });
  }
  return { blocked: true, reply: OPT_OUT_REPLY, optedOut: true };
}
