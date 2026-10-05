"use client";

import { useRef, useState } from "react";
import {
  ACTION_TYPES,
  AI_OUTPUT_TYPES,
  AI_TEXT_KEY,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  EMPTY_STEP_REFERENCE,
  IMPLEMENTED_TRIGGER_EVENTS,
  INPUT_NAME_PATTERN,
  MAX_AI_OUTPUT_FIELDS,
  MAX_CONDITION_RULES,
  MAX_INPUT_MAPPINGS,
  MAX_RESULT_VALUES,
  NOTIFY_RECIPIENTS,
  STEP_FIELD_DRAFT,
  TEMPLATE_TOKENS,
  TRIGGER_EVENTS,
  TRIGGER_INPUT_FIELD_PATTERN,
  UPDATE_LEAD_FIELDS,
  WAIT_UNITS,
  isConditionLogic,
  isTriggerEventType,
  operatorsForField,
  sanitizeOutputField,
  stepReferenceDraft,
  stepReferenceField,
  updateStepReferenceDraft,
  validateNodeConfig,
  type AIOutputField,
  type ConditionLogic,
  type ConditionRule,
  type FieldDefinition,
  type InputMapping,
  type ResultExport,
  type ResultMapping,
  type StepReferenceDraft,
  type TriggerEventType,
} from "@/lib/journeys/runtime/contracts";
import type { JourneyNodeConfig, JourneyNodeType } from "@/lib/journeys/journey-types";
import { DropdownSelect, type DropdownSelectOption } from "@/components/shell/dropdown-select";
import shell from "@/components/shell/shell.module.css";
import styles from "../journeys.module.css";

export interface StepOption {
  /** Node-id reference key; what new references store. */
  key: string;
  /** Name-derived key, so references saved before node-id keys still show their step. */
  legacyKey?: string;
  label: string;
  /** Output fields the step is known to produce; null means type the field name. */
  outputs: string[] | null;
}

/** A journey a Start journey step can target, with the result names its trigger declares. */
export interface JourneyOption {
  id: string;
  label: string;
  results?: string[];
}

interface NodeConfigFormProps {
  nodeId: string;
  nodeType: JourneyNodeType;
  config: JourneyNodeConfig;
  onChange: (config: JourneyNodeConfig) => void;
  agentOptions: { id: string; label: string }[];
  /** Other journeys in the workspace a Start journey step can target. */
  journeyOptions: JourneyOption[];
  /** Steps guaranteed to run before this condition or Start journey step, whose output it can read. */
  stepOptions: StepOption[];
  /** The journey's trigger event, so conditions can offer trigger fields. */
  triggerEvent: TriggerEventType | null;
}

const TOKEN_HINT = `Personalize with ${TEMPLATE_TOKENS.map((token) => `{{${token}}}`).join(", ")}.`;

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function fieldsFor(event: TriggerEventType | null, includeTrigger: boolean, inCondition: boolean) {
  return Object.entries(CONDITION_FIELDS).filter(([key, def]) => {
    if (def.conditionOnly && !inCondition) return false;
    if (!key.startsWith("trigger.")) return true;
    return includeTrigger && (!def.events || (event !== null && def.events.includes(event)));
  });
}

/** Prepends an empty choice so a value can be cleared (e.g. "Don't change"). */
function withClear(options: DropdownSelectOption[], clearLabel?: string): DropdownSelectOption[] {
  return clearLabel ? [{ value: "", label: clearLabel }, ...options] : options;
}

function ValueInput({
  id,
  definition,
  value,
  onChange,
  clearLabel,
}: {
  id: string;
  definition: FieldDefinition | null;
  value: unknown;
  onChange: (value: string | number | boolean | null) => void;
  clearLabel?: string;
}) {
  if (definition?.type === "boolean") {
    return (
      <DropdownSelect
        id={id}
        value={value === true ? "true" : value === false ? "false" : ""}
        placeholder={clearLabel ?? "Choose…"}
        onChange={(next) => onChange(next === "" ? null : next === "true")}
        options={withClear(
          [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ],
          clearLabel,
        )}
      />
    );
  }
  if (definition?.type === "enum" && definition.options) {
    return (
      <DropdownSelect
        id={id}
        value={str(value)}
        placeholder={clearLabel ?? "Choose…"}
        onChange={(next) => onChange(next || null)}
        options={withClear(
          definition.options.map((option) => ({ value: option, label: option.replace(/_/g, " ") })),
          clearLabel,
        )}
      />
    );
  }
  return (
    <input
      id={id}
      className={shell.input}
      type={definition?.type === "number" ? "number" : "text"}
      value={str(value)}
      onChange={(event) =>
        onChange(
          definition?.type === "number"
            ? event.target.value === ""
              ? null
              : Number(event.target.value)
            : event.target.value,
        )
      }
    />
  );
}

/** Field while a journey input reference is half built (no name yet). */
const TRIGGER_INPUT_DRAFT = "__input__";

/** A field that isn't fully chosen yet, so it has no operators. */
function isDraftField(field: string): boolean {
  return field === STEP_FIELD_DRAFT || field === TRIGGER_INPUT_DRAFT;
}

