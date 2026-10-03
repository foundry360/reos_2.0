import type { BusyInterval } from "@/lib/calendar/consult-slots";
import type { Schedule } from "@/lib/calendar/calendar-core";
import type { PostContext } from "@/lib/meta/post-context";

export type BookResult =
  | {
      ok: true;
      appointmentId: string;
      contactId: string;
      start: string;
      end: string;
      label: string;
      inviteSent: boolean;
      attendeeEmail: string | null;
      confirmation: string;
    }
  | { ok: false; error: string };

export type ToolCall = { name: string; args: Record<string, unknown> };

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

export interface UpcomingAppointment {
  start: string;
  end: string;
  title: string | null;
}

/** One model tool call and what the tool returned, kept so later turns can see it. */
export interface ToolEvent {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface RecordedTurn {
  contactId?: string;
  model: string;
  reply: string;
  toolEvents: ToolEvent[];
}

/** Everything an agent turn reads or writes outside the model. Live = Supabase; eval = in-memory. */
export interface AgentBackend {
  now(): Date;
  schedule(): Promise<Schedule>;
  busy(): Promise<BusyInterval[]>;
  book(params: {
    contactId?: string;
    start: Date;
    end: Date;
    title: string | null;
    attendeeEmail: string | null;
    leadName: string | null;
  }): Promise<BookResult>;
  /** Persist update_contact / book_appointment side fields; returns the surviving contact id after merges. */
  applyToolCalls(contactId: string | undefined, toolCalls: ToolCall[]): Promise<string | undefined>;

  loadMessages(params: { threadKey: string; contactId?: string }): Promise<StoredMessage[]>;
  appendMessage(params: {
    threadKey: string;
    contactId?: string;
    channel: string;
    direction: "inbound" | "outbound";
    body: string;
    playbook?: string;
    contextLabel?: string | null;
  }): Promise<void>;
  patchContact(contactId: string, fields: Record<string, string | number | boolean | null>): Promise<void>;
  reconcileContact(contactId: string, ids: { email?: string; phone?: string }): Promise<string>;
  playbookEnabled(playbook: string): Promise<boolean>;
  hasSmsIdentity(contactId: string): Promise<boolean>;
  propertyInterest(contactId: string | undefined): Promise<PostContext | null>;
  upcomingAppointments(contactId: string | undefined): Promise<UpcomingAppointment[]>;
  /** Tool calls + results from recent turns, oldest first. */
  recentTurns(contactId: string | undefined): Promise<Array<RecordedTurn & { createdAt: string }>>;
  recordTurn(turn: RecordedTurn): Promise<void>;
}
