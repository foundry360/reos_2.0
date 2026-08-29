"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createTaskAction } from "@/lib/crm/crm-actions";
import {
  OPPORTUNITY_PRIORITY_COLORS,
  OPPORTUNITY_PRIORITY_OPTIONS,
} from "@/lib/opportunities/opportunity-fields";
import { DateInput } from "@/components/shell/date-input";
import { TimeInput } from "@/components/shell/time-input";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { IconPlus } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayIso(): string {
  return toIsoDate(new Date());
}

const TASK_TYPE_OPTIONS = [
  { value: "todo", label: "To-do" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "follow_up", label: "Follow-up" },
] as const;

interface SelectOption {
  id: string;
  label: string;
}

interface OpportunitySelectOption extends SelectOption {
  contactId?: string | null;
}

interface NewTaskModalProps {
  leadOptions: SelectOption[];
  opportunityOptions?: OpportunitySelectOption[];
  agentOptions?: SelectOption[];
  defaultContactId?: string;
  lockContact?: boolean;
  opportunityId?: string;
  lockOpportunity?: boolean;
  trigger?: "pill" | "link" | "cta" | "secondary" | "quickAction";
  linkLabel?: string;
  triggerIcon?: ReactNode;
  disabled?: boolean;
}

export function NewTaskModal({
  leadOptions,
  opportunityOptions = [],
  agentOptions = [],
  defaultContactId = "",
  lockContact = false,
  opportunityId,
  lockOpportunity = Boolean(opportunityId),
  trigger = "pill",
  linkLabel = "Add the first one",
  triggerIcon,
  disabled = false,
}: NewTaskModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [contactId, setContactId] = useState(
    lockContact ? defaultContactId || "none" : "none",
  );
  const [selectedOpportunityId, setSelectedOpportunityId] = useState(
    lockOpportunity && opportunityId ? opportunityId : "none",
  );
  const [dueDate, setDueDate] = useState(todayIso);
  const [reminderDate, setReminderDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [taskType, setTaskType] = useState<string>("todo");
  const [priority, setPriority] = useState("none");
  const [assignedTo, setAssignedTo] = useState("me");
  const [notes, setNotes] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const resolvedDefaultContactId = lockContact
    ? defaultContactId || leadOptions[0]?.id || ""
    : defaultContactId;

  const showOpportunityField = !lockOpportunity || Boolean(opportunityId);

  const taskTypeSelectOptions = TASK_TYPE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  }));

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

  const assignedSelectOptions = [
    { value: "me", label: "Me" },
    { value: "none", label: "Unassigned" },
    ...agentOptions.map((option) => ({
      value: option.id,
      label: option.label,
    })),
  ];

  const effectiveContactId = lockContact
    ? resolvedDefaultContactId || contactId
    : contactId;

  const contactSelectOptions = lockContact
    ? leadOptions.map((lead) => ({
        value: lead.id,
        label: lead.label,
      }))
    : [
        { value: "none", label: "No contact" },
        ...leadOptions.map((lead) => ({
          value: lead.id,
          label: lead.label,
        })),
      ];

  const opportunitiesForContact =
    effectiveContactId && effectiveContactId !== "none"
      ? opportunityOptions.filter((option) => option.contactId === effectiveContactId)
      : [];

  const opportunitySelectOptions =
    lockOpportunity && opportunityId
      ? [
          {
            value: opportunityId,
            label:
              opportunityOptions.find((option) => option.id === opportunityId)?.label ??
              "Current opportunity",
          },
        ]
      : [
          {
            value: "none",
            label:
              !effectiveContactId || effectiveContactId === "none"
                ? "Select a contact first"
                : opportunitiesForContact.length === 0
                  ? "No opportunities for this contact"
                  : "No opportunity",
          },
          ...opportunitiesForContact.map((option) => ({
            value: option.id,
            label: option.label,
          })),
        ];

  const opportunityDisabled =
    pending ||
    lockOpportunity ||
    !effectiveContactId ||
    effectiveContactId === "none" ||
    (!lockOpportunity && opportunitiesForContact.length === 0);

  function handleContactChange(nextId: string) {
    setContactId(nextId);
    if (lockOpportunity) return;
    const stillValid =
      selectedOpportunityId !== "none" &&
      opportunityOptions.some(
        (option) =>
          option.id === selectedOpportunityId && option.contactId === nextId,
      );
    if (!stillValid) {
      setSelectedOpportunityId("none");
    }
  }

  function handleOpportunityChange(nextId: string) {
    setSelectedOpportunityId(nextId);
  }

  useEffect(() => {
    setMounted(true);
  }, []);

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
      setDueDate(todayIso());
      setReminderDate("");
      setStartDate("");
      setStartTime("");
      setEndDate("");
      setEndTime("");
      setTaskType("todo");
      setPriority("none");
      setAssignedTo("me");
      if (lockContact && resolvedDefaultContactId) {
        setContactId(resolvedDefaultContactId);
      } else if (defaultContactId) {
        setContactId(defaultContactId);
      } else {
        setContactId("none");
      }
      setSelectedOpportunityId(
        lockOpportunity && opportunityId ? opportunityId : "none",
      );
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [
    open,
    lockContact,
    resolvedDefaultContactId,
    defaultContactId,
    lockOpportunity,
    opportunityId,
  ]);

  function resetForm() {
    setTitle("");
    setContactId(lockContact ? resolvedDefaultContactId || "none" : "none");
    setSelectedOpportunityId(
      lockOpportunity && opportunityId ? opportunityId : "none",
    );
    setDueDate(todayIso());
    setReminderDate("");
    setStartDate("");
    setStartTime("");
    setEndDate("");
    setEndTime("");
    setTaskType("todo");
    setPriority("none");
    setAssignedTo("me");
    setNotes("");
    setRepeat(false);
    setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    const formData = new FormData();
    formData.set("title", title.trim());
    formData.set("notes", notes.trim());
    formData.set("dueDate", dueDate);
    formData.set("startDate", startDate);
    formData.set("startTime", startTime);
    formData.set("endDate", endDate);
    formData.set("endTime", endTime);
    formData.set(
      "contactId",
      lockContact ? resolvedDefaultContactId || contactId : contactId,
    );
    const resolvedOpportunityId =
      lockOpportunity && opportunityId
        ? opportunityId
        : selectedOpportunityId !== "none"
          ? selectedOpportunityId
          : "";
    if (resolvedOpportunityId) {
      formData.set("opportunityId", resolvedOpportunityId);
    }

    startTransition(async () => {
      const result = await createTaskAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not create task.");
        return;
      }
      resetForm();
      setOpen(false);
      router.refresh();
    });
  }

  const dialog =
    open && mounted
      ? createPortal(
          <div className={styles.modalOverlay} onClick={() => !pending && setOpen(false)}>
            <div
              ref={panelRef}
              className={`${styles.modalPanel} ${styles.modalPanelWide}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-task-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalHeader}>
                <div className={styles.modalHeaderText}>
                  <h2 id="new-task-title" className={styles.modalTitle}>
                    New Task
                  </h2>
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
                  {error ? <p className={styles.error}>{error}</p> : null}

                  <p className={styles.modalSectionLabel}>Task</p>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-task-title-input">
                      Title
                    </label>
                    <input
                      id="new-task-title-input"
                      name="title"
                      className={styles.input}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Enter your task"
                      required
                      disabled={pending}
                      autoFocus
                    />
                  </div>

                  <div className={styles.fieldRow}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="new-task-contact">
                        Contact
                      </label>
                      <DropdownSelect
                        id="new-task-contact"
                        value={effectiveContactId}
                        ariaLabel="Contact"
                        disabled={pending || lockContact || leadOptions.length === 0}
                        onChange={handleContactChange}
                        options={contactSelectOptions}
                      />
                    </div>
                    {showOpportunityField ? (
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor="new-task-opportunity">
                          Opportunity
                        </label>
                        <DropdownSelect
                          id="new-task-opportunity"
                          value={
                            lockOpportunity && opportunityId
                              ? opportunityId
                              : selectedOpportunityId
                          }
                          ariaLabel="Opportunity"
                          disabled={opportunityDisabled}
                          onChange={handleOpportunityChange}
                          options={opportunitySelectOptions}
                        />
                      </div>
                    ) : null}
                  </div>

                  <p className={styles.modalSectionLabel}>Schedule</p>

                  <div className={styles.fieldRow}>
                    <div className={styles.field}>
                      <span className={styles.label} id="new-task-start-label">
                        Start
                      </span>
                      <div className={styles.taskComposerDateTime}>
                        <DateInput
                          id="new-task-start-date"
                          name="startDate"
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                          disabled={pending}
                          aria-labelledby="new-task-start-label"
                          emptyLabel="Select a date"
                        />
                        <TimeInput
                          id="new-task-start-time"
                          name="startTime"
                          value={startTime}
                          onChange={(e) => setStartTime(e.target.value)}
                          disabled={pending}
                          aria-label="Start time"
                          emptyLabel="Time"
                        />
                      </div>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label} id="new-task-end-label">
                        End
                      </span>
                      <div className={styles.taskComposerDateTime}>
                        <DateInput
                          id="new-task-end-date"
                          name="endDate"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                          disabled={pending}
                          aria-labelledby="new-task-end-label"
                          emptyLabel="Select a date"
                        />
                        <TimeInput
                          id="new-task-end-time"
                          name="endTime"
                          value={endTime}
                          onChange={(e) => setEndTime(e.target.value)}
                          disabled={pending}
                          aria-label="End time"
                          emptyLabel="Time"
                        />
                      </div>
                    </div>
                  </div>

                  <div className={styles.fieldRow}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="new-task-due">
                        Due date
                      </label>
                      <DateInput
                        id="new-task-due"
                        name="dueDate"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                        disabled={pending}
                        emptyLabel="Select a date"
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="new-task-reminder">
                        Reminder
                      </label>
                      <DateInput
                        id="new-task-reminder"
                        name="reminderDate"
                        value={reminderDate}
                        onChange={(e) => setReminderDate(e.target.value)}
                        disabled={pending}
                        emptyLabel="No reminder"
                      />
                    </div>
                  </div>

                  <label className={styles.taskComposerCheck}>
                    <input
                      type="checkbox"
                      checked={repeat}
                      onChange={(e) => setRepeat(e.target.checked)}
                      disabled={pending}
                    />
                    Set to repeat
                  </label>

                  <p className={styles.modalSectionLabel}>Details</p>

                  <div className={styles.fieldRow}>
                    <div className={styles.field}>
                      <span className={styles.label} id="new-task-type-label">
                        Task type
                      </span>
                      <DropdownSelect
                        id="new-task-type"
                        value={taskType}
                        ariaLabel="Task type"
                        disabled={pending}
                        onChange={setTaskType}
                        options={taskTypeSelectOptions}
                      />
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label} id="new-task-priority-label">
                        Priority
                      </span>
                      <DropdownSelect
                        id="new-task-priority"
                        value={priority}
                        ariaLabel="Priority"
                        disabled={pending}
                        onChange={setPriority}
                        options={prioritySelectOptions}
                      />
                    </div>
                  </div>

                  <div className={styles.field}>
                    <span className={styles.label} id="new-task-assigned-label">
                      Assigned to
                    </span>
                    <DropdownSelect
                      id="new-task-assigned"
                      value={assignedTo}
                      ariaLabel="Assigned to"
                      disabled={pending}
                      onChange={setAssignedTo}
                      options={assignedSelectOptions}
                    />
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-task-notes">
                      Notes
                    </label>
                    <textarea
                      id="new-task-notes"
                      name="notes"
                      className={styles.textarea}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={4}
                      disabled={pending}
                      placeholder="Optional notes…"
                    />
                  </div>
                </div>

                <div className={styles.modalFooter}>
                  <button
                    type="button"
                    className={`${styles.btnSecondary} ${styles.btnPill}`}
                    onClick={() => setOpen(false)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`${styles.btnPrimary} ${styles.btnPill}`}
                    disabled={pending}
                  >
                    {pending ? "Saving…" : "Save Task"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {trigger === "quickAction" ? (
        <button
          type="button"
          className={styles.personQuickAction}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          {triggerIcon ? (
            <span className={styles.personQuickActionIcon}>{triggerIcon}</span>
          ) : null}
          <span>{linkLabel}</span>
        </button>
      ) : trigger === "pill" || trigger === "cta" || trigger === "secondary" ? (
        <button
          type="button"
          className={`${trigger === "secondary" ? styles.btnSecondary : styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          {trigger === "pill" ? (
            <>
              <IconPlus />
              New Task
            </>
          ) : trigger === "secondary" ? (
            <>
              <IconPlus />
              {linkLabel === "Add the first one" ? "Add" : linkLabel}
            </>
          ) : (
            linkLabel === "Add the first one" ? "Add a Task" : linkLabel
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

      {dialog}
    </>
  );
}
