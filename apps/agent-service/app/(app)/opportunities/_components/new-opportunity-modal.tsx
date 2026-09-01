"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOpportunityAction } from "@/lib/crm/crm-actions";
import {
  DEFAULT_OPPORTUNITY_TYPE,
  OPPORTUNITY_LEAD_SOURCE_OPTIONS,
  OPPORTUNITY_PRIORITY_COLORS,
  OPPORTUNITY_PRIORITY_OPTIONS,
  OPPORTUNITY_TYPE_OPTIONS,
  type OpportunityType,
} from "@/lib/opportunities/opportunity-fields";
import {
  defaultStageForPipeline,
  isOpportunityPipeline,
  OPPORTUNITY_PIPELINES,
  stagesForPipeline,
  type OpportunityPipeline,
  type OpportunityStage,
} from "@/lib/opportunities/opportunity-stages";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { DateInput } from "@/components/shell/date-input";
import { IconPlus } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

interface SelectOption {
  id: string;
  label: string;
}

interface NewOpportunityModalProps {
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
  defaultContactId?: string;
  /** When true, contact is fixed to defaultContactId and cannot be changed. */
  lockContact?: boolean;
  trigger?: "pill" | "link" | "cta" | "footer" | "secondary";
  linkLabel?: string;
  disabled?: boolean;
}

