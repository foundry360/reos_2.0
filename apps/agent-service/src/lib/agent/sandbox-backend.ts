import { formatSlotLabel, type BusyInterval } from "@/lib/calendar/consult-slots";
import type { Schedule } from "@/lib/calendar/calendar-core";
import type { ContactContext } from "@/lib/coordinator";
import type { PostContext } from "@/lib/meta/post-context";
import type {
  AgentBackend,
  RecordedTurn,
  StoredMessage,
  ToolCall,
  UpcomingAppointment,
} from "@/lib/agent/backend";

export interface SandboxBooking {
  start: string;
  end: string;
  label: string;
  title: string | null;
  attendeeEmail: string | null;
}

const FIELD_MAP: Record<string, keyof ContactContext> = {
  email: "email",
  first_name: "firstName",
  last_name: "lastName",
  lead_status: "leadStatus",
  lead_temperature: "leadTemperature",
  intent: "intent",
  ai_summary: "aiSummary",
  agent_brief: "agentBrief",
  recommended_next_action: "recommendedNextAction",
  qualification_score: "qualificationScore",
  target_location: "targetLocation",
  property_type: "propertyType",
  budget: "budget",
  timeline: "timeline",
  financing_status: "financingStatus",
  must_haves: "mustHaves",
  motivation: "motivation",
  preferences: "preferences",
  ready_to_book: "readyToBook",
  appt_booked: "apptBooked",
  handoff: "handoff",
  opted_out: "optedOut",
};

/** In-memory calendar + CRM for agent evals. Never touches the database. */
export class SandboxBackend implements AgentBackend {
  readonly bookings: SandboxBooking[] = [];
  readonly messages: Array<StoredMessage & { direction: "inbound" | "outbound"; playbook?: string }> = [];
  readonly turns: Array<RecordedTurn & { createdAt: string }> = [];
  phoneOnFile: boolean;
  private readonly busyTimes: BusyInterval[];
  private readonly upcoming: UpcomingAppointment[];
  private clock: Date;
  private tick = 0;

  constructor(
    readonly contact: ContactContext,
    private readonly options: {
      now: Date;
      schedule: Schedule;
      busy?: BusyInterval[];
      upcoming?: UpcomingAppointment[];
      phoneOnFile?: boolean;
      property?: PostContext | null;
    },
  ) {
    this.busyTimes = [...(options.busy ?? [])];
    this.upcoming = [...(options.upcoming ?? [])];
    this.phoneOnFile = options.phoneOnFile ?? false;
    this.clock = options.now;
    for (const appt of this.upcoming) {
      this.busyTimes.push({ start: Date.parse(appt.start), end: Date.parse(appt.end) });
    }
  }

  /** Per-turn activity, reset by startTurn(). */
  turnStats = { calendarReads: 0, bookAttempts: 0, bookingsMade: 0 };

  /** Each turn in a scenario happens a minute after the previous one. */
  startTurn(minutes = 1): void {
    this.clock = new Date(this.clock.getTime() + minutes * 60_000);
    this.turnStats = { calendarReads: 0, bookAttempts: 0, bookingsMade: 0 };
  }

  seedMessage(role: "user" | "assistant", content: string): void {
    this.messages.push({
      role,
      direction: role === "user" ? "inbound" : "outbound",
      content,
      createdAt: this.stamp(),
    });
  }

  private stamp(): string {
    this.tick += 1;
    return new Date(this.clock.getTime() + this.tick).toISOString();
  }

  now(): Date {
    return this.clock;
  }

  async schedule(): Promise<Schedule> {
    return this.options.schedule;
  }

  async busy(): Promise<BusyInterval[]> {
    this.turnStats.calendarReads += 1;
    return [...this.busyTimes];
  }

