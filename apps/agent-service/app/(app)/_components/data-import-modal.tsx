"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { importCrmRowsAction, type ImportCrmResult } from "@/lib/crm/import-actions";
import {
  fieldsForEntity,
  getMappedValue,
  mappedCount,
  parseSpreadsheetFile,
  suggestMapping,
  type ImportEntity,
  type ImportMode,
} from "@/lib/crm/import-parse";
import styles from "@/components/shell/shell.module.css";

const STEPS = [
  { id: 1, label: "Choose data" },
  { id: 2, label: "Edit mapping" },
  { id: 3, label: "Preview" },
  { id: 4, label: "Import" },
] as const;

const ENTITY_OPTIONS = [
  {
    value: "leads" as const,
    label: "Leads",
    description: "People entering your sales pipeline",
  },
  {
    value: "contacts" as const,
    label: "Contacts",
    description: "People in your address book",
  },
  {
    value: "opportunities" as const,
    label: "Opportunities",
    description: "Deals and transactions you are working",
  },
];

const MODE_OPTIONS = [
  {
    value: "add_update" as const,
    label: "Add & update",
    description: "Create new records and update matches",
  },
  {
    value: "add_only" as const,
    label: "Add only",
    description: "Create new records; skip existing ones",
  },
  {
    value: "update_only" as const,
    label: "Update only",
    description: "Update matches; skip new records",
  },
];

interface DataImportModalProps {
  open: boolean;
  onClose: () => void;
}

