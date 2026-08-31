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
        "Silently update CRM fields. Call when the lead shares facts. Always also write a normal chat reply in the same turn (or after tools). Never refuse ordinary questions.",
      parameters: {
        type: "object",
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          email: { type: "string" },
          phone: {
            type: "string",
            description: "Mobile phone; stored as SMS identity when provided",
          },
          intent: {
            type: "string",
            enum: ["Buyer", "Seller", "Investor", "Referral"],
          },
          target_location: {
            type: "string",
            description: "City, neighborhood, or area of interest",
          },
          property_type: {
            type: "string",
            description:
              "e.g. Single Family, Condo, Townhome, Multi-Family, Land, Commercial, Other",
          },
          budget: { type: "string", description: "Budget or price range" },
          timeline: {
            type: "string",
            description:
              "ASAP | 0-30 Days | 1-3 Months | 3-6 Months | 6+ Months | Just Exploring",
          },
          financing_status: {
            type: "string",
            description:
              "Cash | Pre-Approved | Pre-Qualified | Needs Financing | Unknown",
          },
          must_haves: {
            type: "string",
            description: "Beds, baths, garage, pool, yard, etc.",
          },
          motivation: { type: "string" },
          preferences: {
            type: "string",
            description: "Other preferences not covered above",
          },
          ai_summary: {
            type: "string",
            description: "Full overwrite of long-term AI summary of the lead",
          },
          agent_brief: {
            type: "string",
            description: "Full overwrite of CLIENT INTELLIGENCE BRIEF for humans",
          },
          recommended_next_action: { type: "string" },
          lead_status: {
            type: "string",
            enum: ["New", "Working", "Contacted", "Qualified", "Converted"],
          },
          lead_temperature: {
            type: "string",
            enum: ["Hot", "Warm", "Cold"],
          },
          qualification_score: {
            type: "number",
            description: "0-100 qualification score",
          },
          ready_to_book: {
            type: "boolean",
            description:
              "True only after the lead clearly agrees to schedule a consult. Never set true just because they asked a question.",
          },
          appt_booked: {
            type: "boolean",
            description: "True after a consult is confirmed",
          },
          handoff: {
            type: "boolean",
            description:
              "True only when the lead asks for a person, is upset, or you are stuck after trying to help. Never hand off for ordinary questions.",
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

function collectToolCalls(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): AgentTurnResult["toolCalls"] {
  const toolCalls: AgentTurnResult["toolCalls"] = [];
  if (!message.tool_calls?.length) return toolCalls;
  for (const tc of message.tool_calls) {
    if (tc.type !== "function") continue;
    toolCalls.push({
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments || "{}") as Record<
        string,
        unknown
      >,
    });
  }
  return toolCalls;
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
  const model = getOpenAIModel();

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${systemPromptFor(playbook)}\n\n---\nCRM CONTEXT:\n${contextBlock}`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  const first = await client.chat.completions.create({
    model,
    messages,
    tools: CRM_TOOLS,
    tool_choice: "auto",
    max_tokens: 700,
  });

  const firstMsg = first.choices[0]?.message;
  if (!firstMsg) {
    return {
      reply: "Hey, thanks for reaching out. What can I help with today?",
      toolCalls: [],
    };
  }

  const toolCalls = collectToolCalls(firstMsg);
  let reply = firstMsg.content?.trim() ?? "";

  // Models often tool-call with empty content. Run a follow-up turn for the chat reply.
  if (firstMsg.tool_calls?.length) {
    messages.push({
      role: "assistant",
      content: firstMsg.content ?? "",
      tool_calls: firstMsg.tool_calls,
    });
    for (const tc of firstMsg.tool_calls) {
      if (tc.type !== "function") continue;
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({ ok: true, saved: true }),
      });
    }

    try {
      const second = await client.chat.completions.create({
        model,
        messages: [
          ...messages,
          {
            role: "user",
            content:
              "[Internal] Reply to the lead now in 1-3 short sentences. Answer what they said. Do not refuse ordinary real-estate questions. Do not say you cannot provide information. Do not pivot to scheduling unless they asked.",
          },
        ],
        max_tokens: 400,
      });
      reply = second.choices[0]?.message?.content?.trim() || reply;
    } catch (error) {
      console.error("Agent follow-up completion failed:", error);
    }
  }

  if (!reply) {
    reply =
      "Happy to help. What are you looking to do: buy, sell, or invest?";
  }

  return { reply, toolCalls };
}