/**
 * Picks a readable field: a lead/opportunity/event field, an earlier step's
 * output, or (in journeys started by another journey) one of its inputs.
 * `onSelect` fires when the dropdown changes; `onReference` when the step,
 * output, or input name of a reference is edited.
 */
function FieldSource({
  idPrefix,
  field,
  label,
  placeholder,
  onSelect,
  onReference,
  stepOptions,
  triggerEvent,
  allowSteps,
  inCondition,
  stepsOnly = false,
}: {
  idPrefix: string;
  field: string;
  label: string;
  placeholder: string;
  onSelect: (field: string) => void;
  onReference: (field: string) => void;
  stepOptions: StepOption[];
  triggerEvent: TriggerEventType | null;
  allowSteps: boolean;
  inCondition: boolean;
  /** Only a step output can be chosen (a journey's declared results). */
  stepsOnly?: boolean;
}) {
  const savedReference = stepReferenceDraft(field);
  const isStepField = Boolean(savedReference) || field === STEP_FIELD_DRAFT || stepsOnly;
  const savedInput = TRIGGER_INPUT_FIELD_PATTERN.exec(field)?.[1] ?? null;
  const isInputField = savedInput !== null || field === TRIGGER_INPUT_DRAFT;
  const allowInputs = triggerEvent === "journey.started";

  // Holds the half-built reference: the stored field is only a full path once step and output are both set.
  const [pendingReference, setPendingReference] = useState<StepReferenceDraft>(savedReference ?? EMPTY_STEP_REFERENCE);
  const reference = savedReference ?? pendingReference;
  const selectedStep =
    stepOptions.find((option) => option.key === reference.key || option.legacyKey === reference.key) ?? null;
  const [pendingInput, setPendingInput] = useState(savedInput ?? "");

  const editReference = (patch: Partial<StepReferenceDraft>) => {
    const knownFields =
      patch.key !== undefined ? (stepOptions.find((option) => option.key === patch.key)?.outputs ?? null) : null;
    const next = updateStepReferenceDraft(reference, patch, knownFields);
    setPendingReference(next);
    onReference(stepReferenceField(next));
  };

  return (
    <>
      <div className={shell.field} hidden={stepsOnly}>
        <label className={shell.label} htmlFor={`${idPrefix}-field`}>
          {label}
        </label>
        <DropdownSelect
          id={`${idPrefix}-field`}
          value={isStepField ? STEP_FIELD_DRAFT : isInputField ? TRIGGER_INPUT_DRAFT : field}
          placeholder={placeholder}
          onChange={(next) => {
            if (next === STEP_FIELD_DRAFT) setPendingReference(EMPTY_STEP_REFERENCE);
            if (next === TRIGGER_INPUT_DRAFT) setPendingInput("");
            onSelect(next);
          }}
          options={[
            ...fieldsFor(triggerEvent, true, inCondition).map(([key, def]) => ({
              value: key,
              label: `${key.startsWith("opportunity.") ? "Opportunity: " : key.startsWith("trigger.") ? "Event: " : ""}${def.label}`,
            })),
            ...(allowSteps && stepOptions.length > 0
              ? [{ value: STEP_FIELD_DRAFT, label: "Output of an earlier step…" }]
              : []),
            ...(allowInputs ? [{ value: TRIGGER_INPUT_DRAFT, label: "Input from the starting journey…" }] : []),
          ]}
        />
      </div>

      {isInputField ? (
        <div className={shell.field}>
          <label className={shell.label} htmlFor={`${idPrefix}-input`}>
            Input name
          </label>
          <input
            id={`${idPrefix}-input`}
            className={shell.input}
            placeholder="e.g. budget"
            value={savedInput ?? pendingInput}
            onChange={(event) => {
              const name = sanitizeOutputField(event.target.value);
              setPendingInput(name);
              onReference(INPUT_NAME_PATTERN.test(name) ? `trigger.inputs.${name}` : TRIGGER_INPUT_DRAFT);
            }}
          />
        </div>
      ) : null}

      {isStepField ? (
        <div className={shell.fieldRow}>
          <div className={shell.field}>
            <label className={shell.label} htmlFor={`${idPrefix}-step`}>
              Step
            </label>
            <DropdownSelect
              id={`${idPrefix}-step`}
              value={selectedStep?.key ?? ""}
              placeholder="Choose…"
              onChange={(key) => editReference({ key })}
              options={stepOptions.map((option) => ({ value: option.key, label: option.label }))}
            />
          </div>
          <div className={shell.field}>
            <label className={shell.label} htmlFor={`${idPrefix}-output`}>
              Output field
            </label>
            {selectedStep?.outputs ? (
              <DropdownSelect
                id={`${idPrefix}-output`}
                value={reference.field}
                placeholder="Choose…"
                onChange={(field) => editReference({ field })}
                options={selectedStep.outputs.map((name) => ({
                  value: name,
                  label: name === AI_TEXT_KEY ? `${name} (AI explanation)` : name,
                }))}
              />
            ) : (
              <input
                id={`${idPrefix}-output`}
                className={shell.input}
                placeholder="e.g. result"
                value={reference.field}
                onChange={(event) => editReference({ field: event.target.value })}
              />
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function RuleEditor({
  idPrefix,
  rule,
  onChange,
  stepOptions,
  triggerEvent,
  allowSteps,
}: {
  idPrefix: string;
  rule: ConditionRule;
  onChange: (rule: ConditionRule) => void;
  stepOptions: StepOption[];
  triggerEvent: TriggerEventType | null;
  allowSteps: boolean;
}) {
  const definition = Object.hasOwn(CONDITION_FIELDS, rule.field) ? CONDITION_FIELDS[rule.field] : null;
  const operators = rule.field && !isDraftField(rule.field) ? operatorsForField(rule.field) : [];
  const needsValue = CONDITION_OPERATORS[rule.operator]?.needsValue ?? true;

  return (
    <div className={styles.configRule}>
      <FieldSource
        idPrefix={idPrefix}
        field={rule.field}
        label="Field"
        placeholder="Choose a field…"
        onSelect={(field) => {
          const allowed = field && !isDraftField(field) ? operatorsForField(field) : [];
          onChange({
            field,
            operator: allowed.includes(rule.operator) ? rule.operator : (allowed[0] ?? "equals"),
            value: null,
          });
        }}
        onReference={(field) => onChange({ ...rule, field })}
        stepOptions={stepOptions}
        triggerEvent={triggerEvent}
        allowSteps={allowSteps}
        inCondition={allowSteps}
      />

      <div className={shell.field}>
        <label className={shell.label} htmlFor={`${idPrefix}-operator`}>
          Operator
        </label>
        <DropdownSelect
          id={`${idPrefix}-operator`}
          value={rule.operator}
          disabled={operators.length === 0}
          onChange={(operator) => onChange({ ...rule, operator: operator as ConditionRule["operator"] })}
          options={(operators.length ? operators : (["equals"] as const)).map((operator) => ({
            value: operator,
            label: CONDITION_OPERATORS[operator].label,
          }))}
        />
      </div>

      {needsValue ? (
        <div className={shell.field}>
          <label className={shell.label} htmlFor={`${idPrefix}-value`}>
            Value
          </label>
          <ValueInput
            id={`${idPrefix}-value`}
            definition={definition}
            value={rule.value}
            onChange={(value) => onChange({ ...rule, value })}
          />
        </div>
      ) : null}
    </div>
  );
}

function toRule(raw: unknown): ConditionRule {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    field: str(input.field),
    operator: (input.operator as ConditionRule["operator"]) ?? "equals",
    value: (input.value as ConditionRule["value"]) ?? null,
  };
}

const EMPTY_RULE: ConditionRule = { field: "", operator: "equals", value: null };

/** One rule saves flat (the legacy shape); two or more save as { logic, rules }. */
function ConditionEditor({
  idPrefix,
  config,
  onChange,
  stepOptions,
  triggerEvent,
}: {
  idPrefix: string;
  config: JourneyNodeConfig;
  onChange: (config: JourneyNodeConfig) => void;
  stepOptions: StepOption[];
  triggerEvent: TriggerEventType | null;
}) {
  const multi = Array.isArray(config.rules);
  const rules = multi ? (config.rules as unknown[]).map(toRule) : [toRule(config)];
  const logic: ConditionLogic = isConditionLogic(config.logic) ? config.logic : "all";

  // Stable row keys: RuleEditor keeps a half-built step reference in local state, so rows can't be keyed by index.
  const rowKeys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (rowKeys.current.length < rules.length) rowKeys.current.push(nextKey.current++);
  if (rowKeys.current.length > rules.length) rowKeys.current.length = rules.length;

  const save = (nextRules: ConditionRule[], nextLogic: ConditionLogic = logic) =>
    onChange(nextRules.length === 1 ? { ...nextRules[0] } : { logic: nextLogic, rules: nextRules });
  const remove = (index: number) => {
    rowKeys.current.splice(index, 1);
    save(rules.filter((_, i) => i !== index));
  };
  const addRule =
    rules.length < MAX_CONDITION_RULES ? (
      <button
        type="button"
        className={`${shell.btnSecondary} ${shell.btnPill}`}
        onClick={() => save([...rules, { ...EMPTY_RULE }])}
      >
        Add rule
      </button>
    ) : null;
  const hint = <p className={shell.fieldHint}>True continues on the Yes path (right); false on the No path (bottom).</p>;

  if (rules.length <= 1) {
    return (
      <>
        <RuleEditor
          idPrefix={idPrefix}
          rule={rules[0] ?? { ...EMPTY_RULE }}
          onChange={(next) => onChange({ ...next })}
          stepOptions={stepOptions}
          triggerEvent={triggerEvent}
          allowSteps
        />
        {addRule}
        {hint}
      </>
    );
  }

  return (
    <>
      <div className={shell.field}>
        <label className={shell.label} htmlFor={`${idPrefix}-logic`}>
          Match
        </label>
        <DropdownSelect
          id={`${idPrefix}-logic`}
          value={logic}
          onChange={(next) => save(rules, next === "any" ? "any" : "all")}
          options={[
            { value: "all", label: "ALL rules" },
            { value: "any", label: "ANY rule" },
          ]}
        />
      </div>
      {rules.map((rule, index) => (
        <div key={rowKeys.current[index]} className={styles.configGroup}>
          <div className={styles.configGroupHeader}>
            <span>{index === 0 ? "If" : logic === "any" ? "Or" : "And"}</span>
            <button type="button" className={styles.configLink} onClick={() => remove(index)}>
              Remove
            </button>
          </div>
          <RuleEditor
            idPrefix={`${idPrefix}-${rowKeys.current[index]}`}
            rule={rule}
            onChange={(next) => save(rules.map((entry, i) => (i === index ? next : entry)))}
            stepOptions={stepOptions}
            triggerEvent={triggerEvent}
            allowSteps
          />
        </div>
      ))}
      {addRule}
      {hint}
    </>
  );
}

function toMapping(raw: unknown): InputMapping {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { target: str(input.target), source: str(input.source) };
}

/** The values a Start journey step passes; nothing else of this journey reaches the started one. */
function InputMappingsEditor({
  idPrefix,
  mappings,
  onChange,
  stepOptions,
  triggerEvent,
}: {
  idPrefix: string;
  mappings: InputMapping[];
  onChange: (mappings: InputMapping[]) => void;
  stepOptions: StepOption[];
  triggerEvent: TriggerEventType | null;
}) {
  // Stable row keys: FieldSource keeps a half-built reference in local state, so rows can't be keyed by index.
  const rowKeys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (rowKeys.current.length < mappings.length) rowKeys.current.push(nextKey.current++);
  if (rowKeys.current.length > mappings.length) rowKeys.current.length = mappings.length;

  const update = (index: number, patch: Partial<InputMapping>) =>
    onChange(mappings.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping)));
  const remove = (index: number) => {
    rowKeys.current.splice(index, 1);
    onChange(mappings.filter((_, i) => i !== index));
  };

  return (
    <div className={shell.field}>
      <span className={shell.label}>Values to pass</span>
      {mappings.map((mapping, index) => {
        const rowId = `${idPrefix}-${rowKeys.current[index]}`;
        return (
          <div key={rowKeys.current[index]} className={styles.configGroup}>
            <div className={styles.configGroupHeader}>
              <span>{mapping.target || `Input ${index + 1}`}</span>
              <button type="button" className={styles.configLink} onClick={() => remove(index)}>
                Remove
              </button>
            </div>
            <div className={shell.field}>
              <label className={shell.label} htmlFor={`${rowId}-target`}>
                Name in the started journey
              </label>
              <input
                id={`${rowId}-target`}
                className={shell.input}
                value={mapping.target}
                placeholder="e.g. budget"
                onChange={(event) => update(index, { target: outputFieldName(event.target.value) })}
              />
            </div>
            <FieldSource
              idPrefix={rowId}
              field={mapping.source}
              label="Value"
              placeholder="Choose a value…"
              onSelect={(source) => update(index, { source })}
              onReference={(source) => update(index, { source })}
              stepOptions={stepOptions}
              triggerEvent={triggerEvent}
              allowSteps
              inCondition={false}
            />
          </div>
        );
      })}
      {mappings.length < MAX_INPUT_MAPPINGS ? (
        <button
          type="button"
          className={`${shell.btnSecondary} ${shell.btnPill}`}
          onClick={() => onChange([...mappings, { target: "", source: "" }])}
        >
          Add value
        </button>
      ) : null}
      <p className={shell.fieldHint}>
        Only selected values are passed to the started journey. It reads each one by name with &ldquo;Input from the
        starting journey&rdquo;. A value that&rsquo;s missing when this step runs is passed as empty.
      </p>
    </div>
  );
}

/** Stable row keys: FieldSource keeps a half-built reference in local state, so rows can't be keyed by index. */
function useRowKeys(length: number) {
  const rowKeys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (rowKeys.current.length < length) rowKeys.current.push(nextKey.current++);
  if (rowKeys.current.length > length) rowKeys.current.length = length;
  return rowKeys.current;
}

/** The results this journey returns to a journey that started it and waited: declared here, nowhere else. */
function ResultExportsEditor({
  idPrefix,
  exports,
  onChange,
  stepOptions,
}: {
  idPrefix: string;
  exports: ResultExport[];
  onChange: (exports: ResultExport[]) => void;
  stepOptions: StepOption[];
}) {
  const rowKeys = useRowKeys(exports.length);
  const update = (index: number, patch: Partial<ResultExport>) =>
    onChange(exports.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  return (
    <div className={shell.field}>
      <span className={shell.label}>Results to return</span>
      {exports.map((entry, index) => {
        const rowId = `${idPrefix}-${rowKeys[index]}`;
        return (
          <div key={rowKeys[index]} className={styles.configGroup}>
            <div className={styles.configGroupHeader}>
              <span>{entry.name || `Result ${index + 1}`}</span>
              <button
                type="button"
                className={styles.configLink}
                onClick={() => {
                  rowKeys.splice(index, 1);
                  onChange(exports.filter((_, i) => i !== index));
                }}
              >
                Remove
              </button>
            </div>
            <div className={shell.field}>
              <label className={shell.label} htmlFor={`${rowId}-name`}>
                Result name
              </label>
              <input
                id={`${rowId}-name`}
                className={shell.input}
                value={entry.name}
                placeholder="e.g. decision"
                onChange={(event) => update(index, { name: outputFieldName(event.target.value) })}
              />
            </div>
            <FieldSource
              idPrefix={rowId}
              field={entry.source}
              label="Value"
              placeholder="Choose a step output…"
              onSelect={(source) => update(index, { source })}
              onReference={(source) => update(index, { source })}
              stepOptions={stepOptions}
              triggerEvent={null}
              allowSteps
              inCondition={false}
              stepsOnly
            />
          </div>
        );
      })}
      {exports.length < MAX_RESULT_VALUES ? (
        <button
          type="button"
          className={`${shell.btnSecondary} ${shell.btnPill}`}
          onClick={() => onChange([...exports, { name: "", source: "" }])}
        >
          Add result
        </button>
      ) : null}
      <p className={shell.fieldHint}>
        Optional. A journey that starts this one and waits can receive only these values, taken from this run&rsquo;s
        step outputs when it completes. A step that didn&rsquo;t run returns empty. Nothing is returned if the run fails
        or is cancelled.
      </p>
    </div>
  );
}

function toResultMapping(raw: unknown): ResultMapping {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { target: str(input.target), source: str(input.source) };
}

/** The results a waiting Start journey step receives: only names the started journey declares. */
function ResultMappingsEditor({
  idPrefix,
  mappings,
  onChange,
  declared,
}: {
  idPrefix: string;
  mappings: ResultMapping[];
  onChange: (mappings: ResultMapping[]) => void;
  /** Result names the selected journey declares; null when no journey is selected. */
  declared: string[] | null;
}) {
  const update = (index: number, patch: Partial<ResultMapping>) =>
    onChange(mappings.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping)));
  const available = declared ?? [];

  return (
    <div className={shell.field}>
      <span className={shell.label}>Results to receive</span>
      {mappings.map((mapping, index) => {
        const rowId = `${idPrefix}-${index}`;
        const name = mapping.source.replace(/^result\./, "");
        return (
          <div key={index} className={styles.configGroup}>
            <div className={styles.configGroupHeader}>
              <span>{mapping.target || `Result ${index + 1}`}</span>
              <button type="button" className={styles.configLink} onClick={() => onChange(mappings.filter((_, i) => i !== index))}>
                Remove
              </button>
            </div>
            <div className={shell.fieldRow}>
              <div className={shell.field}>
                <label className={shell.label} htmlFor={`${rowId}-source`}>
                  Result
                </label>
                <DropdownSelect
                  id={`${rowId}-source`}
                  value={name}
                  placeholder="Choose…"
                  onChange={(next) => update(index, { source: `result.${next}`, target: mapping.target || next })}
                  options={[...new Set([...available, ...(name ? [name] : [])])].map((option) => ({
                    value: option,
                    label: available.includes(option) ? option : `${option} (not returned)`,
                  }))}
                />
              </div>
              <div className={shell.field}>
                <label className={shell.label} htmlFor={`${rowId}-target`}>
                  Name here
                </label>
                <input
                  id={`${rowId}-target`}
                  className={shell.input}
                  value={mapping.target}
                  placeholder="e.g. decision"
                  onChange={(event) => update(index, { target: outputFieldName(event.target.value) })}
                />
              </div>
            </div>
          </div>
        );
      })}
      {available.length > 0 && mappings.length < MAX_RESULT_VALUES ? (
        <button
          type="button"
          className={`${shell.btnSecondary} ${shell.btnPill}`}
          onClick={() => onChange([...mappings, { target: "", source: "" }])}
        >
          Add result
        </button>
      ) : null}
      <p className={shell.fieldHint}>
        {declared === null
          ? "Choose a journey first."
          : available.length === 0
            ? `That journey doesn't return any results. Only results it declares on its “${TRIGGER_EVENTS["journey.started"].label}” trigger can be returned.`
            : "Only results the started journey declares can be returned, and only when it completes. Read them in a Condition as this step’s output results.<name>; they’re empty if it fails or is cancelled."}
      </p>
    </div>
  );
}

/** Output field names must work as condition paths, so typing is nudged into snake_case. */
function outputFieldName(value: string): string {
  return value.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 60);
}

function OutputSchemaEditor({
  idPrefix,
  fields,
  onChange,
}: {
  idPrefix: string;
  fields: AIOutputField[];
  onChange: (fields: AIOutputField[]) => void;
}) {
  const update = (index: number, patch: Partial<AIOutputField>) =>
    onChange(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));

  return (
    <div className={shell.field}>
      <span className={shell.label}>Output fields</span>
      {fields.map((field, index) => (
        <div key={index} className={styles.configGroup}>
          <div className={styles.configGroupHeader}>
            <span>{field.name || `Field ${index + 1}`}</span>
            <button
              type="button"
              className={styles.configLink}
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
          <div className={shell.fieldRow}>
            <div className={shell.field}>
              <label className={shell.label} htmlFor={`${idPrefix}-${index}-name`}>
                Name
              </label>
              <input
                id={`${idPrefix}-${index}-name`}
                className={shell.input}
                value={field.name}
                placeholder="e.g. sales_ready"
                onChange={(event) => update(index, { name: outputFieldName(event.target.value) })}
              />
            </div>
            <div className={shell.field}>
              <label className={shell.label} htmlFor={`${idPrefix}-${index}-type`}>
                Type
              </label>
              <DropdownSelect
                id={`${idPrefix}-${index}-type`}
                value={field.type}
                placeholder="Choose…"
                onChange={(type) => update(index, { type: type as AIOutputField["type"] })}
                options={AI_OUTPUT_TYPES.map((type) => ({ value: type, label: type[0].toUpperCase() + type.slice(1) }))}
              />
            </div>
          </div>
          <div className={shell.field}>
            <label className={shell.label} htmlFor={`${idPrefix}-${index}-description`}>
              Description
            </label>
            <input
              id={`${idPrefix}-${index}-description`}
              className={shell.input}
              value={field.description}
              placeholder="Optional, e.g. Readiness score from 0 to 100"
              onChange={(event) => update(index, { description: event.target.value })}
            />
          </div>
        </div>
      ))}
      {fields.length < MAX_AI_OUTPUT_FIELDS ? (
        <button
          type="button"
          className={`${shell.btnSecondary} ${shell.btnPill}`}
          onClick={() => onChange([...fields, { name: "", type: "string", description: "" }])}
        >
          Add output field
        </button>
      ) : null}
      <p className={shell.fieldHint}>
        Optional. With output fields, the AI must return exactly these names and types or the step fails and
        retries. Without them, it names its own fields from your instructions.
      </p>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  multiline,
  hint,
  placeholder,
}: {
  id: string;
  label: string;
  value: unknown;
  onChange: (value: string) => void;
  multiline?: boolean;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <div className={shell.field}>
      <label className={shell.label} htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className={shell.textarea}
          rows={4}
          value={str(value)}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className={shell.input}
          value={str(value)}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint ? <p className={shell.fieldHint}>{hint}</p> : null}
    </div>
  );
}

