import { applyToolCalls } from "@/lib/apply-tools";
import {
  bookReosConsultSlot,
  loadContactUpcomingAppointments,
  loadReosBusyIntervals,
  loadTenantSchedule,
  rescheduleReosAppointment,
} from "@/lib/calendar/consult-appointments";
import { lookaheadEnd } from "@/lib/calendar/calendar-core";
import { normalizeWorkingHours } from "@/lib/calendar/working-hours";
import { DEFAULT_TIME_ZONE } from "@/lib/calendar/consult-slots";
import { appendToThread, getThread } from "@/lib/conversation-store";
import { appendMessage, getRecentMessages, updateContactFields } from "@/lib/db/contacts";
import { reconcileContactByEmailOrPhone } from "@/lib/db/contact-merge";
import { isSupabaseConfigured } from "@/lib/env";
import { dispatchJourneyEventsSoon } from "@/lib/journeys/journey-event-dispatch";
import { getContactPropertyInterest } from "@/lib/meta/post-context";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { AgentBackend, RecordedTurn, ToolEvent } from "@/lib/agent/backend";

const DEFAULT_TENANT = "default-tenant";

export function liveBackend(tenantId: string): AgentBackend {
  const persisted = (contactId?: string): contactId is string =>
    Boolean(contactId) && isSupabaseConfigured() && tenantId !== DEFAULT_TENANT;

  return {
    now: () => new Date(),
    schedule: async () =>
      tenantId === DEFAULT_TENANT
        ? { timeZone: DEFAULT_TIME_ZONE, workingHours: normalizeWorkingHours(null) }
        : loadTenantSchedule(tenantId),
    busy: () => {
      const now = new Date();
      return loadReosBusyIntervals(tenantId, now, lookaheadEnd(now));
    },
    book: async (params) => {
      const result = await bookReosConsultSlot({
        tenantId,
        contactId: params.contactId,
        start: params.start.toISOString(),
        end: params.end.toISOString(),
        attendeeEmail: params.attendeeEmail,
        leadName: params.leadName,
        summary: params.title,
      });
      if (result.ok) dispatchJourneyEventsSoon(tenantId, result.contactId);
      return result;
    },
    reschedule: async (params) => {
      const result = await rescheduleReosAppointment({
        tenantId,
        appointmentId: params.appointmentId,
        start: params.start.toISOString(),
        end: params.end.toISOString(),
        attendeeEmail: params.attendeeEmail,
        leadName: params.leadName,
      });
      if (result.ok) dispatchJourneyEventsSoon(tenantId, result.contactId);
      return result;
    },
    applyToolCalls: async (contactId, toolCalls) => {
      const survivor = (await applyToolCalls(contactId, toolCalls)) ?? contactId;
      // Handoff and opportunity stage changes made by the turn are already recorded; deliver them now.
      if (persisted(survivor)) dispatchJourneyEventsSoon(tenantId, survivor);
      return survivor;
    },

    loadMessages: async ({ threadKey, contactId }) => {
      if (isSupabaseConfigured() && contactId) {
        const rows = await getRecentMessages(contactId);
        if (rows.length > 0) return rows;
      }
      return getThread(tenantId, threadKey).map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: typeof m.content === "string" ? m.content : "",
      }));
    },
    appendMessage: async ({ threadKey, contactId, channel, direction, body, playbook, contextLabel }) => {
      if (persisted(contactId)) {
        const inbound = direction === "inbound";
        const messageId = await appendMessage({
          tenantId,
          contactId,
          channel,
          direction,
          body,
          playbook,
          contextLabel,
          emitReceived: inbound,
          sendStatus: inbound ? undefined : "pending",
        });
        if (inbound && messageId) dispatchJourneyEventsSoon(tenantId, contactId);
        return messageId;
      }
      appendToThread(tenantId, threadKey, {
        role: direction === "inbound" ? "user" : "assistant",
        content: body,
      });
      return null;
    },
    patchContact: async (contactId, fields) => {
      await updateContactFields(contactId, fields);
    },
    reconcileContact: (contactId, ids) => reconcileContactByEmailOrPhone(contactId, ids),
    playbookEnabled: async (playbook) => {
      if (playbook === "none") return false;
      const db = getSupabaseAdmin();
      if (!db || tenantId === DEFAULT_TENANT) return true;
      const { data } = await db
        .from("tenant_agents")
        .select("concierge_enabled, scheduler_enabled, follow_up_enabled")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (!data) return true;
      if (playbook === "concierge") return data.concierge_enabled !== false;
      if (playbook === "scheduler") return data.scheduler_enabled !== false;
      if (playbook === "follow_up") return data.follow_up_enabled !== false;
      return true;
    },
    hasSmsIdentity: async (contactId) => {
      const db = getSupabaseAdmin();
      if (!db) return false;
      const { data } = await db
        .from("contact_identities")
        .select("id")
        .eq("contact_id", contactId)
        .eq("channel", "sms")
        .maybeSingle();
      return Boolean(data?.id);
    },
    propertyInterest: (contactId) => getContactPropertyInterest(contactId),
    upcomingAppointments: async (contactId) =>
      persisted(contactId) ? loadContactUpcomingAppointments(tenantId, contactId, new Date()) : [],
    recentTurns: async (contactId) => {
      const db = getSupabaseAdmin();
      if (!db || !persisted(contactId)) return [];
      const { data, error } = await db
        .from("agent_turns")
        .select("contact_id, model, reply, tool_events, created_at")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) {
        if (!/agent_turns|schema cache|does not exist/i.test(error.message)) {
          console.warn("agent_turns lookup failed:", error.message);
        }
        return [];
      }
      return (data ?? []).reverse().map((row) => ({
        contactId: row.contact_id ?? undefined,
        model: row.model ?? "",
        reply: row.reply ?? "",
        toolEvents: (row.tool_events ?? []) as ToolEvent[],
        createdAt: row.created_at,
      }));
    },
    recordTurn: async (turn: RecordedTurn) => {
      const db = getSupabaseAdmin();
      if (!db || !persisted(turn.contactId)) return;
      const { error } = await db.from("agent_turns").insert({
        tenant_id: tenantId,
        contact_id: turn.contactId,
        model: turn.model,
        reply: turn.reply,
        tool_events: turn.toolEvents,
      });
      if (error) console.warn("agent_turns insert failed:", error.message);
    },
  };
}
