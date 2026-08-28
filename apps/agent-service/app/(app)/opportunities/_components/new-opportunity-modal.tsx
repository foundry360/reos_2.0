"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOpportunityAction } from "@/lib/crm/crm-actions";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { IconPlus } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

export const OPPORTUNITY_STAGE_OPTIONS = [
  { value: "Qualification", label: "Qualification" },
  { value: "Proposal", label: "Proposal" },
  { value: "Negotiation", label: "Negotiation" },
  { value: "Closed_Won", label: "Closed Won" },
  { value: "Closed_Lost", label: "Closed Lost" },
] as const;

interface LeadOption {
  id: string;
  label: string;
}

interface NewOpportunityModalProps {
  leadOptions: LeadOption[];
  trigger?: "pill" | "link" | "cta";
  linkLabel?: string;
  disabled?: boolean;
}

export function NewOpportunityModal({
  leadOptions,
  trigger = "pill",
  linkLabel = "Add the first one",
  disabled = false,
}: NewOpportunityModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [stage, setStage] = useState("Qualification");
  const [contactId, setContactId] = useState("none");
  const [amount, setAmount] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

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
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  function resetForm() {
    setName("");
    setStage("Qualification");
    setContactId("none");
    setAmount("");
    setExpectedCloseDate("");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    formData.set("stage", stage);
    formData.set("contactId", contactId);

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

  const contactOptions = [
    { value: "none", label: "No linked lead" },
    ...leadOptions.map((lead) => ({ value: lead.id, label: lead.label })),
  ];

  return (
    <>
      {trigger === "pill" || trigger === "cta" ? (
        <button
          type="button"
          className={`${styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          {trigger === "pill" ? (
            <>
              <IconPlus />
              New opportunity
            </>
          ) : (
            linkLabel === "Add the first one" ? "Add an Opportunity" : linkLabel
          )}
        </button>
      ) : (
        <button
          type="button"
          className={styles.modalLinkTrigger}
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
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-opportunity-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="new-opportunity-title" className={styles.modalTitle}>
                  New opportunity
                </h2>
                <p className={styles.modalSubtitle}>
                  Track a deal or appointment from qualification through close.
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

            <form className={styles.modalBody} onSubmit={handleSubmit}>
              {error && <p className={styles.error}>{error}</p>}

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-opp-name">
                  Name
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
                  Lead
                </label>
                <DropdownSelect
                  id="new-opp-contact"
                  value={contactId}
                  ariaLabel="Linked lead"
                  disabled={pending}
                  onChange={setContactId}
                  options={contactOptions}
                />
              </div>

              <div className={styles.inlineFieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-opp-stage">
                    Stage
                  </label>
                  <DropdownSelect
                    id="new-opp-stage"
                    value={stage}
                    ariaLabel="Stage"
                    disabled={pending}
                    onChange={setStage}
                    options={OPPORTUNITY_STAGE_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-opp-amount">
                    Amount
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
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-opp-close">
                  Expected close
                </label>
                <input
                  id="new-opp-close"
                  name="expectedCloseDate"
                  type="date"
                  className={styles.input}
                  value={expectedCloseDate}
                  onChange={(e) => setExpectedCloseDate(e.target.value)}
                  disabled={pending}
                />
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

              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </button>
                <button type="submit" className={styles.btnPrimary} disabled={pending}>
                  {pending ? "Adding…" : "Add opportunity"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