  async book(params: Parameters<AgentBackend["book"]>[0]) {
    this.turnStats.bookAttempts += 1;
    const start = params.start.getTime();
    const end = params.end.getTime();
    if (this.busyTimes.some((b) => start < b.end && end > b.start)) {
      return { ok: false as const, error: "That time is no longer available." };
    }
    this.turnStats.bookingsMade += 1;
    this.busyTimes.push({ start, end });
    const label = formatSlotLabel(params.start.toISOString(), this.options.schedule.timeZone);
    const booking = {
      start: params.start.toISOString(),
      end: params.end.toISOString(),
      label,
      title: params.title,
      attendeeEmail: params.attendeeEmail,
    };
    this.bookings.push(booking);
    this.upcoming.push({ start: booking.start, end: booking.end, title: booking.title });
    this.contact.apptBooked = true;
    this.contact.readyToBook = false;
    this.contact.leadStatus = "Converted";
    if (params.attendeeEmail && !this.contact.email) this.contact.email = params.attendeeEmail;
    return {
      ok: true as const,
      appointmentId: `sandbox-${this.bookings.length}`,
      contactId: params.contactId ?? this.contact.contactId ?? "sandbox-contact",
      start: booking.start,
      end: booking.end,
      label,
      inviteSent: Boolean(params.attendeeEmail),
      attendeeEmail: params.attendeeEmail,
      confirmation: params.attendeeEmail
        ? `Booked ${label} on the REOS calendar. A calendar invite was emailed to the lead.`
        : `Booked ${label} on the REOS calendar.`,
    };
  }

  private applyFields(fields: Record<string, unknown>): void {
    const target = this.contact as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      const mapped = FIELD_MAP[key];
      if (mapped && value !== undefined) target[mapped] = value;
    }
  }

  async applyToolCalls(contactId: string | undefined, toolCalls: ToolCall[]) {
    for (const call of toolCalls) {
      if (call.name === "book_appointment") {
        const email = typeof call.args.attendee_email === "string" ? call.args.attendee_email.trim() : "";
        if (email.includes("@")) this.contact.email = email.toLowerCase();
        continue;
      }
      if (call.name !== "update_contact") continue;
      const args = { ...call.args };
      if (typeof args.email === "string") args.email = args.email.trim().toLowerCase();
      if (typeof args.phone === "string" && args.phone.trim()) this.phoneOnFile = true;
      this.applyFields(args);
      if (args.appt_booked === true || args.lead_status === "Converted") {
        this.contact.readyToBook = false;
        this.contact.leadStatus = "Converted";
      }
    }
    return contactId;
  }

  async loadMessages(): Promise<StoredMessage[]> {
    return this.messages.map(({ role, content, createdAt }) => ({ role, content, createdAt }));
  }

  async appendMessage(params: Parameters<AgentBackend["appendMessage"]>[0]) {
    this.messages.push({
      role: params.direction === "inbound" ? "user" : "assistant",
      direction: params.direction,
      content: params.contextLabel ? `[${params.contextLabel}] ${params.body}` : params.body,
      playbook: params.playbook,
      createdAt: this.stamp(),
    });
  }

  async patchContact(_contactId: string, fields: Record<string, string | number | boolean | null>) {
    this.applyFields(fields);
  }

  async reconcileContact(contactId: string, ids: { email?: string; phone?: string }) {
    if (ids.email) this.contact.email = ids.email;
    if (ids.phone) this.phoneOnFile = true;
    return contactId;
  }

  async playbookEnabled(playbook: string) {
    return playbook !== "none";
  }

  async hasSmsIdentity() {
    return this.phoneOnFile;
  }

  async propertyInterest() {
    return this.options.property ?? null;
  }

  async upcomingAppointments() {
    const now = this.clock.getTime();
    return this.upcoming
      .filter((a) => Date.parse(a.end) > now)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async recentTurns() {
    return this.turns.slice(-10);
  }

  async recordTurn(turn: RecordedTurn) {
    this.turns.push({ ...turn, createdAt: this.stamp() });
  }
}
