"use client";

import type { AdminLayout } from "./admin-layout-toggle";
import { AdminLayoutToggle } from "./admin-layout-toggle";

interface BillingLayoutToggleProps {
  layout: AdminLayout;
  attention?: boolean;
}

function buildHref(layout: AdminLayout, attention?: boolean): string {
  const qs = new URLSearchParams();
  if (layout === "kanban") qs.set("layout", "kanban");
  if (attention) qs.set("attention", "missing");
  const str = qs.toString();
  return str ? `/admin/billing?${str}` : "/admin/billing";
}

export function BillingLayoutToggle({ layout, attention }: BillingLayoutToggleProps) {
  return (
    <AdminLayoutToggle layout={layout} buildHref={(next) => buildHref(next, attention)} />
  );
}
