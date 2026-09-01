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
import { applyToolCalls } from "@/lib/apply-tools";
import {
  bookConsultSlot,
  getAvailableConsultSlots,
  type SlotPreference,
} from "@/lib/google/calendar";
import { markConsultBooked } from "@/lib/db/contacts";

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

const SCHEDULER_CALENDAR_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_available_slots",
      description:
        "Fetch 2-3 real open consult times from the connected Google Calendar. Call after you know mornings vs afternoons (or any). Pass day when the lead names a weekday. Never invent times.",
      parameters: {
        type: "object",
        properties: {
          preference: {
            type: "string",
            enum: ["morning", "afternoon", "any"],
            description: "Time-of-day preference from the lead",
          },
          day: {
            type: "string",
            description:
              "Optional preferred day: weekday name (wednesday) or YYYY-MM-DD",
          },
          limit: {
            type: "number",
            description: "How many slots to return (1-5, default 3)",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book a consult on the connected Google Calendar for a slot previously returned by get_available_slots. On success the CRM is marked appt_booked and an email invite is sent when attendee_email is known. Never invent start times.",
      parameters: {
        type: "object",
        properties: {
          start: {
            type: "string",
            description: "Exact ISO start time from get_available_slots",
          },
          end: {
            type: "string",
            description: "Exact ISO end time from get_available_slots (optional)",
          },
          attendee_email: {
            type: "string",
            description: "Lead email for the calendar invite when available",
          },
        },
        required: ["start"],
        additionalProperties: false,
      },
    },
  },
];

/** Strip common markdown so SMS/Messenger/IG stay plain text. */
export function stripChatMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/```\w*\n?/g, "").replace(/```/g, "").trim(),
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toolsFor(playbook: AgentPlaybook): ChatCompletionTool[] {
  if (playbook === "scheduler") {
    return [...CRM_TOOLS, ...SCHEDULER_CALENDAR_TOOLS];
  }
  return CRM_TOOLS;
}

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

export interface AgentTurnOptions {
  tenantId?: string;
  contactId?: string;
  email?: string;
  leadName?: string;
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

async function executeOneTool(
  name: string,
  args: Record<string, unknown>,
  options: AgentTurnOptions,
): Promise<unknown> {
  if (name === "update_contact") {
    await applyToolCalls(options.contactId, [{ name, args }]);
    return { ok: true, saved: true };
  }

  if (name === "get_available_slots") {
    if (!options.tenantId) {
      return { ok: false, error: "Missing tenant for calendar lookup." };
    }
    const preference =
      args.preference === "morning" ||
      args.preference === "afternoon" ||
      args.preference === "any"
        ? (args.preference as SlotPreference)
        : "any";
    const limit = typeof args.limit === "number" ? args.limit : 3;
    const day = typeof args.day === "string" ? args.day : undefined;
    return getAvailableConsultSlots({
      tenantId: options.tenantId,
      preference,
      day,
      limit,
    });
  }

  if (name === "book_appointment") {
    if (!options.tenantId) {
      return { ok: false, error: "Missing tenant for calendar booking." };
    }
    const start = typeof args.start === "string" ? args.start : "";
    const end = typeof args.end === "string" ? args.end : undefined;
    const attendeeEmail =
      (typeof args.attendee_email === "string" && args.attendee_email) ||
      options.email ||
      null;
    const booked = await bookConsultSlot({
      tenantId: options.tenantId,
      start,
      end,
      attendeeEmail,
      leadName: options.leadName,
    });
    if (booked.ok && options.contactId) {
      await markConsultBooked(options.contactId, { email: attendeeEmail });
    }
    // Do not return htmlLink — the model pastes it as markdown links.
    if (!booked.ok) return booked;
    return {
      ok: true,
      eventId: booked.eventId,
      start: booked.start,
      end: booked.end,
      label: booked.label,
      inviteSent: booked.inviteSent,
      attendeeEmail: booked.attendeeEmail,
      confirmation: booked.inviteSent
        ? `Booked ${booked.label}. Calendar invite emailed to ${booked.attendeeEmail}.`
        : `Booked ${booked.label}. No invite emailed (no attendee email).`,
    };
  }

  return { ok: false, error: `Unknown tool: ${name}` };
}

export async function runAgentTurn(
  playbook: AgentPlaybook,
  history: ChatCompletionMessageParam[],
  userMessage: string,
  contextBlock: string,
  options: AgentTurnOptions = {},
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
  const tools = toolsFor(playbook);

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${systemPromptFor(playbook)}\n\n---\nCRM CONTEXT:\n${contextBlock}`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  const allToolCalls: AgentTurnResult["toolCalls"] = [];
  let reply = "";

  for (let round = 0; round < 4; round++) {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 700,
    });

    const msg = completion.choices[0]?.message;
    if (!msg) break;

    const roundTools = collectToolCalls(msg);
    reply = msg.content?.trim() || reply;

    if (!msg.tool_calls?.length) {
      break;
    }

    allToolCalls.push(...roundTools);
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
    });

    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      const args = JSON.parse(tc.function.arguments || "{}") as Record<
        string,
        unknown
      >;
      let result: unknown;
      try {
        result = await executeOneTool(tc.function.name, args, options);
      } catch (error) {
        console.error("Tool execution failed:", tc.function.name, error);
        result = {
          ok: false,
          error: error instanceof Error ? error.message : "Tool failed",
        };
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  if (!reply) {
    // One more pass forcing a chat reply after tools.
    try {
      const final = await client.chat.completions.create({
        model,
        messages: [
          ...messages,
          {
            role: "user",
            content:
              "[Internal] Reply to the lead now in 1-3 short plain-text sentences (no markdown, no links) using any tool results. Do not invent calendar times. If slots were returned, offer their labels clearly. If a booking succeeded, confirm the label and whether the invite was emailed.",
          },
        ],
        max_tokens: 400,
      });
      reply = final.choices[0]?.message?.content?.trim() || reply;
    } catch (error) {
      console.error("Agent follow-up completion failed:", error);
    }
  }

  if (!reply) {
    reply =
      playbook === "scheduler"
        ? "Happy to help get a consult on the calendar. Do mornings or afternoons work better?"
        : "Happy to help. What are you looking to do: buy, sell, or invest?";
  }

  return { reply: stripChatMarkdown(reply), toolCalls: allToolCalls };
}
