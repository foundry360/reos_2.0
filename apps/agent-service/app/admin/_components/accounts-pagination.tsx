"use client";

import { useRouter } from "next/navigation";
import {
  buildAccountsListQuery,
  PAGE_SIZES,
  type AccountsListParams,
} from "@/lib/admin/accounts-list-params";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import styles from "@/components/shell/shell.module.css";

interface AccountsPaginationProps {
  params: AccountsListParams;
  total: number;
}

export function AccountsPagination({ params, total }: AccountsPaginationProps) {
  const router = useRouter();
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  const safePage = Math.min(params.page, totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * params.perPage + 1;
  const to = Math.min(safePage * params.perPage, total);

  function navigate(next: Partial<AccountsListParams>) {
    router.push(`/admin${buildAccountsListQuery({ ...params, ...next })}`);
  }

  return (
    <div className={styles.tableFooter}>
      <div className={styles.tableFooterMeta}>
        {total === 0 ? (
          "No accounts"
        ) : (
          <>
            <span>
              <strong>
                {from} to {to}
              </strong>{" "}
              items of {total}
            </span>
            <label className={styles.tableFooterPerPage} htmlFor="accounts-per-page">
              <span>Rows</span>
              <DropdownSelect
                id="accounts-per-page"
                value={String(params.perPage)}
                variant="compact"
                ariaLabel="Rows per page"
                onChange={(nextValue) =>
                  navigate({
                    perPage: Number(nextValue) as AccountsListParams["perPage"],
                    page: 1,
                  })
                }
                options={PAGE_SIZES.map((size) => ({
                  value: String(size),
                  label: String(size),
                }))}
              />
            </label>
          </>
        )}
      </div>

      <div className={styles.tableFooterNav}>
        <button
          type="button"
          className={styles.tableFooterLink}
          disabled={safePage <= 1}
          onClick={() => navigate({ page: safePage - 1 })}
        >
          &lt; Previous
        </button>
        <button
          type="button"
          className={styles.tableFooterLink}
          disabled={safePage >= totalPages}
          onClick={() => navigate({ page: safePage + 1 })}
        >
          Next &gt;
        </button>
      </div>
    </div>
  );
}
