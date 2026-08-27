import Link from "next/link";
import {
  AccountStatusBadge,
  tenantStatusFunnelFillClass,
  tenantStatusFunnelLabelClass,
  type TenantStatus,
} from "@/lib/admin/account-status";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { fetchDashboardStats } from "@/lib/admin/dashboard-stats";
import { getCurrentProfile } from "@/lib/profile/server";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/shell/shell.module.css";

function firstName(displayName: string, email: string): string {
  const base = displayName.trim() || email.split("@")[0] || "there";
  return base.split(/\s+/)[0] ?? base;
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function FunnelBars({
  items,
}: {
  items: { status: TenantStatus; label: string; count: number; href: string }[];
}) {
  const max = Math.max(1, ...items.map((item) => item.count));

  return (
    <div className={styles.dashFunnel}>
      {items.map((item) => (
        <Link key={item.status} href={item.href} className={styles.dashFunnelRow}>
          <span
            className={`${styles.dashFunnelLabel} ${tenantStatusFunnelLabelClass(item.status)}`}
          >
            {item.label}
          </span>
          <span className={styles.dashFunnelTrack}>
            <span
              className={`${styles.dashFunnelFill} ${tenantStatusFunnelFillClass(item.status)}`}
              style={{
                width: `${item.count === 0 ? 0 : Math.max(10, (item.count / max) * 100)}%`,
              }}
            />
          </span>
          <span className={styles.dashFunnelCount}>{item.count}</span>
        </Link>
      ))}
    </div>
  );
}

export default async function AdminDashboardPage() {
  const admin = await requirePlatformAdmin();
  const [profile, stats] = await Promise.all([
    getCurrentProfile(admin.id, admin.email),
    fetchDashboardStats(),
  ]);

  const name = firstName(profile.displayName, admin.email);
  const onboardingStages = stats.statusCounts.filter(
    (entry) => entry.status !== "active" && entry.status !== "paused",
  );

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Platform console</h1>
        </div>
        <div className={styles.pageHeaderActions}>
          <Link href="/admin" className={styles.btnSecondary}>
            View accounts
          </Link>
          <Link href="/admin/accounts/new" className={styles.btnPrimary}>
            + New account
          </Link>
        </div>
      </div>

      <div className={styles.dashGrid}>
        <section className={`${styles.dashCard} ${styles.dashHero}`}>
          <div className={styles.dashHeroCopy}>
            <h2 className={styles.dashHeroTitle}>Welcome back, {name}</h2>
            <p className={styles.dashHeroBody}>
              {stats.onboardingCount > 0
                ? `${stats.onboardingCount} account${stats.onboardingCount === 1 ? "" : "s"} still in onboarding. Keep tenants moving toward Active.`
                : stats.totalAccounts === 0
                  ? "Create your first tenant account to start onboarding."
                  : "All tenants are live or paused. Monitor health and support from here."}
            </p>
            <div className={styles.dashHeroActions}>
              <Link href="/admin?view=onboarding&status=testing" className={styles.btnPrimary}>
                Review testing
              </Link>
              <Link href="/admin?view=onboarding" className={styles.btnSecondary}>
                Open onboarding
              </Link>
            </div>
          </div>
          <div className={styles.dashHeroArt}>
            <div className={styles.dashHeroOrbInner}>
              <span>Live</span>
              <strong>{stats.activeCount}</strong>
              <small>active tenants</small>
            </div>
          </div>
        </section>

        <section className={`${styles.dashCard} ${styles.dashStatCard}`}>
          <div className={styles.dashStatTop}>
            <span className={`${styles.dashStatIcon} ${styles.dashStatIconBlue}`}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M3 21V5a2 2 0 012-2h6v18H5a2 2 0 01-2-2zM13 21V9h6a2 2 0 012 2v10h-8z"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className={styles.dashStatDeltaPositive}>
              +{stats.createdLast7Days} this week
            </span>
          </div>
          <p className={styles.dashStatLabel}>Total accounts</p>
          <p className={styles.dashStatValue}>{stats.totalAccounts}</p>
          <p className={styles.dashStatHint}>{stats.createdLast30Days} created in last 30 days</p>
        </section>

        <section className={`${styles.dashCard} ${styles.dashStatCard}`}>
          <div className={styles.dashStatTop}>
            <span className={`${styles.dashStatIcon} ${styles.dashStatIconBlue}`}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M20 6L9 17l-5-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className={styles.dashStatDeltaPositive}>{stats.activePercent}% of fleet</span>
          </div>
          <p className={styles.dashStatLabel}>Active</p>
          <p className={styles.dashStatValue}>{stats.activeCount}</p>
          <p className={styles.dashStatHint}>{stats.pausedCount} paused</p>
        </section>
      </div>

      <div className={styles.dashGridSecondary}>
        <section className={styles.dashCard}>
          <div className={styles.dashCardHeader}>
            <div>
              <h2 className={styles.dashCardTitle}>Onboarding funnel</h2>
              <p className={styles.dashCardSubtitle}>Accounts by setup stage</p>
            </div>
            <Link href="/admin?view=onboarding" className={styles.dashCardLink}>
              View all
            </Link>
          </div>
          <FunnelBars
            items={onboardingStages.map((entry) => ({
              status: entry.status,
              label: entry.label,
              count: entry.count,
              href: `/admin?view=onboarding`,
            }))}
          />
        </section>

        <section className={`${styles.dashCard} ${styles.dashGaugeCard}`}>
          <div className={styles.dashCardHeader}>
            <div>
              <h2 className={styles.dashCardTitle}>Fleet health</h2>
              <p className={styles.dashCardSubtitle}>Share of tenants that are Active</p>
            </div>
          </div>
          <div className={styles.dashGaugeWrap}>
            <div
              className={styles.dashGauge}
              style={{ ["--dash-gauge" as string]: String(stats.activePercent) }}
            >
              <div className={styles.dashGaugeInner}>
                <strong>{stats.activePercent}%</strong>
                <span>Active</span>
              </div>
            </div>
          </div>
          <div className={styles.dashGaugeLegend}>
            <span className={styles.dashLegendDotActive} aria-hidden="true" />
            <span className={styles.dashGaugeLegendLabel}>Active</span>
            <strong className={styles.dashGaugeLegendValue}>{stats.activeCount}</strong>
            <span className={styles.dashLegendDotOnboarding} aria-hidden="true" />
            <span className={styles.dashGaugeLegendLabel}>Onboarding</span>
            <strong className={styles.dashGaugeLegendValue}>{stats.onboardingCount}</strong>
            <span className={styles.dashLegendDotPaused} aria-hidden="true" />
            <span className={styles.dashGaugeLegendLabel}>Paused</span>
            <strong className={styles.dashGaugeLegendValue}>{stats.pausedCount}</strong>
          </div>
        </section>

        <section className={styles.dashCard}>
          <div className={styles.dashCardHeader}>
            <div>
              <h2 className={styles.dashCardTitle}>Ops signals</h2>
              <p className={styles.dashCardSubtitle}>Config gaps across the fleet</p>
            </div>
          </div>
          <div className={styles.dashSignalList}>
            <Link href="/admin?view=onboarding&status=testing" className={styles.dashSignalItem}>
              <span className={`${styles.dashSignalIcon} ${styles.dashSignalIconAmber}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 3l9 16H3L12 3zM12 10v4M12 17h.01"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className={styles.dashSignalCopy}>
                <strong>Ready to activate</strong>
                <small>In Testing stage</small>
              </span>
              <span className={styles.dashSignalValue}>{stats.readyToActivateCount}</span>
            </Link>
            <div className={styles.dashSignalItem}>
              <span className={`${styles.dashSignalIcon} ${styles.dashSignalIconCyan}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span className={styles.dashSignalCopy}>
                <strong>Missing phone</strong>
                <small>No primary Twilio number</small>
              </span>
              <span className={styles.dashSignalValue}>{stats.missingPhoneCount}</span>
            </div>
            <Link href="/admin/billing?attention=missing" className={styles.dashSignalItem}>
              <span className={`${styles.dashSignalIcon} ${styles.dashSignalIconViolet}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect
                    x="3"
                    y="6"
                    width="18"
                    height="12"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.75"
                  />
                  <path d="M3 10h18" stroke="currentColor" strokeWidth="1.75" />
                </svg>
              </span>
              <span className={styles.dashSignalCopy}>
                <strong>Missing billing</strong>
                <small>Billing not configured</small>
              </span>
              <span className={styles.dashSignalValue}>{stats.missingBillingCount}</span>
            </Link>
          </div>
        </section>
      </div>

      <div className={styles.dashGridTertiary}>
        <section className={styles.dashCard}>
          <div className={styles.dashCardHeader}>
            <div>
              <h2 className={styles.dashCardTitle}>Needs attention</h2>
              <p className={styles.dashCardSubtitle}>
                Stuck onboarding, ready to activate, or missing phone
              </p>
            </div>
          </div>
          {stats.attentionItems.length === 0 ? (
            <p className={styles.empty}>No accounts need attention right now.</p>
          ) : (
            <ul className={styles.dashAttentionList}>
              {stats.attentionItems.map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className={styles.dashAttentionItem}>
                    <span className={styles.dashAttentionMain}>
                      <strong>{item.name}</strong>
                      <small>{item.reason}</small>
                    </span>
                    <AccountStatusBadge status={item.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.dashCard}>
          <div className={styles.dashCardHeader}>
            <div>
              <h2 className={styles.dashCardTitle}>Recent accounts</h2>
              <p className={styles.dashCardSubtitle}>Newest tenants on the platform</p>
            </div>
            <Link href="/admin" className={styles.dashCardLink}>
              Accounts
            </Link>
          </div>
          {stats.recentAccounts.length === 0 ? (
            <p className={styles.empty}>No accounts yet.</p>
          ) : (
            <ul className={styles.dashRecentList}>
              {stats.recentAccounts.map((account) => (
                <li key={account.id}>
                  <Link href={account.href} className={styles.dashRecentItem}>
                    <span className={styles.avatar}>
                      {accountInitials(account.name)}
                    </span>
                    <span className={styles.dashRecentCopy}>
                      <strong>{account.name}</strong>
                      <small>{account.slug}</small>
                    </span>
                    <span className={styles.dashRecentMeta}>
                      <AccountStatusBadge status={account.status} />
                      <time dateTime={account.createdAt}>
                        {formatShortDate(account.createdAt)}
                      </time>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
