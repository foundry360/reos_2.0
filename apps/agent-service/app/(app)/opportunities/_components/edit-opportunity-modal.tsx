"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { updateOpportunityAction } from "@/lib/crm/crm-actions";
import {
  DEFAULT_OPPORTUNITY_TYPE,
  OPPORTUNITY_LEAD_SOURCE_OPTIONS,
  OPPORTUNITY_PRIORITY_COLORS,
  OPPORTUNITY_PRIORITY_OPTIONS,
  OPPORTUNITY_TYPE_OPTIONS,
  isOpportunityType,
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
import type { OpportunityRow } from "@/lib/opportunities/opportunities-types";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { DateInput } from "@/components/shell/date-input";
import styles from "@/components/shell/shell.module.css";

interface SelectOption {
  id: string;
  label: string;
}

interface EditOpportunityModalProps {
  opportunity: OpportunityRow;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
  onClose: () => void;
}

function formatAmountInput(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

export function EditOpportunityModal({
  opportunity,
  contactOptions,
  agentOptions,
  onClose,
}: EditOpportunityModalProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(opportunity.name);
  const [contactId, setContactId] = useState(opportunity.contactId ?? "");
  const [opportunityType, setOpportunityType] = useState<OpportunityType>(
    isOpportunityType(opportunity.opportunityType)
      ? opportunity.opportunityType
      : DEFAULT_OPPORTUNITY_TYPE,
  );
  const [pipeline, setPipeline] = useState<OpportunityPipeline | "">(opportunity.pipeline);
  const [stage, setStage] = useState<OpportunityStage | "">(opportunity.stage);
  const [amount, setAmount] = useState(formatAmountInput(opportunity.amountCents));
  const [expectedCloseDate, setExpectedCloseDate] = useState(
    opportunity.expectedCloseDate ?? "",
  );
  const [assignedAgentId, setAssignedAgentId] = useState(
    opportunity.assignedAgentId ?? "none",
  );
  const [leadSource, setLeadSource] = useState(opportunity.leadSource ?? "none");
  const [priority, setPriority] = useState(opportunity.priority ?? "none");
  const [notes, setNotes] = useState(opportunity.notes ?? "");

  const stageOptions = pipeline ? stagesForPipeline(pipeline) : [];

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose, pending]);

  function handlePipelineChange(value: string) {
    if (!isOpportunityPipeline(value)) {
      setPipeline("");
      setStage("");
      return;
    }
    setPipeline(value);
    const nextStages = stagesForPipeline(value);
    if (stage && nextStages.some((option) => option.value === stage)) {
      return;
    }
    setStage(defaultStageForPipeline(value));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!contactId) {
      setError("Contact is required.");
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
    formData.set("opportunityId", opportunity.id);
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
      const result = await updateOpportunityAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not update opportunity.");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  const contactSelectOptions = [
    { value: "", label: "Select a contact" },
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

  return createPortal(
    <div className={styles.modalOverlay} onClick={() => !pending && onClose()}>
      <div
        className={`${styles.modalPanel} ${styles.modalPanelWide}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-opportunity-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="edit-opportunity-title" className={styles.modalTitle}>
              Edit Opportunity
            </h2>
            <p className={styles.modalSubtitle}>Update details for this opportunity.</p>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Close"
            onClick={onClose}
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
              <label className={styles.label} htmlFor="edit-opp-name">
                Opportunity name
              </label>
              <input
                id="edit-opp-name"
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
              <label className={styles.label} htmlFor="edit-opp-contact">
                Contact
              </label>
              <DropdownSelect
                id="edit-opp-contact"
                value={contactId}
                ariaLabel="Contact"
                disabled={pending || contactOptions.length === 0}
                onChange={setContactId}
                options={contactSelectOptions}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="edit-opp-type">
                Opportunity type
              </label>
              <DropdownSelect
                id="edit-opp-type"
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
              <label className={styles.label} htmlFor="edit-opp-pipeline">
                Pipeline
              </label>
              <DropdownSelect
                id="edit-opp-pipeline"
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
                <label className={styles.label} htmlFor="edit-opp-stage">
                  Stage
                </label>
                <DropdownSelect
                  id="edit-opp-stage"
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
                <label className={styles.label} htmlFor="edit-opp-amount">
                  Estimated value
                </label>
                <input
                  id="edit-opp-amount"
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
                <label className={styles.label} htmlFor="edit-opp-close">
                  Expected close date
                </label>
                <DateInput
                  id="edit-opp-close"
                  name="expectedCloseDate"
                  value={expectedCloseDate}
                  onChange={(e) => setExpectedCloseDate(e.target.value)}
                  disabled={pending}
                />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="edit-opp-agent">
                Assigned agent
              </label>
              <DropdownSelect
                id="edit-opp-agent"
                value={assignedAgentId}
                ariaLabel="Assigned agent"
                disabled={pending}
                onChange={setAssignedAgentId}
                options={agentSelectOptions}
              />
            </div>

            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="edit-opp-source">
                  Lead source
                </label>
                <DropdownSelect
                  id="edit-opp-source"
                  value={leadSource}
                  ariaLabel="Lead source"
                  disabled={pending}
                  onChange={setLeadSource}
                  options={leadSourceSelectOptions}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="edit-opp-priority">
                  Priority
                </label>
                <DropdownSelect
                  id="edit-opp-priority"
                  value={priority}
                  ariaLabel="Priority"
                  disabled={pending}
                  onChange={setPriority}
                  options={prioritySelectOptions}
                />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="edit-opp-notes">
                Notes
              </label>
              <textarea
                id="edit-opp-notes"
                name="notes"
                className={styles.input}
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={pending}
                placeholder="Optional context"
              />
            </div>
          </div>

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={pending || contactOptions.length === 0}
            >
              {pending ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
