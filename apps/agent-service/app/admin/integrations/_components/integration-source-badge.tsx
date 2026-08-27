import type { IntegrationSource } from "@/lib/admin/platform-secrets";
import styles from "@/components/shell/shell.module.css";

export function integrationSourceLabel(source: IntegrationSource): string {
  switch (source) {
    case "database":
    case "environment":
      return "Encrypted";
    default:
      return "Not configured";
  }
}

export function IntegrationSourceBadge({ source }: { source: IntegrationSource }) {
  return <span className={styles.integrationSourceBadge}>{integrationSourceLabel(source)}</span>;
}
