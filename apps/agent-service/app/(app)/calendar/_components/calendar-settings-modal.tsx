"use client";

import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { TENANT_TIMEZONES } from "@/lib/admin/timezones";
import { saveCalendarSettingsAction } from "@/lib/calendar/calendar-settings-actions";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { TimeInput } from "@/components/shell/time-input";
import {
  TIME_STEP_MINUTES,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  fromMinutes,
  toMinutes,
  validateWorkingHours,
  type TimeRange,
  type WeekdayKey,
  type WorkingHours,
} from "@/lib/calendar/working-hours";
import shellStyles from "@/components/shell/shell.module.css";
import styles from "./calendar.module.css";

interface CalendarSettingsModalProps {
  open: boolean;
  onClose: () => void;
  timeZone: string;
  workingHours: WorkingHours;
  canEdit: boolean;
}

const DAY_INITIALS: Record<WeekdayKey, string> = {
  sun: "S",
  mon: "M",
  tue: "T",
  wed: "W",
  thu: "T",
  fri: "F",
  sat: "S",
};

const MIDNIGHT = 24 * 60;
const LAST_START = MIDNIGHT - TIME_STEP_MINUTES;

function cloneHours(hours: WorkingHours): WorkingHours {
  return {
    days: Object.fromEntries(
      WEEKDAY_KEYS.map((key) => [key, hours.days[key].map((r) => ({ ...r }))]),
    ) as Record<WeekdayKey, TimeRange[]>,
    showingsOnDaysOff: hours.showingsOnDaysOff,
  };
}

function nextRange(ranges: TimeRange[]): TimeRange | null {
  const lastEnd = ranges.length ? (toMinutes(ranges[ranges.length - 1].end) ?? 0) : 9 * 60;
  const start = ranges.length ? lastEnd + 60 : lastEnd;
  if (start + TIME_STEP_MINUTES > LAST_START) return null;
  return { start: fromMinutes(start), end: fromMinutes(Math.min(start + 60, LAST_START)) };
}

function timeZoneLabel(tz: string): string {
  return tz.replace(/_/g, " ");
}