export function NodeConfigForm({
  nodeId,
  nodeType,
  config,
  onChange,
  agentOptions,
  journeyOptions,
  stepOptions,
  triggerEvent,
}: NodeConfigFormProps) {
  const id = (name: string) => `node-${nodeId}-${name}`;
  const set = (patch: JourneyNodeConfig) => onChange({ ...config, ...patch });
  const issues = validateNodeConfig(nodeType, config, "strict").errors;

  let body: React.ReactNode = null;

  if (nodeType === "trigger") {
    const event = isTriggerEventType(config.event) ? config.event : null;
    const filters = (Array.isArray(config.filters) ? config.filters : []) as ConditionRule[];
    body = (
      <>
        <div className={shell.field}>
          <label className={shell.label} htmlFor={id("event")}>
            Starts when
          </label>
          <DropdownSelect
            id={id("event")}
            value={event ?? ""}
            placeholder="Choose an event…"
            onChange={(next) => {
              const { results: _results, ...rest } = config;
              onChange({ ...(next === "journey.started" ? config : rest), event: next, filters: [] });
            }}
            options={IMPLEMENTED_TRIGGER_EVENTS.map((key) => ({ value: key, label: TRIGGER_EVENTS[key].label }))}
          />
          {event ? <p className={shell.fieldHint}>{TRIGGER_EVENTS[event].description}</p> : null}
        </div>
        {event === "journey.started" ? (
          <ResultExportsEditor
            idPrefix={id("result")}
            exports={(Array.isArray(config.results) ? config.results : []).map((raw) => {
              const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
              return { name: str(entry.name), source: str(entry.source) };
            })}
            onChange={(results) => {
              const { results: _results, ...rest } = config;
              onChange(results.length > 0 ? { ...rest, results } : rest);
            }}
            stepOptions={stepOptions}
          />
        ) : null}
        {filters.map((rule, index) => (
          <div key={index} className={styles.configGroup}>
            <div className={styles.configGroupHeader}>
              <span>Only if</span>
              <button
                type="button"
                className={styles.configLink}
                onClick={() => set({ filters: filters.filter((_, i) => i !== index) })}
              >
                Remove
              </button>
            </div>
            <RuleEditor
              idPrefix={id(`filter-${index}`)}
              rule={rule}
              onChange={(next) => set({ filters: filters.map((entry, i) => (i === index ? next : entry)) })}
              stepOptions={[]}
              triggerEvent={event}
              allowSteps={false}
            />
          </div>
        ))}
        {event && filters.length < 10 ? (
          <button
            type="button"
            className={`${shell.btnSecondary} ${shell.btnPill}`}
            onClick={() => set({ filters: [...filters, { field: "", operator: "equals", value: null }] })}
          >
            Add filter
          </button>
        ) : null}
      </>
    );
  } else if (nodeType === "condition") {
    body = (
      <ConditionEditor
        idPrefix={id("rule")}
        config={config}
        onChange={onChange}
        stepOptions={stepOptions}
        triggerEvent={triggerEvent}
      />
    );
  } else if (nodeType === "ai") {
    body = (
      <>
        <TextField id={id("goal")} label="Goal" value={config.goal} onChange={(goal) => set({ goal })} placeholder="e.g. Qualify the lead's timeline and budget" />
        <TextField
          id={id("instructions")}
          label="Instructions"
          value={config.instructions}
          onChange={(instructions) => set({ instructions })}
          multiline
        />
        <OutputSchemaEditor
          idPrefix={id("output")}
          fields={(Array.isArray(config.outputSchema) ? config.outputSchema : []) as AIOutputField[]}
          onChange={(outputSchema) => set({ outputSchema })}
        />
        <p className={styles.panelNote}>
          The AI reads the lead, their recent conversation, and earlier step results, then returns its
          answer as fields (for example sales_ready or score). Check them in a later condition with
          &ldquo;Output of an earlier step&rdquo;. This step never messages the lead or changes their record.
        </p>
      </>
    );
  } else {
    const action = str(config.action);
    body = (
      <>
        <div className={shell.field}>
          <label className={shell.label} htmlFor={id("action")}>
            Action
          </label>
          <DropdownSelect
            id={id("action")}
            value={action}
            placeholder="Choose an action…"
            onChange={(next) =>
              onChange(
                next === "wait"
                  ? { action: "wait", duration: 1, unit: "days" }
                  : next === "notify_team"
                    ? { action: "notify_team", recipients: "assigned_agent" }
                    : { action: next },
              )
            }
            options={Object.entries(ACTION_TYPES).map(([key, def]) => ({ value: key, label: def.label }))}
          />
          {action in ACTION_TYPES ? (
            <p className={shell.fieldHint}>{ACTION_TYPES[action as keyof typeof ACTION_TYPES].description}</p>
          ) : null}
        </div>

        {action === "send_sms" ? (
          <TextField id={id("body")} label="Message" value={config.body} onChange={(b) => set({ body: b })} multiline hint={`${TOKEN_HINT} Leads who opted out of SMS or have no mobile number fail this step.`} />
        ) : null}

        {action === "send_messenger" ? (
          <TextField id={id("body")} label="Message" value={config.body} onChange={(b) => set({ body: b })} multiline hint={`${TOKEN_HINT} Only leads who have sent your Page a Messenger message can receive this; commenting on a post doesn't count. Others fail this step.`} />
        ) : null}

        {action === "send_instagram" ? (
          <TextField id={id("body")} label="Message" value={config.body} onChange={(b) => set({ body: b })} multiline hint={`${TOKEN_HINT} Only leads who have sent your Instagram account a direct message can receive this; commenting on a post doesn't count. Others fail this step.`} />
        ) : null}

        {action === "send_email" ? (
          <>
            <TextField id={id("subject")} label="Subject" value={config.subject} onChange={(subject) => set({ subject })} />
            <TextField id={id("body")} label="Body" value={config.body} onChange={(b) => set({ body: b })} multiline hint={`${TOKEN_HINT} Sent from REOS on behalf of the lead's agent; replies go to the agent.`} />
          </>
        ) : null}

        {action === "assign_lead" ? (
          <div className={shell.field}>
            <label className={shell.label} htmlFor={id("agent")}>
              Assign to
            </label>
            <DropdownSelect
              id={id("agent")}
              value={str(config.agentUserId)}
              placeholder="Choose a team member…"
              onChange={(agentUserId) => set({ agentUserId })}
              options={agentOptions.map((agent) => ({ value: agent.id, label: agent.label }))}
            />
          </div>
        ) : null}

        {action === "create_task" ? (
          <>
            <TextField id={id("title")} label="Task title" value={config.title} onChange={(title) => set({ title })} hint={TOKEN_HINT} />
            <TextField id={id("notes")} label="Notes" value={config.notes} onChange={(notes) => set({ notes })} multiline />
            <div className={shell.field}>
              <label className={shell.label} htmlFor={id("due")}>
                Due in (days)
              </label>
              <input
                id={id("due")}
                className={shell.input}
                type="number"
                min={0}
                max={365}
                value={config.dueInDays === null || config.dueInDays === undefined ? "" : str(config.dueInDays)}
                placeholder="No due date"
                onChange={(e) => set({ dueInDays: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </div>
          </>
        ) : null}

        {action === "update_lead" ? (
          <>
            {Object.entries(UPDATE_LEAD_FIELDS).map(([key, def]) => {
              const fields = (config.fields && typeof config.fields === "object" ? config.fields : {}) as Record<string, unknown>;
              const setField = (value: string | number | boolean | null) => {
                const next = { ...fields };
                if (value === null || value === "") delete next[key];
                else next[key] = value;
                set({ fields: next });
              };
              return (
                <div key={key} className={shell.field}>
                  <label className={shell.label} htmlFor={id(`field-${key}`)}>
                    {def.label}
                  </label>
                  <ValueInput
                    id={id(`field-${key}`)}
                    definition={def}
                    value={fields[key]}
                    onChange={setField}
                    clearLabel="Don't change"
                  />
                </div>
              );
            })}
            <p className={shell.fieldHint}>Leave a field empty to keep its current value.</p>
          </>
        ) : null}

        {action === "notify_team" ? (
          <>
            <TextField id={id("title")} label="Notification" value={config.title} onChange={(title) => set({ title })} hint={TOKEN_HINT} />
            <TextField id={id("body")} label="Details" value={config.body} onChange={(b) => set({ body: b })} />
            <div className={shell.field}>
              <label className={shell.label} htmlFor={id("recipients")}>
                Send to
              </label>
              <DropdownSelect
                id={id("recipients")}
                value={str(config.recipients) || "assigned_agent"}
                onChange={(recipients) => set({ recipients })}
                options={NOTIFY_RECIPIENTS.map((value) => ({
                  value,
                  label: value === "assigned_agent" ? "The lead's agent" : "Everyone in the workspace",
                }))}
              />
            </div>
          </>
        ) : null}

        {action === "start_journey" ? (
          <>
            <div className={shell.field}>
              <label className={shell.label} htmlFor={id("journey")}>
                Journey to start
              </label>
              <DropdownSelect
                id={id("journey")}
                value={str(config.journeyId)}
                placeholder="Choose a journey…"
                onChange={(journeyId) => set({ journeyId })}
                options={journeyOptions.map((journey) => ({ value: journey.id, label: journey.label }))}
              />
              <p className={shell.fieldHint}>
                That journey needs the &ldquo;{TRIGGER_EVENTS["journey.started"].label}&rdquo; trigger and must be active.
                Otherwise, or if the lead is already in it, this step is skipped and this journey continues.
              </p>
            </div>
            <div className={shell.field}>
              <label className={shell.label} htmlFor={id("wait")}>
                Then
              </label>
              <DropdownSelect
                id={id("wait")}
                value={config.waitForCompletion === true ? "wait" : "continue"}
                onChange={(next) => {
                  const { waitForCompletion: _previous, resultMappings: _results, ...rest } = config;
                  onChange(next === "wait" ? { ...rest, waitForCompletion: true } : rest);
                }}
                options={[
                  { value: "continue", label: "Continue right away" },
                  { value: "wait", label: "Wait for this journey to finish" },
                ]}
              />
              {config.waitForCompletion === true ? (
                <p className={shell.fieldHint}>
                  This journey pauses here until the started run completes, fails, or is cancelled, then continues
                  either way. To branch on how it ended, add a Condition using this step&rsquo;s output field
                  child_status (completed, failed, or cancelled).
                </p>
              ) : null}
            </div>
            {config.waitForCompletion === true ? (
              <ResultMappingsEditor
                idPrefix={id("received")}
                mappings={(Array.isArray(config.resultMappings) ? config.resultMappings : []).map(toResultMapping)}
                onChange={(resultMappings) => {
                  const { resultMappings: _previous, ...rest } = config;
                  onChange(resultMappings.length > 0 ? { ...rest, resultMappings } : rest);
                }}
                declared={str(config.journeyId) ? (journeyOptions.find((journey) => journey.id === config.journeyId)?.results ?? []) : null}
              />
            ) : null}
            <InputMappingsEditor
              idPrefix={id("input")}
              mappings={(Array.isArray(config.inputMappings) ? config.inputMappings : []).map(toMapping)}
              onChange={(inputMappings) => set({ inputMappings })}
              stepOptions={stepOptions}
              triggerEvent={triggerEvent}
            />
          </>
        ) : null}

        {action === "wait" ? (
          <div className={shell.fieldRow}>
            <div className={shell.field}>
              <label className={shell.label} htmlFor={id("duration")}>
                Wait
              </label>
              <input id={id("duration")} className={shell.input} type="number" min={1} value={str(config.duration)} onChange={(e) => set({ duration: e.target.value === "" ? "" : Number(e.target.value) })} />
            </div>
            <div className={shell.field}>
              <label className={shell.label} htmlFor={id("unit")}>
                Unit
              </label>
              <DropdownSelect
                id={id("unit")}
                value={str(config.unit) || "days"}
                onChange={(unit) => set({ unit })}
                options={WAIT_UNITS.map((unit) => ({ value: unit, label: unit[0].toUpperCase() + unit.slice(1) }))}
              />
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={styles.configSection}>
      <h3 className={styles.configHeading}>Settings</h3>
      {body}
      {issues.length > 0 ? (
        <ul className={styles.configIssues} aria-label="Needed before activation">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
