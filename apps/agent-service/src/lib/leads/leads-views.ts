import type { PersonKind } from "@/lib/crm/person-kind";

export type LeadViewId =
  | "all"
  | "new"
  | "working"
  | "contacted"
  | "qualified"
  | "converted"
  | "recently_modified"
  | "hot"
  | "never_contacted"
  | "opted_out";

export interface LeadView {
  id: LeadViewId;
  label: string;
}

const LEAD_VIEW_LABELS: Record<LeadViewId, string> = {
  all: "All leads",
  new: "New",
  working: "Working",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  recently_modified: "Recently modified",
  hot: "Hot leads",
  never_contacted: "Never contacted",
  opted_out: "Opted out",
};

const CONTACT_VIEW_LABELS: Record<LeadViewId, string> = {
  all: "All contacts",
  new: "Prospect",
  working: "Customer",
  contacted: "Inactive Customer",
  qualified: "Partner",
  converted: "Vendor",
  recently_modified: "Recently modified",
  hot: "Hot contacts",
  never_contacted: "Never contacted",
  opted_out: "Opted out",
};

export const LEAD_VIEWS: LeadView[] = (
  Object.keys(LEAD_VIEW_LABELS) as LeadViewId[]
).map((id) => ({ id, label: LEAD_VIEW_LABELS[id] }));

export function personViews(kind: PersonKind): LeadView[] {
  const labels = kind === "contact" ? CONTACT_VIEW_LABELS : LEAD_VIEW_LABELS;
  return (Object.keys(labels) as LeadViewId[]).map((id) => ({
    id,
    label: labels[id],
  }));
}

export function isLeadViewId(value: string): value is LeadViewId {
  return value in LEAD_VIEW_LABELS;
}

export function leadViewLabel(view: LeadViewId, kind: PersonKind = "lead"): string {
  const labels = kind === "contact" ? CONTACT_VIEW_LABELS : LEAD_VIEW_LABELS;
  return labels[view] ?? labels.all;
}

export function buildPersonViewHref(
  kind: PersonKind,
  view: LeadViewId,
  extras?: { layout?: "list" | "kanban"; q?: string },
): string {
  const base = kind === "contact" ? "/contacts" : "/leads";
  const qs = new URLSearchParams();
  if (view !== "all") qs.set("view", view);
  if (extras?.layout === "kanban") qs.set("layout", "kanban");
  if (extras?.q) qs.set("q", extras.q);
  const str = qs.toString();
  return str ? `${base}?${str}` : base;
}

export function buildLeadsViewHref(view: LeadViewId): string {
  return buildPersonViewHref("lead", view);
}
