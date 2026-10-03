import type { ContactContext } from "@/lib/coordinator";
import type { AgentBackend } from "@/lib/agent/backend";

const OPT_OUT_KEYWORDS = new Set([
  "stop",
  "unsubscribe",
  "cancel",
  "quit",
  "end",
  "remove me",
  "don't text",
  "do not text",
  "dont text",
]);

export function isOptOutMessage(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  if (OPT_OUT_KEYWORDS.has(normalized)) return true;
  return (
    normalized === "stop texting" ||
    normalized === "please stop" ||
    normalized === "not interested"
  );
}

/** True when the agent must not reply (already opted out, or this message opts out). */
export async function applyCompliance(
  backend: AgentBackend,
  ctx: ContactContext,
  body: string,
): Promise<boolean> {
  if (ctx.optedOut) return true;
  if (!isOptOutMessage(body)) return false;
  if (ctx.contactId) {
    await backend.patchContact(ctx.contactId, {
      opted_out: true,
      ready_to_book: false,
    });
  }
  return true;
}
