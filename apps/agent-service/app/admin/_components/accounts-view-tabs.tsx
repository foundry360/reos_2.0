import Link from "next/link";
import {
  buildAccountsListQuery,
  type AccountsListParams,
} from "@/lib/admin/accounts-list-params";
import styles from "@/components/shell/shell.module.css";

interface AccountsViewTabsProps {
  params: AccountsListParams;
}

const TABS = [
  { id: "active" as const, label: "Active" },
  { id: "onboarding" as const, label: "Onboarding" },
];

export function AccountsViewTabs({ params }: AccountsViewTabsProps) {
  return (
    <div className={styles.accountsViewTabs} role="tablist" aria-label="Account views">
      {TABS.map((tab) => {
        const active = params.view === tab.id;
        const href = `/admin${buildAccountsListQuery({
          ...params,
          view: tab.id,
          status: "all",
          page: 1,
        })}`;

        return (
          <Link
            key={tab.id}
            href={href}
            role="tab"
            aria-selected={active}
            className={`${styles.accountsViewTab} ${active ? styles.accountsViewTabActive : ""}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
