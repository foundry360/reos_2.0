import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { getEnv, isOpenAIConfigured } from "../env";
import type { AgentPlaybook } from "../coordinator";
import { CONCIERGE_SYSTEM } from "@/agents/concierge";
import { SCHEDULER_SYSTEM } from "@/agents/scheduler";
import { FOLLOW_UP_SYSTEM } from "@/agents/follow-up";

const CRM_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "update_contact",
      description: "Update CRM fields on the Salesforce Contact",
      parameters: {
        type: "object",
        properties: {
          ai_summary: { type: "string" },
          lead_status: {
            type: "string",
            enum: [
              "Qualifying",
              "Ready_to_Book",
              "Nurture",
              "Booked",
              "Handoff",
            ],
          },
          lead_temperature: {
            type: "string",
            enum: ["Hot", "Warm", "Cold"],
          },
          qualification_score: { type: "number" },
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
  if (!isOpenAIConfigured()) {
    return {
      reply: `[dev] Received: ${userMessage}. Configure OPENAI_API_KEY for live replies.`,
      toolCalls: [],
    };
  }

  const env = getEnv();
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${systemPromptFor(playbook)}\n\n---\nCRM CONTEXT:\n${contextBlock}`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  const completion = await client.chat.completions.create({
    model: env.OPENAI_MODEL,
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
