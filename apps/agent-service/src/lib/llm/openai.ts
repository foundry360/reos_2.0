import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  getOpenAIApiKey,
  getOpenAIModel,
  isOpenAIConfiguredAsync,
} from "@/lib/admin/platform-credentials";
import type { AgentPlaybook } from "../coordinator";
import { CONCIERGE_SYSTEM } from "@/agents/concierge";
import { SCHEDULER_SYSTEM } from "@/agents/scheduler";
import { FOLLOW_UP_SYSTEM } from "@/agents/follow-up";

const CRM_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "update_contact",
      description:
        "Update CRM fields on the contact. Call whenever facts change. Never paste these values into chat.",
      parameters: {
        type: "object",
        properties: {
          ai_summary: {
            type: "string",
            description: "Full overwrite of long-term AI summary of the lead",
          },
          agent_brief: {
            type: "string",
            description: "Full overwrite of CLIENT INTELLIGENCE BRIEF for humans",
          },
          recommended_next_action: { type: "string" },
          email: { type: "string" },
          lead_status: {
            type: "string",
            enum: ["New", "Working", "Contacted", "Qualified", "Converted"],
          },
          lead_temperature: {
            type: "string",
            enum: ["Hot", "Warm", "Cold"],
          },
          intent: {
            type: "string",
            enum: ["Buyer", "Seller", "Investor", "Referral"],
          },
          qualification_score: {
            type: "number",
            description: "0-100 qualification score",
          },
          ready_to_book: {
            type: "boolean",
            description: "True when lead clearly wants to schedule (routes to Scheduler)",
          },
          appt_booked: {
            type: "boolean",
            description: "True after a consult is confirmed on the calendar",
          },
          handoff: {
            type: "boolean",
            description: "True when a human should own the thread",
          },
          opted_out: {
            type: "boolean",
            description: "True when the lead asks to stop messaging",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

function systemPromptFor(playbook: AgentPlaybook): string {
  switch (playbook) {
    case "scheduler":
      return SCHEDULER_SYSTEM;
    case "follow_up":
      return FOLLOW_UP_SYSTEM;
    case "concierge":
    default:
      return CONCIERGE_SYSTEM;
  }
}

export interface AgentTurnResult {
  reply: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

export async function runAgentTurn(
  playbook: AgentPlaybook,
  history: ChatCompletionMessageParam[],
  userMessage: string,
  contextBlock: string,
): Promise<AgentTurnResult> {
  if (!(await isOpenAIConfiguredAsync())) {
    return {
      reply: `[dev] Received: ${userMessage}. Configure OPENAI_API_KEY for live replies.`,
      toolCalls: [],
    };
  }

  const apiKey = await getOpenAIApiKey();
  const client = new OpenAI({ apiKey });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${systemPromptFor(playbook)}\n\n---\nCRM CONTEXT:\n${contextBlock}`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  const completion = await client.chat.completions.create({
    model: getOpenAIModel(),
    messages,
    tools: CRM_TOOLS,
    tool_choice: "auto",
    max_tokens: 500,
  });

  const choice = completion.choices[0];
  const toolCalls: AgentTurnResult["toolCalls"] = [];

  if (choice.message.tool_calls?.length) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type !== "function") continue;
      toolCalls.push({
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
      });
    }
  }

  const reply =
    choice.message.content?.trim() ||
    "Thanks for your message. A team member will follow up shortly.";

  return { reply, toolCalls };
}
