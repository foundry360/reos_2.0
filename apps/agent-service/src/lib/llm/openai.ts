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
  bookReosConsultSlot,
  getAvailableReosConsultSlots,
  resolveBookableStart,
  type SlotPreference,
} from "@/lib/calendar/consult-appointments";

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
        "Fetch 2-3 real open times (consults or showings) from the REOS calendar. Call as soon as the lead gives any timing; use preference any when only a day or deadline is known. Pass day when the lead names a weekday or date. Never invent times.",
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
              "Optional preferred day: weekday name (wednesday), YYYY-MM-DD, today, or tomorrow. With a day, every open time that day is returned.",
          },
          limit: {
            type: "number",
            description: "How many slots to return (1-5, default 3)",
          },
          kind: {
            type: "string",
            enum: ["consult", "showing"],
            description: "showing = private tour of a specific property (may use days off if the team allows); consult otherwise",
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
        "Book a consult or property showing on the REOS calendar for a slot previously returned by get_available_slots. On success the CRM is marked appt_booked. Never invent start times.",
      parameters: {
        type: "object",
        properties: {
          start: {
            type: "string",
            description:
              "Start of the slot the lead picked, including its date: the exact ISO start from get_available_slots, the full slot label (e.g. \"Sat, Oct 3, 2026, 11:00 AM EDT\"), or \"YYYY-MM-DD HH:MM\" in the workspace time zone. If you only have a time like \"11am\", also pass day. The server checks it against open times.",
          },
          day: {
            type: "string",
            description:
              "Day of the slot when start has no date: YYYY-MM-DD, a weekday name, or \"tomorrow\". Use the day the offered times were for.",
          },
          kind: {
            type: "string",
            enum: ["consult", "showing"],
            description: "Same kind used when fetching slots",
          },
          end: {
            type: "string",
            description: "Exact ISO end time from get_available_slots (optional)",
          },
          attendee_email: {
            type: "string",
            description: "Lead email to store on the booking when available",
          },
          title: {
            type: "string",
            description: 'Calendar title. Use "Showing - <address>" for a property showing; omit for a consult.',
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
  /** True only when a book_appointment call returned ok. */
  bookingSucceeded?: boolean;
}

export interface AgentTurnOptions {
  tenantId?: string;
  contactId?: string;
  email?: string;
  leadName?: string;
  /** Label of the first slot returned this turn; dates a bare "11am" booking. */
  lastOfferedLabel?: string;
  /** Kind used for get_available_slots this turn; default for a book_appointment that omits kind. */
  lastOfferedKind?: "consult" | "showing";
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
    const survivor = await applyToolCalls(options.contactId, [{ name, args }]);
    if (survivor) options.contactId = survivor;
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
    const slots = await getAvailableReosConsultSlots({
      tenantId: options.tenantId,
      preference,
      day,
      limit,
      allowWeekends: args.kind === "showing",
    });
    options.lastOfferedKind = args.kind === "showing" ? "showing" : "consult";
    if (slots.ok && slots.slots[0]) options.lastOfferedLabel = slots.slots[0].label;
    return slots;
  }

  if (name === "book_appointment") {
    if (!options.tenantId) {
      return { ok: false, error: "Missing tenant for calendar booking." };
    }
    const requested = typeof args.start === "string" ? args.start : "";
    const day = (typeof args.day === "string" && args.day.trim()) || options.lastOfferedLabel;
    const titleSaysShowing =
      typeof args.title === "string" && /^showing\b/i.test(args.title.trim());
    const isShowing =
      args.kind === "showing" ||
      (args.kind !== "consult" && (titleSaysShowing || options.lastOfferedKind === "showing"));
    const resolved = await resolveBookableStart({
      tenantId: options.tenantId,
      start: requested,
      day,
      allowWeekends: isShowing,
    });
    if (!resolved.ok) {
      console.warn("book_appointment rejected:", JSON.stringify({ requested, day, isShowing }), resolved.error);
      return {
        ok: false,
        error: resolved.error,
        openTimes: resolved.openTimes.map((slot) => ({ label: slot.label, start: slot.start })),
      };
    }
    console.info("book_appointment resolved:", JSON.stringify({ requested, day, isShowing, start: resolved.start.toISOString() }));
    const start = resolved.start.toISOString();
    const end = resolved.end.toISOString();
    const attendeeEmail =
      (typeof args.attendee_email === "string" && args.attendee_email) ||
      options.email ||
      null;
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const booked = await bookReosConsultSlot({
      tenantId: options.tenantId,
      contactId: options.contactId,
      start,
      end,
      attendeeEmail,
      leadName: options.leadName,
      summary: title
        ? `${title}${options.leadName && !title.includes(options.leadName) ? ` - ${options.leadName}` : ""}`
        : null,
    });
    if (!booked.ok) {
      console.error("book_appointment save failed:", booked.error);
      return /no longer available/i.test(booked.error)
        ? booked
        : {
            ok: false,
            error: `${booked.error} This is a system problem, not availability: do not say the time is taken. Apologize briefly and say you'll confirm the time with the team.`,
          };
    }
    options.contactId = booked.contactId;
    return {
      ok: true,
      appointmentId: booked.appointmentId,
      start: booked.start,
      end: booked.end,
      label: booked.label,
      inviteSent: booked.inviteSent,
      attendeeEmail: booked.attendeeEmail,
      confirmation: booked.confirmation,
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
  let bookingSucceeded = false;
  let bookedResult: Record<string, unknown> | null = null;

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
        result =
          tc.function.name === "book_appointment" && bookedResult
            ? { ...bookedResult, note: "Already booked this turn. Do not book again." }
            : await executeOneTool(tc.function.name, args, options);
      } catch (error) {
        console.error("Tool execution failed:", tc.function.name, error);
        result = {
          ok: false,
          error: error instanceof Error ? error.message : "Tool failed",
        };
      }
      if (
        tc.function.name === "book_appointment" &&
        (result as { ok?: unknown } | null)?.ok === true
      ) {
        bookingSucceeded = true;
        bookedResult ??= result as Record<string, unknown>;
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

  return { reply: stripChatMarkdown(reply), toolCalls: allToolCalls, bookingSucceeded };
}
