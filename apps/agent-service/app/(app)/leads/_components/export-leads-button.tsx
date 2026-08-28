import Link from "next/link";
import { buildLeadsListQuery, type LeadsListParams } from "@/lib/leads/leads-list-params";
import { personPlural, type PersonKind } from "@/lib/crm/person-kind";
import styles from "@/components/shell/shell.module.css";

function IconExport() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3v12M8 11l4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 19h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface ExportLeadsButtonProps {
  params: LeadsListParams;
  kind?: PersonKind;
}

export function ExportLeadsButton({ params, kind = "lead" }: ExportLeadsButtonProps) {
  const plural = personPlural(kind);
  return (
    <Link
      href={`/api/${plural}/export${buildLeadsListQuery(params)}`}
      className={`${styles.btnSecondary} ${styles.btnPill}`}
      prefetch={false}
    >
      <IconExport />
      Export
    </Link>
  );
}
