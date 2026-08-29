"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTaskAction, updateTaskStatusAction } from "@/lib/crm/crm-actions";
import { DateInput } from "@/components/shell/date-input";
import { TimeInput } from "@/components/shell/time-input";
import styles from "@/components/shell/shell.module.css";

export type EditableTask = {
  id: string;
  title: string;
  status: "open" | "done";
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  notes: string | null;
};

function toIsoDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimeValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function TaskExpandPanel({
  task,
  onClose,
}: {
  task: EditableTask;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [dueDate, setDueDate] = useState(toIsoDate(task.dueAt));
  const [startDate, setStartDate] = useState(toIsoDate(task.startAt));
  const [startTime, setStartTime] = useState(toTimeValue(task.startAt));
  const [endDate, setEndDate] = useState(toIsoDate(task.endAt));
  const [endTime, setEndTime] = useState(toTimeValue(task.endAt));

  useEffect(() => {
    setError(null);
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setDueDate(toIsoDate(task.dueAt));
    setStartDate(toIsoDate(task.startAt));
    setStartTime(toTimeValue(task.startAt));
    setEndDate(toIsoDate(task.endAt));
    setEndTime(toTimeValue(task.endAt));
  }, [task]);

  function save() {
    setError(null);
    const formData = new FormData();
    formData.set("taskId", task.id);
    formData.set("title", title.trim());
    formData.set("notes", notes.trim());
    formData.set("dueDate", dueDate);
    formData.set("startDate", startDate);
    formData.set("startTime", startTime);
    formData.set("endDate", endDate);
    formData.set("endTime", endTime);

    startTransition(async () => {
      const result = await updateTaskAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not update task.");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function toggleComplete() {
    const nextStatus = task.status === "done" ? "open" : "done";
    setError(null);
    startTransition(async () => {
      const result = await updateTaskStatusAction(task.id, nextStatus);
      if (!result.ok) {
        setError(result.error ?? "Could not update status.");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <div className={styles.taskExpandPanel} onClick={(e) => e.stopPropagation()}>
      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`task-title-${task.id}`}>
          Title
        </label>
        <input
          id={`task-title-${task.id}`}
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={pending}
          required
        />
      </div>

      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <span className={styles.label}>Start</span>
          <div className={styles.taskComposerDateTime}>
            <DateInput
              id={`task-start-date-${task.id}`}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={pending}
              emptyLabel="Select a date"
            />
            <TimeInput
              id={`task-start-time-${task.id}`}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              disabled={pending}
              emptyLabel="Time"
            />
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>End</span>
          <div className={styles.taskComposerDateTime}>
            <DateInput
              id={`task-end-date-${task.id}`}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={pending}
              emptyLabel="Select a date"
            />
            <TimeInput
              id={`task-end-time-${task.id}`}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              disabled={pending}
              emptyLabel="Time"
            />
          </div>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`task-due-${task.id}`}>
          Due date
        </label>
        <DateInput
          id={`task-due-${task.id}`}
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          disabled={pending}
          emptyLabel="Select a date"
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`task-notes-${task.id}`}>
          Notes
        </label>
        <textarea
          id={`task-notes-${task.id}`}
          className={styles.textarea}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={pending}
          placeholder="Optional notes…"
        />
      </div>

      <div className={styles.taskExpandActions}>
        <button
          type="button"
          className={`${styles.btnSecondary} ${styles.btnPill}`}
          onClick={toggleComplete}
          disabled={pending}
        >
          {task.status === "done" ? "Reopen" : "Mark complete"}
        </button>
        <div className={styles.taskExpandActionsEnd}>
          <button
            type="button"
            className={`${styles.btnSecondary} ${styles.btnPill}`}
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btnPrimary} ${styles.btnPill}`}
            onClick={save}
            disabled={pending || !title.trim()}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
