"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  buildPersonViewHref,
  isLeadViewId,
  personViews,
} from "@/lib/leads/leads-views";
import {
  personPluralTitle,
  type PersonKind,
} from "@/lib/crm/person-kind";
import styles from "@/components/shell/shell.module.css";

interface PeopleSubnavProps {
  kind?: PersonKind;
}

export function PeopleSubnav({ kind = "lead" }: PeopleSubnavProps) {
  const searchParams = useSearchParams();
  const viewRaw = searchParams.get("view") ?? "all";
  const activeView = isLeadViewId(viewRaw) ? viewRaw : "all";
  const layout = searchParams.get("layout") === "kanban" ? "kanban" : "list";
  const q = searchParams.get("q") ?? "";
  const views = personViews(kind);
  const title = personPluralTitle(kind);

  return (
    <nav className={styles.subnavPanel} aria-label={`${title} views`}>
      <p className={styles.subnavLabel}>{title}</p>
      <ul className={styles.subnavList}>
        {views.map((view) => {
          const active = view.id === activeView;
          return (
            <li key={view.id}>
              <Link
                href={buildPersonViewHref(kind, view.id, {
                  layout,
                  q: q || undefined,
                })}
                className={`${styles.subnavLink} ${active ? styles.subnavLinkActive : ""}`}
              >
                {view.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function LeadsSubnav() {
  return <PeopleSubnav kind="lead" />;
}
