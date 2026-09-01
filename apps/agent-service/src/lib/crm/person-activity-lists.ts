import { createClient } from "@/lib/supabase/server";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import {
  ACTIVITY_CATEGORY_META,
  activityEntityHref,
  classifyActivityCategory,
  formatActivityTypeLabel,
  isCrmActivityFeedItem,
  type ActivityRelatedEntityType,
  type PersonActivityItem,
  type PersonTaskSummary,
} from "@/lib/crm/person-activities";

function isRelatedEntityType(value: string | null | undefined): value is ActivityRelatedEntityType {
  return (
    value === "contact" ||
    value === "lead" ||
    value === "opportunity" ||
    value === "task"
  );
}

function opportunityNameFromTitle(title: string): string | null {
  const match = title.match(
    /^(?:Created|Updated|Unlinked|Deleted|New)\s+opportunity[:\s]+(.+)$/i,
  );
  return match?.[1]?.trim() || null;
}

/** Normalize stored titles toward the CRM event taxonomy. */
function formatStoredActivityTitle(activityType: string, title: string): string {
  const t = title.trim();
  if (/^Created opportunity:\s*/i.test(t)) {
    return t.replace(/^Created opportunity:\s*/i, "New Opportunity: ");
  }
  if (activityType === "note" && !/^Note created:/i.test(t)) {
    return `Note created: ${t}`;
  }
  return t;
}

function withCategory(
  item: Omit<PersonActivityItem, "category" | "categoryLabel" | "typeLabel"> & {
    typeLabel?: string;
  },
): PersonActivityItem {
  const category = classifyActivityCategory(item);
  const meta = ACTIVITY_CATEGORY_META[category];
  return {
    ...item,
    typeLabel: item.typeLabel ?? formatActivityTypeLabel(item.type),
    category,
    categoryLabel: meta.label,
  };
}

