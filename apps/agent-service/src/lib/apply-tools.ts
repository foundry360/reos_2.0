import type { AgentTurnResult } from "@/lib/llm/openai";
import { updateContactFields } from "@/lib/db/contacts";

export async function applyToolCalls(
  contactId: string | undefined,
  toolCalls: AgentTurnResult["toolCalls"],
): Promise<void> {
  if (!contactId || toolCalls.length === 0) return;

  const fields: Record<string, string | number | boolean | null> = {};

  for (const call of toolCalls) {
    if (call.name !== "update_contact") continue;
    const args = call.args;
    if (typeof args.ai_summary === "string") fields.ai_summary = args.ai_summary;
    if (typeof args.lead_status === "string") fields.lead_status = args.lead_status;
    if (typeof args.lead_temperature === "string")
      fields.lead_temperature = args.lead_temperature;
    if (typeof args.qualification_score === "number")
      fields.qualification_score = args.qualification_score;
    if (args.lead_status === "Compliance") fields.opted_out = true;
  }

  if (Object.keys(fields).length > 0) {
    await updateContactFields(contactId, fields);
  }
}
