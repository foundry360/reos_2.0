import { createClient } from "@/lib/supabase/server";
import {
  formatActivityTypeLabel,
  type PersonActivityItem,
  type PersonTaskSummary,
} from "@/lib/crm/person-activities";

function truncate(value: string, max = 140): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export async function fetchTasksForContact(
  tenantId: string,
  contactId: string,
  options?: { limit?: number },
): Promise<PersonTaskSummary[]> {
  const limit = options?.limit ?? 50;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, due_at, notes, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .order("status", { ascending: false })
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("contact tasks failed:", error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status === "done" ? "done" : "open",
    dueAt: row.due_at,
    notes: row.notes?.trim() || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function fetchActivitiesForContact(
  tenantId: string,
  contactId: string,
  options?: { limit?: number },
): Promise<PersonActivityItem[]> {
  const limit = options?.limit ?? 50;
  const supabase = await createClient();

  const [activitiesRes, messagesRes, tasksRes] = await Promise.all([
    supabase
      .from("contact_activities")
      .select("id, activity_type, title, body, occurred_at")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .order("occurred_at", { ascending: false })
      .limit(limit),
    supabase
      .from("messages")
      .select("id, direction, body, channel, created_at")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("tasks")
      .select("id, title, status, notes, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .order("updated_at", { ascending: false })
      .limit(limit),
  ]);

  if (activitiesRes.error) {
    const missingTable = /contact_activities|schema cache/i.test(
      activitiesRes.error.message,
    );
    if (!missingTable) {
      console.error("contact activities failed:", activitiesRes.error.message);
    }
  }
  if (messagesRes.error) {
    console.error("contact messages for activities failed:", messagesRes.error.message);
  }
  if (tasksRes.error) {
    console.error("contact tasks for activities failed:", tasksRes.error.message);
  }

  const items: PersonActivityItem[] = [];

  for (const row of activitiesRes.data ?? []) {
    items.push({
      id: `activity:${row.id}`,
      source: "activity",
      type: row.activity_type,
      typeLabel: formatActivityTypeLabel(row.activity_type),
      title: row.title,
      body: row.body?.trim() || null,
      occurredAt: row.occurred_at,
    });
  }

  for (const row of messagesRes.data ?? []) {
    const inbound = row.direction === "inbound";
    const channel = row.channel === "sms" ? "SMS" : String(row.channel ?? "Message");
    items.push({
      id: `message:${row.id}`,
      source: "message",
      type: "message",
      typeLabel: channel,
      title: inbound ? `Inbound ${channel}` : `Outbound ${channel}`,
      body: truncate(row.body ?? ""),
      occurredAt: row.created_at,
    });
  }

  for (const row of tasksRes.data ?? []) {
    const done = row.status === "done";
    items.push({
      id: `task:${row.id}`,
      source: "task",
      type: "task",
      typeLabel: "Task",
      title: done ? `Completed task: ${row.title}` : `Task created: ${row.title}`,
      body: row.notes?.trim() || null,
      occurredAt: done ? row.updated_at : row.created_at,
    });
  }

  items.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return items.slice(0, limit);
}
