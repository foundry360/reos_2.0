"use client";

import { useRouter } from "next/navigation";
import {
  buildOpportunitiesListQuery,
  PAGE_SIZES,
  type OpportunitiesListParams,
} from "@/lib/opportunities/opportunities-list-params";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import styles from "@/components/shell/shell.module.css";

interface OpportunitiesPaginationProps {
  params: OpportunitiesListParams;
  total: number;
}

export function OpportunitiesPagination({ params, total }: OpportunitiesPaginationProps) {
  const router = useRouter();
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  const safePage = Math.min(params.page, totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * params.perPage + 1;
  const to = Math.min(safePage * params.perPage, total);

  function navigate(next: Partial<OpportunitiesListParams>) {
    router.push(`/opportunities${buildOpportunitiesListQuery({ ...params, ...next })}`);
  }

  return (
    <div className={styles.tableFooter}>
      <div className={styles.tableFooterMeta}>
        {total === 0 ? (
          "No opportunities"
        ) : (
          <>
            <span>
              <strong>
                {from} to {to}
              </strong>{" "}
              items of {total}
            </span>
            <label className={styles.tableFooterPerPage} htmlFor="opportunity-per-page">
              <span>Rows</span>
              <DropdownSelect
                id="opportunity-per-page"
                value={String(params.perPage)}
                variant="compact"
                ariaLabel="Rows per page"
                onChange={(nextValue) =>
                  navigate({
                    perPage: Number(nextValue) as OpportunitiesListParams["perPage"],
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
