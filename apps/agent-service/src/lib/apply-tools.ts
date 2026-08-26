import type { AgentTurnResult } from "@/lib/llm/openai";
import { updateContactFields } from "@/lib/sf/client";

export async function applyToolCalls(
  contactId: string | undefined,
  toolCalls: AgentTurnResult["toolCalls"],
): Promise<void> {
  if (!contactId || toolCalls.length === 0) return;

  const fields: Record<string, string | number | boolean> = {};

  for (const call of toolCalls) {
    if (call.name !== "update_contact") continue;
    const args = call.args;
    if (typeof args.ai_summary === "string") fields.AI_Summary__c = args.ai_summary;
    if (typeof args.lead_status === "string")
      fields.Lead_Status__c = args.lead_status;
    if (typeof args.lead_temperature === "string")
      fields.Lead_Temperature__c = args.lead_temperature;
    if (typeof args.qualification_score === "number")
      fields.Qualification_Score__c = args.qualification_score;
  }

  if (Object.keys(fields).length > 0) {
    await updateContactFields(contactId, fields);
  }
}
