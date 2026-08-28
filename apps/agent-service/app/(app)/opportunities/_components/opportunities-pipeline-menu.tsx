"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DropdownOptionList } from "@/components/shell/dropdown-select";
import {
  buildOpportunitiesListQuery,
  type OpportunitiesListParams,
} from "@/lib/opportunities/opportunities-list-params";
import {
  OPPORTUNITY_PIPELINES,
  type OpportunityPipeline,
} from "@/lib/opportunities/opportunity-stages";
import styles from "@/components/shell/shell.module.css";

function IconChevron() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface OpportunitiesPipelineMenuProps {
  params: OpportunitiesListParams;
}

export function OpportunitiesPipelineMenu({ params }: OpportunitiesPipelineMenuProps) {
  const router = useRouter();
  const dialogId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  const title =
    OPPORTUNITY_PIPELINES.find((pipeline) => pipeline.value === params.pipeline)?.label ??
    params.pipeline;

  useEffect(() => {
    if (!open) return;

    function onDocClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function selectPipeline(pipeline: OpportunityPipeline) {
    setOpen(false);
    if (pipeline === params.pipeline) return;
    router.push(
      `/opportunities${buildOpportunitiesListQuery({
        ...params,
        pipeline,
        stage: "all",
        view: "all",
        page: 1,
      })}`,
    );
  }

  const options = OPPORTUNITY_PIPELINES.map((pipeline) => ({
    value: pipeline.value,
    label: pipeline.label,
  }));

  return (
    <span className={styles.pageTitleMenu} ref={rootRef}>
      <button
        type="button"
        className={styles.pageTitleMenuTrigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{title}</span>
        <span className={styles.pageTitleMenuChevron}>
          <IconChevron />
        </span>
      </button>

      {open && (
        <div
          id={dialogId}
          className={styles.pageTitleMenuDialog}
          role="dialog"
          aria-label="Pipelines"
        >
          <div className={styles.dropdownHeader}>
            <p className={styles.dropdownTitle}>Pipelines</p>
          </div>
          <div className={styles.dropdownBody}>
            <DropdownOptionList
              value={params.pipeline}
              onChange={(value) => selectPipeline(value as OpportunityPipeline)}
              options={options}
            />
          </div>
        </div>
      )}
    </span>
  );
}