export function DataImportModal({ open, onClose }: DataImportModalProps) {
  const router = useRouter();
  const titleId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(1);
  const [entity, setEntity] = useState<ImportEntity>("leads");
  const [mode, setMode] = useState<ImportMode>("add_update");
  const [fileName, setFileName] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportCrmResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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
  }, [open, onClose, pending]);

  useEffect(() => {
    if (!open) {
      setStep(1);
      setEntity("leads");
      setMode("add_update");
      setFileName(null);
      setColumns([]);
      setRows([]);
      setMapping({});
      setParseError(null);
      setImportResult(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [open]);

  useEffect(() => {
    if (columns.length === 0) return;
    setMapping(suggestMapping(columns, entity));
  }, [entity, columns]);

  const fieldOptions = useMemo(() => fieldsForEntity(entity), [entity]);
  const mappedFields = mappedCount(mapping);
  const unmappedFields = Math.max(columns.length - mappedFields, 0);
  const entityLabel = ENTITY_OPTIONS.find((option) => option.value === entity)?.label ?? "Leads";
  const modeLabel = MODE_OPTIONS.find((option) => option.value === mode)?.description ?? "";
  const previewRows = rows.slice(0, 25);

  if (!open || !mounted) return null;

  function closeIfAllowed() {
    if (!pending) onClose();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    try {
      const parsed = await parseSpreadsheetFile(file);
      setFileName(parsed.fileName);
      setColumns(parsed.columns);
      setRows(parsed.rows);
      setMapping(suggestMapping(parsed.columns, entity));
    } catch (error) {
      setFileName(null);
      setColumns([]);
      setRows([]);
      setMapping({});
      setParseError(error instanceof Error ? error.message : "Could not read that file.");
    }
  }

  function canContinue() {
    if (step === 1) return Boolean(fileName) && rows.length > 0 && !parseError;
    if (step === 2) return mappedFields > 0;
    if (step === 3) return rows.length > 0;
    return true;
  }

  function buildMappedRows() {
    return rows.map((row) => {
      const values: Record<string, string> = {};
      for (const [column, field] of Object.entries(mapping)) {
        if (field === "skip") continue;
        values[field] = row[column]?.trim() ?? "";
      }
      return { values };
    });
  }

  function goNext() {
    if (step === 3) {
      setStep(4);
      setImportResult(null);
      startTransition(async () => {
        const result = await importCrmRowsAction({
          entity,
          mode,
          rows: buildMappedRows(),
        });
        setImportResult(result);
        if (result.ok || result.created > 0 || result.updated > 0) {
          router.refresh();
        }
      });
      return;
    }
    if (step < 4) setStep((current) => current + 1);
  }

  function goBack() {
    if (step > 1 && step < 4) setStep((current) => current - 1);
  }

  const stepCopy =
    step === 1
      ? {
          title: "Choose data",
          subtitle: "Select what you want to import and upload your spreadsheet.",
        }
      : step === 2
        ? {
            title: "Edit mapping",
            subtitle: "Match each file column to a REOS field.",
          }
        : step === 3
          ? {
              title: "Preview & Start Import",
              subtitle: "Review your import information and click Import.",
            }
          : {
              title: pending
                ? "Importing…"
                : importResult?.ok
                  ? "Import complete"
                  : "Import finished with issues",
              subtitle: pending
                ? "Hang tight while we process your file."
                : "Review the results below.",
            };

  const sampleHref =
    entity === "opportunities"
      ? "/samples/opportunities-import-sample.csv"
      : entity === "contacts"
        ? "/samples/contacts-import-sample.csv"
        : "/samples/leads-import-sample.csv";
  const sampleDownload =
    entity === "opportunities"
      ? "opportunities-import-sample.csv"
      : entity === "contacts"
        ? "contacts-import-sample.csv"
        : "leads-import-sample.csv";

  return createPortal(
    <div className={styles.modalOverlay} onClick={closeIfAllowed}>
      <div
        className={`${styles.modalPanel} ${styles.importModalPanel}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.importModalTop}>
          <ol className={styles.importStepper} aria-label="Import steps">
            {STEPS.map((item, index) => {
              const done = item.id < step || (item.id === 4 && Boolean(importResult) && !pending);
              const current = item.id === step && !(item.id === 4 && importResult && !pending);
              return (
                <li key={item.id} className={styles.importStepperItem}>
                  {index > 0 && (
                    <span className={styles.importStepperChevron} aria-hidden>
                      ›
                    </span>
                  )}
                  <span
                    className={`${styles.importStepperDot} ${
                      done || current ? styles.importStepperDotActive : ""
                    }`}
                  >
                    {item.id}
                  </span>
                  <span
                    className={`${styles.importStepperLabel} ${
                      done || current ? styles.importStepperLabelActive : ""
                    }`}
                  >
                    {item.label}
                  </span>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Close"
            onClick={closeIfAllowed}
            disabled={pending}
          >
            ×
          </button>
        </div>

        <div className={styles.importModalBody}>
          <div className={styles.importModalIntro}>
            <div className={styles.importModalIntroRow}>
              <h2 id={titleId} className={styles.importModalTitle}>
                {stepCopy.title}
              </h2>
              {step === 1 && (
                <a className={styles.importSampleLink} href={sampleHref} download={sampleDownload}>
                  Download sample CSV
                </a>
              )}
            </div>
            <p className={styles.importModalSubtitle}>{stepCopy.subtitle}</p>
          </div>

          {step === 1 && (
            <div className={styles.importStepGrid}>
              <div className={`${styles.field} ${styles.importEntityField}`}>
                <span className={styles.label} id="import-entity-label">
                  Data type
                </span>
                <div
                  className={styles.importEntityCards}
                  role="radiogroup"
                  aria-labelledby="import-entity-label"
                >
                  {ENTITY_OPTIONS.map((option) => {
                    const selected = entity === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`${styles.importEntityCard} ${
                          selected ? styles.importEntityCardSelected : ""
                        }`}
                        onClick={() => setEntity(option.value)}
                      >
                        <span className={styles.importEntityCardTitle}>{option.label}</span>
                        <span className={styles.importEntityCardDesc}>{option.description}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={`${styles.field} ${styles.importEntityField}`}>
                <span className={styles.label} id="import-mode-label">
                  Import mode
                </span>
                <div
                  className={styles.importModeCards}
                  role="radiogroup"
                  aria-labelledby="import-mode-label"
                >
                  {MODE_OPTIONS.map((option) => {
                    const selected = mode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`${styles.importEntityCard} ${
                          selected ? styles.importEntityCardSelected : ""
                        }`}
                        onClick={() => setMode(option.value)}
                      >
                        <span className={styles.importEntityCardTitle}>{option.label}</span>
                        <span className={styles.importEntityCardDesc}>{option.description}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={`${styles.field} ${styles.importUploadField}`}>
                <span className={styles.label}>File</span>
                <button
                  type="button"
                  className={styles.importUploadBox}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <strong>{fileName ?? "Upload spreadsheet"}</strong>
                  <span>
                    {rows.length > 0
                      ? `${rows.length} row${rows.length === 1 ? "" : "s"} ready`
                      : "CSV or Excel (.csv, .xlsx, .xls)"}
                  </span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className={styles.srOnly}
                  onChange={handleFileChange}
                />
                {parseError && <p className={styles.error}>{parseError}</p>}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className={styles.importMappingList}>
              {columns.map((column) => (
                <div key={column} className={styles.importMappingRow}>
                  <div className={styles.importMappingSource}>
                    <span className={styles.importMappingCaption}>File column</span>
                    <strong>{column}</strong>
                  </div>
                  <span className={styles.importMappingArrow} aria-hidden>
                    →
                  </span>
                  <div className={styles.importMappingTarget}>
                    <label className={styles.importMappingCaption} htmlFor={`map-${column}`}>
                      REOS field
                    </label>
                    <DropdownSelect
                      id={`map-${column}`}
                      value={mapping[column] ?? "skip"}
                      ariaLabel={`Map ${column} to REOS field`}
                      onChange={(value) =>
                        setMapping((current) => ({ ...current, [column]: value }))
                      }
                      options={fieldOptions.map((option) => ({
                        value: option.value,
                        label: option.label,
                      }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {step === 3 && (
            <>
              <div className={styles.importSummaryGrid}>
                <section className={`${styles.importSummaryCard} ${styles.importSummarySelections}`}>
                  <h3>Your selections:</h3>
                  <ul>
                    <li>
                      <CheckIcon />
                      {entityLabel}
                    </li>
                    <li>
                      <CheckIcon />
                      {modeLabel}
                    </li>
                    <li>
                      <CheckIcon />
                      {fileName ?? "Untitled file"}
                    </li>
                  </ul>
                </section>
                <section className={`${styles.importSummaryCard} ${styles.importSummaryMapped}`}>
                  <h3>Your import will include:</h3>
                  <p className={styles.importSummaryStat}>
                    <strong>{mappedFields}</strong>
                    <span>Mapped fields</span>
                  </p>
                </section>
                <section className={`${styles.importSummaryCard} ${styles.importSummaryUnmapped}`}>
                  <h3>Your import will not include:</h3>
                  <p className={styles.importSummaryStat}>
                    <strong>{unmappedFields}</strong>
                    <span>Unmapped fields</span>
                  </p>
                </section>
              </div>

              <p className={styles.importModalSubtitle}>
                Showing {previewRows.length} of {rows.length} row{rows.length === 1 ? "" : "s"}.
              </p>

              <div className={styles.importPreviewTableWrap}>
                <table className={styles.importPreviewTable}>
                  <thead>
                    <tr>
                      {entity === "opportunities" ? (
                        <>
                          <th>Name</th>
                          <th>Stage</th>
                          <th>Amount</th>
                          <th>Close date</th>
                          <th>Lead</th>
                          <th>Notes</th>
                        </>
                      ) : (
                        <>
                          <th>Name</th>
                          <th>Phone</th>
                          <th>Email</th>
                          <th>Status</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, index) => {
                      if (entity !== "opportunities") {
                        const full = getMappedValue(row, mapping, "full_name");
                        const first = getMappedValue(row, mapping, "first_name");
                        const last = getMappedValue(row, mapping, "last_name");
                        const name =
                          full || [first, last].filter(Boolean).join(" ") || "Untitled lead";
                        return (
                          <tr key={`${name}-${index}`}>
                            <td>
                              <div className={styles.importPreviewName}>
                                <span className={styles.importPreviewAvatar} aria-hidden>
                                  {name
                                    .split(" ")
                                    .map((part) => part[0])
                                    .join("")
                                    .slice(0, 2)
                                    .toUpperCase() || "?"}
                                </span>
                                <span>{name}</span>
                              </div>
                            </td>
                            <td>{getMappedValue(row, mapping, "phone") || "—"}</td>
                            <td>{getMappedValue(row, mapping, "email") || "—"}</td>
                            <td>{getMappedValue(row, mapping, "status") || "New"}</td>
                          </tr>
                        );
                      }

                      return (
                        <tr key={`${getMappedValue(row, mapping, "name")}-${index}`}>
                          <td>{getMappedValue(row, mapping, "name") || "Untitled"}</td>
                          <td>{getMappedValue(row, mapping, "stage") || "Qualification"}</td>
                          <td>{getMappedValue(row, mapping, "amount") || "—"}</td>
                          <td>{getMappedValue(row, mapping, "close_date") || "—"}</td>
                          <td>{getMappedValue(row, mapping, "lead_name") || "—"}</td>
                          <td>{getMappedValue(row, mapping, "notes") || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {step === 4 && (
            <div className={styles.importComplete}>
              {pending || !importResult ? (
                <>
                  <div className={styles.importSpinner} aria-hidden />
                  <p>Processing {rows.length} records…</p>
                </>
              ) : (
                <>
                  <div className={styles.importCompleteIcon} aria-hidden>
                    {importResult.failed > 0 && importResult.created + importResult.updated === 0
                      ? "!"
                      : "✓"}
                  </div>
                  <p>
                    Created <strong>{importResult.created}</strong>, updated{" "}
                    <strong>{importResult.updated}</strong>, skipped{" "}
                    <strong>{importResult.skipped}</strong>
                    {importResult.failed > 0 ? (
                      <>
                        , failed <strong>{importResult.failed}</strong>
                      </>
                    ) : null}{" "}
                    from <strong>{fileName}</strong>.
                  </p>
                  {importResult.errors.length > 0 && (
                    <ul className={styles.importErrorList}>
                      {importResult.errors.slice(0, 8).map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                      {importResult.errors.length > 8 && (
                        <li>…and {importResult.errors.length - 8} more</li>
                      )}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className={styles.importModalFooter}>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={closeIfAllowed}
            disabled={pending}
          >
            Cancel
          </button>
          {step > 1 && step < 4 && (
            <button type="button" className={styles.btnSecondary} onClick={goBack} disabled={pending}>
              Back
            </button>
          )}
          {step === 4 ? (
            !pending && importResult ? (
              <button type="button" className={styles.btnPrimary} onClick={onClose}>
                Done
              </button>
            ) : null
          ) : (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={goNext}
              disabled={!canContinue() || pending}
            >
              {step === 3 ? "Import" : "Continue"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="var(--shell-blue, #022342)" />
      <path
        d="M8 12.5l2.5 2.5L16 9.5"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
