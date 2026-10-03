import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconSocialPlanner } from "@/components/shell/sidebar-nav";
import shell from "@/components/shell/shell.module.css";

const SUBTITLE = "Plan, schedule and publish posts to your connected Facebook and Instagram accounts.";

export default function SocialPlannerPage() {
  return (
    <>
      <div className={shell.pageHeader}>
        <PageHeading
          icon={<IconSocialPlanner />}
          title="Social Planner"
          subtitle={SUBTITLE}
          tone="light"
        />
      </div>
      <EmptyState
        title="Social Planner is coming soon"
        description="You'll be able to draft posts, schedule them on a calendar and publish to Facebook and Instagram from one place."
      />
    </>
  );
}
