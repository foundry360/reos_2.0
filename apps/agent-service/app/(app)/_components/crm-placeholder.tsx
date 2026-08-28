import type { ReactNode } from "react";
import { PageHeading, type PageHeadingTone } from "@/components/shell/page-heading";
import styles from "@/components/shell/shell.module.css";

interface CrmPlaceholderProps {
  title: string;
  subtitle?: string;
  emptyMessage: string;
  icon: ReactNode;
  tone?: PageHeadingTone;
}

export function CrmPlaceholder({
  title,
  subtitle,
  emptyMessage,
  icon,
  tone = "brand",
}: CrmPlaceholderProps) {
  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading icon={icon} title={title} subtitle={subtitle} tone={tone} />
      </div>
      <div className={styles.card}>
        <p className={styles.empty}>{emptyMessage}</p>
      </div>
    </>
  );
}
