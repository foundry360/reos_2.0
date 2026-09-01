"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { updateOpportunityAction } from "@/lib/crm/crm-actions";
import {
  DEFAULT_OPPORTUNITY_TYPE,
  OPPORTUNITY_PRIORITY_COLORS,
  OPPORTUNITY_PRIORITY_OPTIONS,
  isOpportunityPriority,
  isOpportunityType,
  type OpportunityPriority,
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
import { displayValue } from "@/lib/display-value";
import {
  EditFormActions,
  IconEdit,
  InlineEditMessages,
} from "@/components/shell/inline-edit";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { DateInput } from "@/components/shell/date-input";
import styles from "@/components/shell/shell.module.css";

interface SelectOption {
  id: string;
  label: string;
}

function formatUsd(cents: number | null): string {
  if (cents == null) return displayValue(null);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatShortDate(value: string | null): string {
  if (!value) return displayValue(null);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function formatAmountInput(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

function contactHref(opportunity: OpportunityRow): string | null {
  if (!opportunity.contactId) return null;
  if (opportunity.contactRecordType === "contact") {
    return `/contacts/${opportunity.contactId}`;
  }
  return `/leads/${opportunity.contactId}`;
}

function PriorityValue({ priority }: { priority: OpportunityPriority | null }) {
  if (!priority) return <>{displayValue(null)}</>;
  return (
    <span className={styles.priorityInline}>
      <span
        className={styles.optionColorDot}
        style={{ backgroundColor: OPPORTUNITY_PRIORITY_COLORS[priority] }}
        aria-hidden
      />
      {priority}
    </span>
  );
}

function AccordionChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`${styles.accordionChevron} ${open ? styles.accordionChevronOpen : ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
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

function PropertyRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.personPropertyRow}>
      <span className={styles.personPropertyLabel}>{label}</span>
      {children ? (
        <span className={styles.personPropertyValue}>{children}</span>
      ) : (
        <span className={styles.personPropertyValue}>{value}</span>
      )}
    </div>
  );
}

interface OpportunityDetailsCardProps {
  opportunity: OpportunityRow;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
  agentLabel: string | null;
}

export function OpportunityDetailsCard({
  opportunity,
  contactOptions,
  agentOptions,
  agentLabel,
}: OpportunityDetailsCardProps) {
  const router = useRouter();
  const href = contactHref(opportunity);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(opportunity.name);
  const [contactId, setContactId] = useState(opportunity.contactId ?? "");
  const [pipeline, setPipeline] = useState<OpportunityPipeline | "">(opportunity.pipeline);
  const [stage, setStage] = useState<OpportunityStage | "">(opportunity.stage);
  const [amount, setAmount] = useState(formatAmountInput(opportunity.amountCents));
  const [expectedCloseDate, setExpectedCloseDate] = useState(
    opportunity.expectedCloseDate ?? "",
  );
  const [assignedAgentId, setAssignedAgentId] = useState(
    opportunity.assignedAgentId ?? "none",
  );
  const [priority, setPriority] = useState(opportunity.priority ?? "none");

  const stageOptions = pipeline ? stagesForPipeline(pipeline) : [];

  useEffect(() => {
    if (editing) return;
    setName(opportunity.name);
    setContactId(opportunity.contactId ?? "");
    setPipeline(opportunity.pipeline);
    setStage(opportunity.stage);
    setAmount(formatAmountInput(opportunity.amountCents));
    setExpectedCloseDate(opportunity.expectedCloseDate ?? "");
    setAssignedAgentId(opportunity.assignedAgentId ?? "none");
    setPriority(opportunity.priority ?? "none");
  }, [opportunity, editing]);

  function syncFromOpportunity() {
    setName(opportunity.name);
    setContactId(opportunity.contactId ?? "");
    setPipeline(opportunity.pipeline);
    setStage(opportunity.stage);
    setAmount(formatAmountInput(opportunity.amountCents));
    setExpectedCloseDate(opportunity.expectedCloseDate ?? "");
    setAssignedAgentId(opportunity.assignedAgentId ?? "none");
    setPriority(opportunity.priority ?? "none");
  }

  function startEdit() {
    setError(null);
    setSuccess(false);
    syncFromOpportunity();
    setOpen(true);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
    setSuccess(false);
    syncFromOpportunity();
  }

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
    setSuccess(false);

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

    const opportunityType: OpportunityType = isOpportunityType(opportunity.opportunityType)
      ? opportunity.opportunityType
      : DEFAULT_OPPORTUNITY_TYPE;

    const formData = new FormData(e.currentTarget);
    formData.set("opportunityId", opportunity.id);
    formData.set("contactId", contactId);
    formData.set("opportunityType", opportunityType);
    formData.set("pipeline", pipeline);
    formData.set("stage", stage);
    formData.set("assignedAgentId", assignedAgentId === "none" ? "" : assignedAgentId);
    formData.set("leadSource", opportunity.leadSource ?? "");
    formData.set("priority", priority === "none" ? "" : priority);
    formData.set("notes", opportunity.notes ?? "");

    startTransition(async () => {
      const result = await updateOpportunityAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not update opportunity.");
        return;
      }
      setSuccess(true);
      setEditing(false);
      router.refresh();
    });
  }

  const contactSelectOptions = [
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
    <section className={`${styles.dealCard} ${styles.dealPropertiesCard}`}>
      <div className={styles.dealPropertiesHeader}>
        <button
          type="button"
          className={styles.dealPropertiesHeaderToggle}
          aria-expanded={open}
          onClick={() => {
            if (editing) return;
            setOpen((value) => !value);
          }}
          disabled={editing}
        >
          <span>Opportunity Details</span>
          <AccordionChevron open={open} />
        </button>
        {!editing ? (
          <IconEdit onClick={startEdit} label="Edit opportunity details" />
        ) : null}
      </div>

      {open ? (
        !editing ? (
          <div className={styles.dealPropertiesRows}>
            <PropertyRow label="Name" value={opportunity.name || displayValue(null)} />
            <PropertyRow label="Stage" value={opportunity.stageLabel} />
            <PropertyRow label="Deal value" value={formatUsd(opportunity.amountCents)} />
            <PropertyRow label="Owner" value={agentLabel ?? displayValue(null)} />
            <PropertyRow label="Client">
              {opportunity.contactId && opportunity.contactName ? (
                <Link
                  href={href ?? `/leads/${opportunity.contactId}`}
                  className={`${styles.personPropertyLink} ${styles.contactLink}`}
                >
                  {opportunity.contactName}
                </Link>
              ) : (
                displayValue(null)
              )}
            </PropertyRow>
            <PropertyRow
              label="Expected close date"
              value={formatShortDate(opportunity.expectedCloseDate)}
            />
            <PropertyRow label="Priority">
              <PriorityValue
                priority={
                  isOpportunityPriority(opportunity.priority ?? "")
                    ? opportunity.priority
                    : null
                }
              />
            </PropertyRow>
            <PropertyRow label="Pipeline" value={opportunity.pipeline} />
          </div>
        ) : (
          <form
            className={`${styles.personAboutForm} ${styles.dealPropertiesEditForm}`}
            onSubmit={handleSubmit}
          >
            <div className={styles.dealPropertiesEditFull}>
              <InlineEditMessages error={error} success={success} />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="deal-details-name">
                Name
              </label>
              <input
                id="deal-details-name"
                name="name"
                className={styles.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={pending}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="deal-details-contact">
                Client
              </label>
              <DropdownSelect
                id="deal-details-contact"
                value={contactId}
                ariaLabel="Client"
                disabled={pending || contactOptions.length === 0}
                onChange={setContactId}
                options={contactSelectOptions}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="deal-details-pipeline">
                Pipeline
              </label>
              <DropdownSelect
                id="deal-details-pipeline"
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

            <div className={styles.field}>
              <label className={styles.label} htmlFor="deal-details-stage">
                Stage
              </label>
              <DropdownSelect
                id="deal-details-stage"
                value={stage}
                ariaLabel="Stage"
                disabled={pending || !pipeline}
                onChange={(value) => setStage(value as OpportunityStage)}
                options={stageOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="deal-details-amount">
                Deal value
              </label>
              <input
                id="deal-details-amount"
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
              <label className={styles.label} htmlFor="deal-details-agent">
                Owner
              </label>
              <DropdownSelect
                id="deal-details-agent"
                value={assignedAgentId}
                ariaLabel="Owner"
                disabled={pending}
                onChange={setAssignedAgentId}
                options={agentSelectOptions}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="deal-details-close">
                Expected close date
              </label>
              <DateInput
                id="deal-details-close"
                name="expectedCloseDate"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                disabled={pending}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="deal-details-priority">
                Priority
              </label>
              <DropdownSelect
                id="deal-details-priority"
                value={priority}
                ariaLabel="Priority"
                disabled={pending}
                onChange={setPriority}
                options={prioritySelectOptions}
              />
            </div>

            <div className={styles.dealPropertiesEditFull}>
              <EditFormActions pending={pending} onCancel={cancelEdit} />
            </div>
          </form>
        )
      ) : null}
    </section>
  );
}

export function OpportunityAdditionalInfoCard() {
  const [open, setOpen] = useState(true);

  return (
    <section className={`${styles.dealCard} ${styles.dealPropertiesCard}`}>
      <div className={styles.dealPropertiesHeader}>
        <button
          type="button"
          className={styles.dealPropertiesHeaderToggle}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>Additional Information</span>
          <AccordionChevron open={open} />
        </button>
      </div>
      {open ? (
        <div className={styles.personSideCardBody}>
          <div className={styles.personEmptyBlock}>
            <p className={styles.personEmptyTitle}>Coming soon</p>
            <p className={styles.personEmptyText}>
              Extra opportunity fields and notes will appear here.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