export function NewOpportunityModal({
  contactOptions,
  agentOptions,
  defaultContactId = "",
  lockContact = false,
  trigger = "pill",
  linkLabel = "Add the first one",
  disabled = false,
}: NewOpportunityModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [contactId, setContactId] = useState(defaultContactId);
  const [opportunityType, setOpportunityType] =
    useState<OpportunityType>(DEFAULT_OPPORTUNITY_TYPE);
  const [pipeline, setPipeline] = useState<OpportunityPipeline | "">("");
  const [stage, setStage] = useState<OpportunityStage | "">("");
  const [amount, setAmount] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [assignedAgentId, setAssignedAgentId] = useState("none");
  const [leadSource, setLeadSource] = useState("none");
  const [priority, setPriority] = useState("none");
  const panelRef = useRef<HTMLDivElement>(null);

  const resolvedDefaultContactId = lockContact
    ? defaultContactId || contactOptions[0]?.id || ""
    : defaultContactId;
  const stageOptions = pipeline ? stagesForPipeline(pipeline) : [];

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  useEffect(() => {
    if (open) {
      setError(null);
      if (resolvedDefaultContactId) {
        setContactId(resolvedDefaultContactId);
      }
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open, resolvedDefaultContactId]);

  function resetForm() {
    setName("");
    setContactId(resolvedDefaultContactId);
    setOpportunityType(DEFAULT_OPPORTUNITY_TYPE);
    setPipeline("");
    setStage("");
    setAmount("");
    setExpectedCloseDate("");
    setAssignedAgentId("none");
    setLeadSource("none");
    setPriority("none");
    setError(null);
  }

  function handlePipelineChange(value: string) {
    if (!isOpportunityPipeline(value)) {
      setPipeline("");
      setStage("");
      return;
    }
    setPipeline(value);
    setStage(defaultStageForPipeline(value));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!contactId) {
      setError("Client is required.");
      return;
    }
    if (!pipeline) {
      setError("Pipeline is required.");
      return;
    }
    if (!stage) {
      setError("Stage is required.");
      return;
    }

    const formData = new FormData(e.currentTarget);
    formData.set("contactId", contactId);
    formData.set("opportunityType", opportunityType);
    formData.set("pipeline", pipeline);
    formData.set("stage", stage);
    formData.set(
      "assignedAgentId",
      assignedAgentId === "none" ? "" : assignedAgentId,
    );
    formData.set("leadSource", leadSource === "none" ? "" : leadSource);
    formData.set("priority", priority === "none" ? "" : priority);

    startTransition(async () => {
      const result = await createOpportunityAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not create opportunity.");
        return;
      }
      resetForm();
      setOpen(false);
      router.refresh();
    });
  }

  const contactSelectOptions = lockContact
    ? contactOptions.map((contact) => ({
        value: contact.id,
        label: contact.label,
      }))
    : [
        { value: "", label: "Select a client" },
        ...contactOptions.map((contact) => ({
          value: contact.id,
          label: contact.label,
        })),
      ];

  const agentSelectOptions = [
    { value: "none", label: "Unassigned" },
    ...agentOptions.map((agent) => ({
      value: agent.id,
      label: agent.label,
    })),
  ];

  const leadSourceSelectOptions = [
    { value: "none", label: "None" },
    ...OPPORTUNITY_LEAD_SOURCE_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
    })),
  ];

  const prioritySelectOptions = [
    { value: "none", label: "None" },
    ...OPPORTUNITY_PRIORITY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
      leading: (
        <span
          className={styles.optionColorDot}
          style={{ backgroundColor: OPPORTUNITY_PRIORITY_COLORS[option.value] }}
          aria-hidden
        />
      ),
    })),
  ];

  return (
    <>
      {trigger === "pill" || trigger === "cta" || trigger === "secondary" ? (
        <button
          type="button"
          className={`${trigger === "secondary" ? styles.btnSecondary : styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          {trigger === "pill" ? (
            <>
              <IconPlus />
              New Opportunity
            </>
          ) : trigger === "secondary" ? (
            <>
              <IconPlus />
              {linkLabel === "Add the first one" ? "Add" : linkLabel}
            </>
          ) : (
            linkLabel === "Add the first one" ? "Add an Opportunity" : linkLabel
          )}
        </button>
      ) : (
        <button
          type="button"
          className={trigger === "footer" ? styles.tableFooterLink : styles.modalLinkTrigger}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          {linkLabel}
        </button>
      )}

      {open && (
        <div className={styles.modalOverlay} onClick={() => !pending && setOpen(false)}>
          <div
            ref={panelRef}
            className={`${styles.modalPanel} ${styles.modalPanelWide}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-opportunity-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="new-opportunity-title" className={styles.modalTitle}>
                  New Opportunity
                </h2>
                <p className={styles.modalSubtitle}>
                  Capture the deal details to start tracking.
                </p>
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Close"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                ×
              </button>
            </div>

            <form className={styles.modalForm} onSubmit={handleSubmit}>
              <div className={`${styles.modalBody} ${styles.modalBodyScroll}`}>
                {error && <p className={styles.error}>{error}</p>}

                <p className={styles.modalSectionLabel}>Required</p>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-opp-name">
                    Opportunity name
                  </label>
                  <input
                    id="new-opp-name"
                    name="name"
                    className={styles.input}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="123 Main St showing"
                    required
                    disabled={pending}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-opp-contact">
                    Client
                  </label>
                  <DropdownSelect
                    id="new-opp-contact"
                    value={contactId}
                    ariaLabel="Client"
                    disabled={pending || lockContact || contactOptions.length === 0}
                    onChange={setContactId}
                    options={contactSelectOptions}
                  />
                  {!lockContact && contactOptions.length === 0 ? (
                    <p className={styles.fieldHint}>
                      Add a lead or client first, then create an opportunity.
                    </p>
                  ) : null}
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-opp-type">
                    Opportunity type
                  </label>
                  <DropdownSelect
                    id="new-opp-type"
                    value={opportunityType}
                    ariaLabel="Opportunity type"
                    disabled={pending}
                    onChange={(value) => setOpportunityType(value as OpportunityType)}
                    options={OPPORTUNITY_TYPE_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-opp-pipeline">
                    Pipeline
                  </label>
                  <DropdownSelect
                    id="new-opp-pipeline"
                    value={pipeline}
                    ariaLabel="Pipeline"
                    disabled={pending}
                    onChange={handlePipelineChange}
                    options={[
                      { value: "", label: "Select a pipeline" },
                      ...OPPORTUNITY_PIPELINES.map((option) => ({
                        value: option.value,
                        label: option.label,
                      })),
                    ]}
                  />
                </div>

                {pipeline ? (
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-opp-stage">
                      Stage
                    </label>
                    <DropdownSelect
                      id="new-opp-stage"
                      value={stage}
                      ariaLabel="Stage"
                      disabled={pending}
                      onChange={(value) => setStage(value as OpportunityStage)}
                      options={stageOptions.map((option) => ({
                        value: option.value,
                        label: option.label,
                      }))}
                    />
                  </div>
                ) : null}

                <p className={styles.modalSectionLabel}>Optional</p>

                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-opp-amount">
                      Estimated value
                    </label>
                    <input
                      id="new-opp-amount"
                      name="amount"
                      className={styles.input}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                      disabled={pending}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-opp-close">
                      Expected close date
                    </label>
                    <DateInput
                      id="new-opp-close"
                      name="expectedCloseDate"
                      value={expectedCloseDate}
                      onChange={(e) => setExpectedCloseDate(e.target.value)}
                      disabled={pending}
                    />
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-opp-agent">
                    Assigned agent
                  </label>
                  <DropdownSelect
                    id="new-opp-agent"
                    value={assignedAgentId}
                    ariaLabel="Assigned agent"
                    disabled={pending}
                    onChange={setAssignedAgentId}
                    options={agentSelectOptions}
                  />
                </div>

                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-opp-source">
                      Lead source
                    </label>
                    <DropdownSelect
                      id="new-opp-source"
                      value={leadSource}
                      ariaLabel="Lead source"
                      disabled={pending}
                      onChange={setLeadSource}
                      options={leadSourceSelectOptions}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-opp-priority">
                      Priority
                    </label>
                    <DropdownSelect
                      id="new-opp-priority"
                      value={priority}
                      ariaLabel="Priority"
                      disabled={pending}
                      onChange={setPriority}
                      options={prioritySelectOptions}
                    />
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-opp-notes">
                    Notes
                  </label>
                  <textarea
                    id="new-opp-notes"
                    name="notes"
                    className={styles.input}
                    rows={3}
                    disabled={pending}
                    placeholder="Optional context"
                  />
                </div>
              </div>

              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={styles.btnPrimary}
                  disabled={pending || contactOptions.length === 0}
                >
                  {pending ? "Adding…" : "Add Opportunity"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