export function CalendarSettingsModal({
  open,
  onClose,
  timeZone,
  workingHours,
  canEdit,
}: CalendarSettingsModalProps) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [hours, setHours] = useState(() => cloneHours(workingHours));
  const [tz, setTz] = useState(timeZone);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setHours(cloneHours(workingHours));
    setTz(timeZone);
    setError(null);
  }, [open, workingHours, timeZone]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, pending, onClose]);

  function updateDay(day: WeekdayKey, ranges: TimeRange[]) {
    setHours((current) => ({ ...current, days: { ...current.days, [day]: ranges } }));
  }

  function toggleDay(day: WeekdayKey) {
    if (hours.days[day].length > 0) {
      updateDay(day, []);
      return;
    }
    const template = WEEKDAY_KEYS.map((key) => hours.days[key]).find((r) => r.length > 0);
    updateDay(day, template ? template.map((r) => ({ ...r })) : [{ start: "09:00", end: "17:00" }]);
  }

  function setRange(day: WeekdayKey, index: number, patch: Partial<TimeRange>) {
    const ranges = hours.days[day].map((r, i) => (i === index ? { ...r, ...patch } : r));
    const edited = ranges[index];
    const start = toMinutes(edited.start) ?? 0;
    const end = toMinutes(edited.end) ?? 0;
    if (patch.start !== undefined && end <= start) {
      ranges[index] = { ...edited, end: fromMinutes(Math.min(start + 60, LAST_START)) };
    }
    updateDay(day, ranges);
  }

  function addRange(day: WeekdayKey) {
    const range = nextRange(hours.days[day]);
    if (range) updateDay(day, [...hours.days[day], range]);
  }

  function removeRange(day: WeekdayKey, index: number) {
    updateDay(
      day,
      hours.days[day].filter((_, i) => i !== index),
    );
  }

  function copyToAll(day: WeekdayKey) {
    const source = hours.days[day];
    setHours((current) => ({
      ...current,
      days: Object.fromEntries(
        WEEKDAY_KEYS.map((key) => [
          key,
          current.days[key].length > 0 ? source.map((r) => ({ ...r })) : [],
        ]),
      ) as Record<WeekdayKey, TimeRange[]>,
    }));
  }

  function handleSave() {
    if (pending || !canEdit) return;
    const problem = validateWorkingHours(hours);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await saveCalendarSettingsAction({ timeZone: tz, workingHours: hours });
      if (!result.ok) {
        setError(result.error ?? "Could not save calendar settings.");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  if (!open || !mounted) return null;

  const timeZones = (TENANT_TIMEZONES as readonly string[]).includes(tz)
    ? [...TENANT_TIMEZONES]
    : [tz, ...TENANT_TIMEZONES];
  const enabledDays = WEEKDAY_KEYS.filter((key) => hours.days[key].length > 0);
  const disabled = !canEdit || pending;

  return createPortal(
    <div className={shellStyles.modalOverlay} onClick={() => !pending && onClose()}>
      <div
        className={`${shellStyles.modalPanel} ${shellStyles.modalPanelWide}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={shellStyles.modalHeader}>
          <div>
            <h2 id="calendar-settings-title" className={shellStyles.modalTitle}>
              Calendar settings
            </h2>
            <p className={shellStyles.modalSubtitle}>
              Your AI agent only offers and books appointments during these hours.
            </p>
          </div>
          <button
            type="button"
            className={shellStyles.iconBtn}
            aria-label="Close"
            onClick={onClose}
            disabled={pending}
          >
            ×
          </button>
        </div>

        <div className={`${shellStyles.modalBody} ${shellStyles.modalBodyScroll}`}>
          {!canEdit ? (
            <p className={shellStyles.hint}>Only workspace owners can change these settings.</p>
          ) : null}
          {error ? <p className={shellStyles.error}>{error}</p> : null}

          <div className={shellStyles.field}>
            <label className={shellStyles.label} htmlFor="calendar-settings-tz">
              Time zone
            </label>
            <DropdownSelect
              id="calendar-settings-tz"
              value={tz}
              onChange={setTz}
              options={timeZones.map((zone) => ({ value: zone, label: timeZoneLabel(zone) }))}
              disabled={disabled}
              ariaLabel="Time zone"
            />
          </div>

          <p className={styles.settingsSectionTitle}>Working hours</p>
          <div className={styles.dayCircles} role="group" aria-label="Working days">
            {WEEKDAY_KEYS.map((key) => {
              const active = hours.days[key].length > 0;
              return (
                <button
                  key={key}
                  type="button"
                  className={`${styles.dayCircle} ${active ? styles.dayCircleActive : ""}`}
                  aria-pressed={active}
                  aria-label={WEEKDAY_LABELS[key]}
                  title={WEEKDAY_LABELS[key]}
                  onClick={() => toggleDay(key)}
                  disabled={disabled}
                >
                  {DAY_INITIALS[key]}
                </button>
              );
            })}
          </div>

          {enabledDays.length === 0 ? (
            <p className={shellStyles.hint}>Pick at least one working day.</p>
          ) : (
            <div className={styles.hoursList}>
              {enabledDays.map((day, dayIndex) => (
                <div key={day} className={styles.hoursRow}>
                  <span className={styles.hoursDay}>{WEEKDAY_LABELS[day]}</span>
                  <div className={styles.hoursRanges}>
                    {hours.days[day].map((range, index) => {
                      return (
                        <div key={index} className={styles.rangeRow}>
                          <TimeInput
                            className={styles.timeSelect}
                            aria-label={`${WEEKDAY_LABELS[day]} start time`}
                            value={range.start}
                            onChange={(e) => {
                              if (e.target.value) setRange(day, index, { start: e.target.value });
                            }}
                            stepMinutes={TIME_STEP_MINUTES}
                            emptyLabel="Start"
                            disabled={disabled}
                          />
                          <span className={styles.rangeSep}>to</span>
                          <TimeInput
                            className={styles.timeSelect}
                            aria-label={`${WEEKDAY_LABELS[day]} end time`}
                            value={range.end === "24:00" ? "23:30" : range.end}
                            onChange={(e) => {
                              if (e.target.value) setRange(day, index, { end: e.target.value });
                            }}
                            stepMinutes={TIME_STEP_MINUTES}
                            emptyLabel="End"
                            disabled={disabled}
                          />
                          {canEdit ? (
                            <button
                              type="button"
                              className={styles.rangeIconBtn}
                              aria-label="Remove time range"
                              title="Remove"
                              onClick={() => removeRange(day, index)}
                              disabled={pending}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    {canEdit ? (
                      <div className={styles.rangeActions}>
                        <button
                          type="button"
                          className={styles.linkBtn}
                          onClick={() => addRange(day)}
                          disabled={pending || !nextRange(hours.days[day])}
                        >
                          + Add hours
                        </button>
                        {dayIndex === 0 && enabledDays.length > 1 ? (
                          <button
                            type="button"
                            className={styles.linkBtn}
                            onClick={() => copyToAll(day)}
                            disabled={pending}
                          >
                            Copy to all
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          <label className={shellStyles.checkboxRow}>
            <input
              type="checkbox"
              checked={hours.showingsOnDaysOff}
              onChange={(e) => setHours((current) => ({ ...current, showingsOnDaysOff: e.target.checked }))}
              disabled={disabled}
            />
            <span>
              <strong>Allow property showings on days off</strong>
              <small>
                The agent can book private showings on non-working days, using your usual hours.
              </small>
            </span>
          </label>

          <div className={shellStyles.modalFooter}>
            <button
              type="button"
              className={shellStyles.btnSecondary}
              onClick={onClose}
              disabled={pending}
            >
              {canEdit ? "Cancel" : "Close"}
            </button>
            {canEdit ? (
              <button
                type="button"
                className={shellStyles.btnPrimary}
                onClick={handleSave}
                disabled={pending}
              >
                {pending ? "Saving…" : "Save"}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
