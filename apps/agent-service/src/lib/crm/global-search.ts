import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { personBasePath } from "@/lib/crm/person-kind";

export type GlobalSearchResultType =
  | "page"
  | "lead"
  | "contact"
  | "opportunity"
  | "task";

export interface GlobalSearchResult {
  type: GlobalSearchResultType;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

const PAGE_SHORTCUTS: { id: string; title: string; subtitle: string; href: string; keywords: string[] }[] =
  [
    { id: "overview", title: "Overview", subtitle: "Workspace home", href: "/", keywords: ["overview", "home", "dashboard"] },
    { id: "leads", title: "Leads", subtitle: "All leads", href: "/leads", keywords: ["leads", "lead"] },
    { id: "contacts", title: "Clients", subtitle: "All clients", href: "/contacts", keywords: ["clients", "client", "contacts", "contact", "people"] },
    { id: "opportunities", title: "Opportunities", subtitle: "Pipeline", href: "/opportunities", keywords: ["opportunities", "opportunity", "pipeline", "deals"] },
    { id: "tasks", title: "Tasks", subtitle: "To-dos", href: "/tasks", keywords: ["tasks", "task", "todo"] },
    { id: "calendar", title: "Calendar", subtitle: "Schedule", href: "/calendar", keywords: ["calendar", "schedule", "events"] },
    { id: "reports", title: "Reports", subtitle: "Reporting", href: "/reports", keywords: ["reports", "reporting", "analytics"] },
    { id: "settings", title: "Settings", subtitle: "Account & appearance", href: "/settings", keywords: ["settings", "profile", "theme", "account"] },
  ];

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

export async function searchTenantGlobal(query: string): Promise<GlobalSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) return [];

  const q = trimmed.toLowerCase();
  const pattern = `%${escapeIlike(trimmed)}%`;
  const results: GlobalSearchResult[] = [];

  for (const page of PAGE_SHORTCUTS) {
    if (
      page.keywords.some((keyword) => keyword.includes(q) || q.includes(keyword)) ||
      page.title.toLowerCase().includes(q)
    ) {
      results.push({
        type: "page",
        id: page.id,
        title: page.title,
        subtitle: page.subtitle,
        href: page.href,
      });
    }
  }

  const supabase = await createClient();

  const [peopleRes, oppsRes, tasksRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, first_name, last_name, email, record_type, lead_status")
      .eq("tenant_id", tenantId)
      .or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`)
      .order("updated_at", { ascending: false })
      .limit(8),
    supabase
      .from("opportunities")
      .select("id, name, stage")
      .eq("tenant_id", tenantId)
      .ilike("name", pattern)
      .order("updated_at", { ascending: false })
      .limit(6),
    supabase
      .from("tasks")
      .select("id, title, status")
      .eq("tenant_id", tenantId)
      .ilike("title", pattern)
      .order("updated_at", { ascending: false })
      .limit(6),
  ]);

  for (const person of peopleRes.data ?? []) {
    const kind = person.record_type === "contact" ? "contact" : "lead";
    const name = [person.first_name?.trim(), person.last_name?.trim()].filter(Boolean).join(" ");
    const email = typeof person.email === "string" ? person.email.trim() : "";
    results.push({
      type: kind,
      id: person.id,
      title: name || email || `Untitled ${kind}`,
      subtitle: email
        ? email
        : person.lead_status
          ? String(person.lead_status).replaceAll("_", " ")
          : kind === "contact"
            ? "Client"
            : "Lead",
      href: `${personBasePath(kind)}/${person.id}`,
    });
  }

  for (const opp of oppsRes.data ?? []) {
    results.push({
      type: "opportunity",
      id: opp.id,
      title: opp.name,
      subtitle: opp.stage ? String(opp.stage).replaceAll("_", " ") : "Opportunity",
      href: `/opportunities/${opp.id}`,
    });
  }

  for (const task of tasksRes.data ?? []) {
    results.push({
      type: "task",
      id: task.id,
      title: task.title,
      subtitle: task.status === "done" ? "Done" : "Open",
      href: "/tasks",
    });
  }

  return results.slice(0, 20);
}