export async function fetchTasksForContact(
  tenantId: string,
  contactId: string,
  options?: { limit?: number },
): Promise<PersonTaskSummary[]> {
  const limit = options?.limit ?? 50;
  const supabase = await createClient();
  const selectWithTimes =
    "id, title, status, due_at, start_at, end_at, notes, created_at, updated_at";
  const selectLegacy = "id, title, status, due_at, notes, created_at, updated_at";

  let data:
    | {
        id: string;
        title: string;
        status: string | null;
        due_at: string | null;
        start_at?: string | null;
        end_at?: string | null;
        notes: string | null;
        created_at: string;
        updated_at: string;
      }[]
    | null = null;

  const withTimes = await supabase
    .from("tasks")
    .select(selectWithTimes)
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .order("status", { ascending: false })
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (withTimes.error) {
    const missingTimes = /start_at|end_at|schema cache|column/i.test(withTimes.error.message);
    if (!missingTimes) {
      console.error("contact tasks failed:", withTimes.error.message);
      return [];
    }
    const legacy = await supabase
      .from("tasks")
      .select(selectLegacy)
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .order("status", { ascending: false })
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (legacy.error) {
      console.error("contact tasks failed:", legacy.error.message);
      return [];
    }
    data = legacy.data;
  } else {
    data = withTimes.data;
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status === "done" ? "done" : "open",
    dueAt: row.due_at,
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    notes: row.notes?.trim() || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function fetchActivitiesForContact(
  tenantId: string,
  contactId: string,
  options?: { limit?: number; personKind?: PersonKind },
): Promise<PersonActivityItem[]> {
  const limit = options?.limit ?? 50;
  const personKind = options?.personKind ?? "lead";
  const personHref = `${personBasePath(personKind)}/${contactId}`;
  const supabase = await createClient();

  const activitiesSelectWithRelated =
    "id, activity_type, title, body, occurred_at, related_entity_type, related_entity_id";
  const activitiesSelectLegacy = "id, activity_type, title, body, occurred_at";

  type ActivityRow = {
    id: string;
    activity_type: string;
    title: string;
    body: string | null;
    occurred_at: string;
    related_entity_type?: string | null;
    related_entity_id?: string | null;
  };

  let activityRows: ActivityRow[] = [];
  const activitiesWithRelated = await supabase
    .from("contact_activities")
    .select(activitiesSelectWithRelated)
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (activitiesWithRelated.error) {
    const missingRelated = /related_entity|schema cache|column/i.test(
      activitiesWithRelated.error.message,
    );
    if (missingRelated) {
      const legacy = await supabase
        .from("contact_activities")
        .select(activitiesSelectLegacy)
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (legacy.error) {
        const missingTable = /contact_activities|schema cache/i.test(legacy.error.message);
        if (!missingTable) {
          console.error("contact activities failed:", legacy.error.message);
        }
      } else {
        activityRows = (legacy.data ?? []) as ActivityRow[];
      }
    } else {
      console.error("contact activities failed:", activitiesWithRelated.error.message);
    }
  } else {
    activityRows = (activitiesWithRelated.data ?? []) as ActivityRow[];
  }

  const [tasksRes, opportunitiesRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, due_at, notes, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .order("updated_at", { ascending: false })
      .limit(limit),
    supabase
      .from("opportunities")
      .select("id, name, updated_at")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .order("updated_at", { ascending: false })
      .limit(200),
  ]);

  if (tasksRes.error) {
    console.error("contact tasks for activities failed:", tasksRes.error.message);
  }
  if (opportunitiesRes.error) {
    console.error(
      "contact opportunities for activities failed:",
      opportunitiesRes.error.message,
    );
  }

  const opportunityIdByName = new Map<string, string>();
  for (const row of opportunitiesRes.data ?? []) {
    const key = row.name?.trim().toLowerCase();
    if (key && !opportunityIdByName.has(key)) {
      opportunityIdByName.set(key, row.id);
    }
  }

  const items: PersonActivityItem[] = [];

  for (const row of activityRows) {
    // Tasks are merged from the tasks table below — skip duplicate task logs.
    if (/^(Task created|Completed task):/i.test(row.title)) {
      continue;
    }
    // Notes/body on a task stay on the task — never list as standalone notes/activities.
    if (row.related_entity_type === "task") {
      continue;
    }

    let relatedType: ActivityRelatedEntityType | PersonKind = isRelatedEntityType(
      row.related_entity_type,
    )
      ? row.related_entity_type
      : row.activity_type === "opportunity" || row.activity_type === "appointment"
        ? "opportunity"
        : row.activity_type === "contact"
          ? personKind
          : personKind;

    let relatedId =
      typeof row.related_entity_id === "string" && row.related_entity_id
        ? row.related_entity_id
        : null;

    if (
      !relatedId &&
      (relatedType === "opportunity" ||
        row.activity_type === "opportunity" ||
        row.activity_type === "appointment")
    ) {
      const parsedName = opportunityNameFromTitle(row.title);
      if (parsedName) {
        relatedId = opportunityIdByName.get(parsedName.toLowerCase()) ?? null;
        relatedType = "opportunity";
      }
    }

    if (!relatedId && relatedType !== "opportunity" && relatedType !== "task") {
      relatedId = contactId;
      relatedType = personKind;
    }

    const item = withCategory({
      id: `activity:${row.id}`,
      source: "activity",
      type: row.activity_type,
      title: formatStoredActivityTitle(row.activity_type, row.title),
      body: row.body?.trim() || null,
      occurredAt: row.occurred_at,
      href: activityEntityHref(relatedType, relatedId) ?? personHref,
    });
    if (isCrmActivityFeedItem(item)) items.push(item);
  }

  // Chat messages are intentionally excluded from Recent activities / Activities.

  for (const row of tasksRes.data ?? []) {
    const done = row.status === "done";
    const dueAt = typeof row.due_at === "string" && row.due_at ? row.due_at : null;
    const overdue =
      !done && dueAt ? new Date(dueAt).getTime() < Date.now() : false;
    items.push(
      withCategory({
        id: `task:${row.id}`,
        source: "task",
        type: "task",
        title: done
          ? `Task completed: ${row.title}`
          : overdue
            ? `Task overdue: ${row.title}`
            : `Task created: ${row.title}`,
        body: null,
        occurredAt: done ? row.updated_at : dueAt ?? row.created_at,
        href: "/tasks",
        timeKind: !done && dueAt ? "due" : undefined,
      }),
    );
  }

  items.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return items.slice(0, limit);
}

export async function fetchTasksForOpportunity(
  tenantId: string,
  opportunityId: string,
  options?: { limit?: number },
): Promise<PersonTaskSummary[]> {
  const limit = options?.limit ?? 50;
  const supabase = await createClient();
  const selectWithTimes =
    "id, title, status, due_at, start_at, end_at, notes, created_at, updated_at";
  const selectLegacy = "id, title, status, due_at, notes, created_at, updated_at";

  let data:
    | {
        id: string;
        title: string;
        status: string | null;
        due_at: string | null;
        start_at?: string | null;
        end_at?: string | null;
        notes: string | null;
        created_at: string;
        updated_at: string;
      }[]
    | null = null;

  const withTimes = await supabase
    .from("tasks")
    .select(selectWithTimes)
    .eq("tenant_id", tenantId)
    .eq("opportunity_id", opportunityId)
    .order("status", { ascending: false })
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (withTimes.error) {
    const missingTimes = /start_at|end_at|schema cache|column/i.test(withTimes.error.message);
    if (!missingTimes) {
      console.error("opportunity tasks failed:", withTimes.error.message);
      return [];
    }
    const legacy = await supabase
      .from("tasks")
      .select(selectLegacy)
      .eq("tenant_id", tenantId)
      .eq("opportunity_id", opportunityId)
      .order("status", { ascending: false })
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (legacy.error) {
      console.error("opportunity tasks failed:", legacy.error.message);
      return [];
    }
    data = legacy.data;
  } else {
    data = withTimes.data;
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status === "done" ? "done" : "open",
    dueAt: row.due_at,
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    notes: row.notes?.trim() || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function fetchActivitiesForOpportunity(
  tenantId: string,
  opportunityId: string,
  options?: {
    limit?: number;
    contactId?: string | null;
    opportunityName?: string | null;
  },
): Promise<PersonActivityItem[]> {
  const limit = options?.limit ?? 50;
  const contactId = options?.contactId ?? null;
  const opportunityName = options?.opportunityName?.trim() ?? null;
  const opportunityHref = `/opportunities/${opportunityId}`;
  const supabase = await createClient();

  type ActivityRow = {
    id: string;
    activity_type: string;
    title: string;
    body: string | null;
    occurred_at: string;
    related_entity_type?: string | null;
    related_entity_id?: string | null;
  };

  let activityRows: ActivityRow[] = [];
  const activitiesSelectWithRelated =
    "id, activity_type, title, body, occurred_at, related_entity_type, related_entity_id";
  const activitiesSelectLegacy = "id, activity_type, title, body, occurred_at";
  let relatedColumnsAvailable = true;

  const byRelated = await supabase
    .from("contact_activities")
    .select(activitiesSelectWithRelated)
    .eq("tenant_id", tenantId)
    .eq("related_entity_type", "opportunity")
    .eq("related_entity_id", opportunityId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (byRelated.error) {
    const missingRelated = /related_entity|schema cache|column/i.test(byRelated.error.message);
    if (missingRelated) {
      relatedColumnsAvailable = false;
    } else {
      console.error("opportunity activities failed:", byRelated.error.message);
    }
  } else {
    activityRows = (byRelated.data ?? []) as ActivityRow[];
  }

  if (contactId && opportunityName && activityRows.length < limit) {
    const byContact = relatedColumnsAvailable
      ? await supabase
          .from("contact_activities")
          .select(activitiesSelectWithRelated)
          .eq("tenant_id", tenantId)
          .eq("contact_id", contactId)
          .eq("activity_type", "opportunity")
          .ilike("title", `%${opportunityName}%`)
          .order("occurred_at", { ascending: false })
          .limit(limit)
      : await supabase
          .from("contact_activities")
          .select(activitiesSelectLegacy)
          .eq("tenant_id", tenantId)
          .eq("contact_id", contactId)
          .eq("activity_type", "opportunity")
          .ilike("title", `%${opportunityName}%`)
          .order("occurred_at", { ascending: false })
          .limit(limit);

    if (!byContact.error && byContact.data) {
      const seen = new Set(activityRows.map((row) => row.id));
      for (const row of byContact.data as unknown as ActivityRow[]) {
        if (seen.has(row.id)) continue;
        activityRows.push(row);
        seen.add(row.id);
      }
    } else if (
      byContact.error &&
      !/related_entity|schema cache|column/i.test(byContact.error.message)
    ) {
      console.error("opportunity activities by contact failed:", byContact.error.message);
    }
  }

  const tasksRes = await supabase
    .from("tasks")
    .select("id, title, status, due_at, notes, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .eq("opportunity_id", opportunityId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (tasksRes.error) {
    console.error("opportunity tasks for activities failed:", tasksRes.error.message);
  }

  const items: PersonActivityItem[] = [];

  for (const row of activityRows) {
    // Tasks are merged from the tasks table below — skip duplicate task logs.
    if (/^(Task created|Completed task|Task completed|Task overdue):/i.test(row.title)) {
      continue;
    }
    // Notes/body on a task stay on the task — never list as standalone notes/activities.
    if (row.related_entity_type === "task") {
      continue;
    }

    const item = withCategory({
      id: `activity:${row.id}`,
      source: "activity",
      type: row.activity_type,
      title: formatStoredActivityTitle(row.activity_type, row.title),
      body: row.body?.trim() || null,
      occurredAt: row.occurred_at,
      href: opportunityHref,
    });
    if (isCrmActivityFeedItem(item)) items.push(item);
  }

  for (const row of tasksRes.data ?? []) {
    const done = row.status === "done";
    const dueAt = typeof row.due_at === "string" && row.due_at ? row.due_at : null;
    const overdue =
      !done && dueAt ? new Date(dueAt).getTime() < Date.now() : false;
    items.push(
      withCategory({
        id: `task:${row.id}`,
        source: "task",
        type: "task",
        title: done
          ? `Task completed: ${row.title}`
          : overdue
            ? `Task overdue: ${row.title}`
            : `Task created: ${row.title}`,
        body: null,
        occurredAt: done ? row.updated_at : dueAt ?? row.created_at,
        href: "/tasks",
        timeKind: !done && dueAt ? "due" : undefined,
      }),
    );
  }

  items.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return items.slice(0, limit);
}
