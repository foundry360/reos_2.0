import type { ReactNode } from "react";
import styles from "@/components/shell/shell.module.css";

interface DashCardHeaderProps {
  title: string;
  icon: ReactNode;
  iconBadgeClassName: string;
  action?: ReactNode;
}

export function DashCardHeader({
  title,
  icon,
  iconBadgeClassName,
  action,
}: DashCardHeaderProps) {
  return (
    <div className={styles.sidebarCardHeader}>
      <div className={styles.sidebarCardHeaderMain}>
        <span className={`${styles.accordionIconBadge} ${iconBadgeClassName}`}>
          {icon}
        </span>
        <h2 className={styles.sidebarCardTitle}>{title}</h2>
      </div>
      {action}
    </div>
  );
}
