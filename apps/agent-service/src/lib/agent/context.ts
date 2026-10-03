import { formatSlotLabel, zonedParts } from "@/lib/calendar/consult-slots";
import type { Schedule } from "@/lib/calendar/calendar-core";
import { describeWorkingHours } from "@/lib/calendar/working-hours";
import { hasCoreIntake, type ContactContext } from "@/lib/coordinator";
import { describePostForAgent, type PostContext } from "@/lib/meta/post-context";
import type { RecordedTurn, UpcomingAppointment } from "@/lib/agent/backend";
import { localStart } from "@/lib/agent/lead-tools";

export interface OfferedTimes {
  kind: string;
  slots: Array<{ label: string; start: string }>;
  at: string;
}

export interface HeldTime {
  label: string;
  start: string;
  kind: string;
  missing: string[];
}

type Slot = { label?: unknown; start?: unknown };

function asSlots(value: unknown): Array<{ label: string; start: string }> {
  if (!Array.isArray(value)) return [];
  return (value as Slot[]).flatMap((s) =>
    typeof s?.label === "string" && typeof s?.start === "string" ? [{ label: s.label, start: s.start }] : [],
  );
}

/** Most recent times the agent showed the lead, and any time held while waiting for contact info. */
export function readConversationState(turns: Array<RecordedTurn & { createdAt: string }>): {
  offered: OfferedTimes | null;
  held: HeldTime | null;
} {
  let offered: OfferedTimes | null = null;
  let held: HeldTime | null = null;
  for (const turn of turns) {
    for (const event of turn.toolEvents) {
      const result = (event.result ?? {}) as Record<string, unknown>;
      const kind = typeof event.args.kind === "string" ? event.args.kind : "consult";
      if (event.name === "find_open_times" && result.ok === true) {
        const slots = asSlots(result.slots);
        if (slots.length > 0) offered = { kind, slots, at: turn.createdAt };
      }
      if (event.name === "book_appointment") {
        if (result.ok === true) {
          held = null;
        } else if (Array.isArray(result.needsContactInfo) && typeof result.start === "string") {
          held = {
            label: String(result.requestedLabel ?? result.start),
            start: result.start,
            kind,
            missing: result.needsContactInfo.map(String),
          };
        } else {
          const openTimes = asSlots(result.openTimes);
          if (openTimes.length > 0) offered = { kind, slots: openTimes, at: turn.createdAt };
        }
      }
    }
  }
  return { offered, held };
}

function stageOf(
  ctx: ContactContext,
  upcoming: UpcomingAppointment[],
  offered: OfferedTimes | null,
  held: HeldTime | null,
): string {
  if (ctx.optedOut) return "Opted out. Do not message.";
  if (upcoming.length > 0) return "Booked. Help with questions, prep, or rescheduling; don't push another booking.";
  if (held) return "Booking. A time is held until we get their contact info.";
  if (offered || ctx.readyToBook) return "Booking. Times are being discussed.";
  if (hasCoreIntake(ctx)) return "Qualified. Offer a consult (or a showing if they want to see a home).";
  return "Getting to know them. Learn what they want; offer to meet when it fits.";
}

function nextDays(now: Date, timeZone: string): string {
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    const date = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const p = zonedParts(date, timeZone);
    const iso = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
    out.push(`${name} = ${iso}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`);
  }
  return out.join("; ");
}

export function buildLeadContext(input: {
  ctx: ContactContext;
  channel: string;
  schedule: Schedule;
  now: Date;
  phoneOnFile: boolean;
  upcoming: UpcomingAppointment[];
  offered: OfferedTimes | null;
  held: HeldTime | null;
  property: PostContext | null;
  firstReply?: boolean;
  note?: string;
}): string {
  const { ctx, schedule, now, upcoming, offered, held } = input;
  const { timeZone, workingHours } = schedule;
  const local = (start: string) => (/T\d/.test(start) ? localStart(start, timeZone) : start);
  const nowLabel = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);

  const crm = [
    ctx.intent ? `intent ${ctx.intent}` : null,
    ctx.targetLocation ? `area ${ctx.targetLocation}` : null,
    ctx.propertyType ? `type ${ctx.propertyType}` : null,
    ctx.budget ? `budget ${ctx.budget}` : null,
    ctx.timeline ? `timeline ${ctx.timeline}` : null,
    ctx.financingStatus ? `financing ${ctx.financingStatus}` : null,
    ctx.mustHaves ? `must-haves ${ctx.mustHaves}` : null,
    ctx.motivation ? `motivation ${ctx.motivation}` : null,
    ctx.preferences ? `preferences ${ctx.preferences}` : null,
  ].filter(Boolean);

  const lines = [
    `NOW: ${nowLabel} (${timeZone})`,
    `DATES: ${nextDays(now, timeZone)}`,
    `TEAM HOURS: ${describeWorkingHours(workingHours)}.${workingHours.showingsOnDaysOff ? " Showings can also be booked on days off." : ""}`,
    `CHANNEL: ${input.channel}`,
    input.firstReply ? "CONVERSATION: First reply to this lead. Follow OPENING." : null,
    "",
    `LEAD: ${[ctx.firstName, ctx.lastName].filter(Boolean).join(" ") || "(name unknown)"}`,
    `Email: ${ctx.email?.trim() || "unknown"}`,
    `Mobile: ${input.phoneOnFile ? "on file" : "unknown"}`,
    `Stage: ${stageOf(ctx, upcoming, offered, held)}`,
    `CRM: ${crm.length > 0 ? crm.join("; ") : "nothing yet"}`,
    ctx.leadTemperature ? `Temperature: ${ctx.leadTemperature}` : null,
    ctx.aiSummary ? `Summary: ${ctx.aiSummary}` : null,
    ctx.handoff ? "A team member was asked to step in earlier." : null,
    "",
    upcoming.length > 0
      ? `UPCOMING APPOINTMENTS:\n${upcoming
          .map((a) => `- ${formatSlotLabel(a.start, timeZone)}${a.title ? ` · ${a.title}` : ""} (start ${local(a.start)})`)
          .join("\n")}`
      : "UPCOMING APPOINTMENTS: none",
    held
      ? `HELD TIME (open, not booked yet; waiting for their ${held.missing.join(" and ")}): ${held.label} (kind ${held.kind}, start ${local(held.start)})`
      : null,
    offered
      ? `LAST TIMES YOU OFFERED (${offered.kind}):\n${offered.slots.map((s, i) => `${i + 1}. ${s.label} (start ${local(s.start)})`).join("\n")}`
      : null,
    input.property
      ? describePostForAgent(input.property).replace("POST THEY COMMENTED ON", "PROPERTY OF INTEREST")
      : null,
    input.note ?? null,
  ];
  return lines.filter((l) => l !== null).join("\n");
}
