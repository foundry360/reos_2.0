import { CrmPlaceholder } from "../_components/crm-placeholder";
import { IconCalendar } from "@/components/shell/sidebar-nav";

export default function CalendarPage() {
  return (
    <CrmPlaceholder
      icon={<IconCalendar />}
      title="Calendar"
      emptyMessage="No events yet. Connected calendars and booked appointments will appear here."
      tone="accent"
    />
  );
}
