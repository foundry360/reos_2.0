"use client";

import { useRouter } from "next/navigation";
import {
  buildTasksListQuery,
  PAGE_SIZES,
  type TasksListParams,
} from "@/lib/crm/tasks-list-params";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import styles from "@/components/shell/shell.module.css";

interface TasksPaginationProps {
  params: TasksListParams;
  total: number;
  pageKey?: "page" | "cpage";
}

export function TasksPagination({
  params,
  total,
  pageKey = "page",
}: TasksPaginationProps) {
  const router = useRouter();
  const currentPage = pageKey === "cpage" ? params.cpage : params.page;
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  const safePage = Math.min(currentPage, totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * params.perPage + 1;
  const to = Math.min(safePage * params.perPage, total);
  const perPageId = `task-per-page-${pageKey}`;

  function navigate(next: Partial<TasksListParams>) {
    router.push(`/tasks${buildTasksListQuery({ ...params, ...next })}`);
  }

  function setPage(nextPage: number) {
    if (pageKey === "cpage") {
      navigate({ cpage: nextPage });
    } else {
      navigate({ page: nextPage });
    }
  }

  return (
    <div className={styles.tableFooter}>
      <div className={styles.tableFooterMeta}>
        {total === 0 ? (
          "No tasks"
        ) : (
          <>
            <span>
              <strong>
                {from} to {to}
              </strong>{" "}
              items of {total}
            </span>
            <label className={styles.tableFooterPerPage} htmlFor={perPageId}>
              <span>Rows</span>
              <DropdownSelect
                id={perPageId}
                value={String(params.perPage)}
                variant="compact"
                ariaLabel="Rows per page"
                onChange={(nextValue) =>
                  navigate({
                    perPage: Number(nextValue) as TasksListParams["perPage"],
                    page: 1,
                    cpage: 1,
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
          onClick={() => setPage(safePage - 1)}
        >
          &lt; Previous
        </button>
        <button
          type="button"
          className={styles.tableFooterLink}
          disabled={safePage >= totalPages || total === 0}
          onClick={() => setPage(safePage + 1)}
        >
          Next &gt;
        </button>
      </div>
    </div>
  );
}
