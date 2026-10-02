"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createJourneyAction } from "@/lib/journeys/journey-actions";
import { JOURNEY_TEMPLATES, type JourneyTemplateId } from "@/lib/journeys/journey-templates";
import {
  JOURNEY_DESCRIPTION_MAX,
  JOURNEY_NAME_MAX,
} from "@/lib/journeys/journey-validation";
import { IconPlus } from "@/components/shell/sidebar-nav";
import shell from "@/components/shell/shell.module.css";
import styles from "./journeys.module.css";

const TEMPLATE_ORDER: JourneyTemplateId[] = ["blank", "new_lead_qualification"];

interface CreateJourneyModalProps {
  trigger?: "pill" | "cta" | "secondary";
  label?: string;
  defaultTemplate?: JourneyTemplateId;
}

export function CreateJourneyModal({
  trigger = "pill",
  label = "Create Journey",
  defaultTemplate = "blank",
}: CreateJourneyModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState<JourneyTemplateId>(defaultTemplate);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTemplateId(defaultTemplate);
    setName(defaultTemplate === "blank" ? "" : JOURNEY_TEMPLATES[defaultTemplate].name);
    setNameTouched(false);
    setDescription("");
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeyDown);
    };
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function selectTemplate(next: JourneyTemplateId) {
    setTemplateId(next);
    if (!nameTouched) setName(next === "blank" ? "" : JOURNEY_TEMPLATES[next].name);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await createJourneyAction({ name, description, templateId });
      if (!result.ok || !result.id) {
        setError(result.error ?? "Could not create the journey.");
        return;
      }
      setOpen(false);
      router.push(`/marketing/journeys/${result.id}`);
    });
  }

  const dialog =
    open && mounted
      ? createPortal(
          <div className={shell.modalOverlay} onClick={() => !pending && setOpen(false)}>
            <div
              className={`${shell.modalPanel} ${shell.modalPanelWide}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-journey-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className={shell.modalHeader}>
                <div className={shell.modalHeaderText}>
                  <h2 id="create-journey-title" className={shell.modalTitle}>
                    Create Journey
                  </h2>
                  <p className={shell.modalSubtitle}>
                    New journeys start as drafts. Nothing runs until you activate it.
                  </p>
                </div>
                <button
                  type="button"
                  className={shell.iconBtn}
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  ×
                </button>
              </div>

              <form className={shell.modalForm} onSubmit={handleSubmit}>
                <div className={`${shell.modalBody} ${shell.modalBodyScroll}`}>
                  {error ? <p className={shell.error}>{error}</p> : null}

                  <p className={shell.modalSectionLabel}>Start from</p>
                  <div className={styles.templateGrid} role="radiogroup" aria-label="Start from">
                    {TEMPLATE_ORDER.map((id) => {
                      const template = JOURNEY_TEMPLATES[id];
                      const active = templateId === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={`${styles.templateOption} ${
                            active ? styles.templateOptionActive : ""
                          }`}
                          onClick={() => selectTemplate(id)}
                          disabled={pending}
                        >
                          <span className={styles.templateOptionTitle}>{template.name}</span>
                          <span className={styles.templateOptionDesc}>{template.description}</span>
                        </button>
                      );
                    })}
                  </div>

                  <p className={shell.modalSectionLabel}>Details</p>
                  <div className={shell.field}>
                    <label className={shell.label} htmlFor="create-journey-name">
                      Journey name
                    </label>
                    <input
                      id="create-journey-name"
                      className={shell.input}
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setNameTouched(true);
                      }}
                      placeholder="e.g. New Lead Follow-up"
                      maxLength={JOURNEY_NAME_MAX}
                      required
                      autoFocus
                      disabled={pending}
                    />
                  </div>

                  <div className={shell.field}>
                    <label className={shell.label} htmlFor="create-journey-description">
                      Description <span className={styles.journeyMuted}>(optional)</span>
                    </label>
                    <textarea
                      id="create-journey-description"
                      className={shell.textarea}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="What should this journey accomplish?"
                      maxLength={JOURNEY_DESCRIPTION_MAX}
                      rows={3}
                      disabled={pending}
                    />
                  </div>
                </div>

                <div className={shell.modalFooter}>
                  <button
                    type="button"
                    className={`${shell.btnSecondary} ${shell.btnPill}`}
                    onClick={() => setOpen(false)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`${shell.btnPrimary} ${shell.btnPill}`}
                    disabled={pending || !name.trim()}
                  >
                    {pending ? "Creating…" : "Create & Open Builder"}
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
      <button
        type="button"
        className={`${trigger === "secondary" ? shell.btnSecondary : shell.btnPrimary} ${shell.btnPill}`}
        onClick={() => setOpen(true)}
      >
        {trigger === "pill" ? <IconPlus /> : null}
        {label}
      </button>
      {dialog}
    </>
  );
}
