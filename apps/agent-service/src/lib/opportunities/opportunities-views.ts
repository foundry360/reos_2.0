import type { OpportunityViewId } from "@/lib/opportunities/opportunities-list-params";
import {
  buildOpportunitiesListQuery,
  type OpportunitiesListParams,
} from "@/lib/opportunities/opportunities-list-params";
import { DEFAULT_OPPORTUNITY_PIPELINE } from "@/lib/opportunities/opportunity-stages";

export interface OpportunityView {
  id: OpportunityViewId;
  label: string;
}

const OPPORTUNITY_VIEW_LABELS: Record<OpportunityViewId, string> = {
  all: "All opportunities",
  new: "New",
  ai_qualifying: "AI Qualifying",
  qualified: "Qualified",
  appointment_set: "Appointment Set",
  nurture: "Nurture",
  closed_won: "Closed Won",
  recently_modified: "Recently modified",
};

export const OPPORTUNITY_VIEWS: OpportunityView[] = (
  Object.keys(OPPORTUNITY_VIEW_LABELS) as OpportunityViewId[]
).map((id) => ({ id, label: OPPORTUNITY_VIEW_LABELS[id] }));

export function opportunityViewLabel(view: OpportunityViewId): string {
  return OPPORTUNITY_VIEW_LABELS[view] ?? OPPORTUNITY_VIEW_LABELS.all;
}

export function buildOpportunityViewHref(
  view: OpportunityViewId,
  extras?: {
    layout?: "list" | "kanban";
    q?: string;
    pipeline?: OpportunitiesListParams["pipeline"];
  },
): string {
  const params: OpportunitiesListParams = {
    q: extras?.q ?? "",
    stage: "all",
    view,
    pipeline: extras?.pipeline ?? DEFAULT_OPPORTUNITY_PIPELINE,
    layout: extras?.layout ?? "kanban",
    sort: "updated_at",
    dir: "desc",
    page: 1,
    perPage: 25,
  };
  return `/opportunities${buildOpportunitiesListQuery(params)}`;
}
