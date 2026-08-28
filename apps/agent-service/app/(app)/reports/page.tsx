import { CrmPlaceholder } from "../_components/crm-placeholder";
import { IconReports } from "@/components/shell/sidebar-nav";

export default function ReportsPage() {
  return (
    <CrmPlaceholder
      icon={<IconReports />}
      title="Reports"
      emptyMessage="Reports coming soon."
      tone="light"
    />
  );
}
