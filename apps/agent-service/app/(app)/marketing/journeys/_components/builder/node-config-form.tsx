"use client";

import { useState } from "react";
import {
  ACTION_TYPES,
  AI_OUTPUT_TYPES,
  AI_TEXT_KEY,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  EMPTY_STEP_REFERENCE,
  IMPLEMENTED_TRIGGER_EVENTS,
  MAX_AI_OUTPUT_FIELDS,
  NOTIFY_RECIPIENTS,
  STEP_FIELD_DRAFT,
  TEMPLATE_TOKENS,
  TRIGGER_EVENTS,
  UPDATE_LEAD_FIELDS,
  WAIT_UNITS,
  isTriggerEventType,
  operatorsForField,
  stepReferenceDraft,
  stepReferenceField,
  updateStepReferenceDraft,
  validateNodeConfig,
  type AIOutputField,
  type ConditionRule,
  type FieldDefinition,
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

interface NodeConfigFormProps {
  nodeId: string;
  nodeType: JourneyNodeType;
  config: JourneyNodeConfig;
  onChange: (config: JourneyNodeConfig) => void;
  agentOptions: { id: string; label: string }[];
  /** Steps guaranteed to run before this condition, whose output it can read. */
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
  const savedReference = stepReferenceDraft(rule.field);
  const isStepField = Boolean(savedReference) || rule.field === STEP_FIELD_DRAFT;
  const definition = Object.hasOwn(CONDITION_FIELDS, rule.field) ? CONDITION_FIELDS[rule.field] : null;
  const operators = rule.field && rule.field !== STEP_FIELD_DRAFT ? operatorsForField(rule.field) : [];
  const needsValue = CONDITION_OPERATORS[rule.operator]?.needsValue ?? true;

  // Holds the half-built reference: the stored field is only a full path once step and output are both set.
  const [pendingReference, setPendingReference] = useState<StepReferenceDraft>(savedReference ?? EMPTY_STEP_REFERENCE);
  const reference = savedReference ?? pendingReference;
  const selectedStep =
    stepOptions.find((option) => option.key === reference.key || option.legacyKey === reference.key) ?? null;

  const editReference = (patch: Partial<StepReferenceDraft>) => {
    const knownFields =
      patch.key !== undefined ? (stepOptions.find((option) => option.key === patch.key)?.outputs ?? null) : null;
    const next = updateStepReferenceDraft(reference, patch, knownFields);
    setPendingReference(next);
    onChange({ ...rule, field: stepReferenceField(next) });
  };

  return (
    <div className={styles.configRule}>
      <div className={shell.field}>
        <label className={shell.label} htmlFor={`${idPrefix}-field`}>
          Field
        </label>
        <DropdownSelect
          id={`${idPrefix}-field`}
          value={isStepField ? STEP_FIELD_DRAFT : rule.field}
          placeholder="Choose a field…"
          onChange={(field) => {
            if (field === STEP_FIELD_DRAFT) setPendingReference(EMPTY_STEP_REFERENCE);
            const allowed = field && field !== STEP_FIELD_DRAFT ? operatorsForField(field) : [];
            onChange({
              field,
              operator: allowed.includes(rule.operator) ? rule.operator : (allowed[0] ?? "equals"),
              value: null,
            });
          }}
          options={[
            ...fieldsFor(triggerEvent, true, allowSteps).map(([key, def]) => ({
              value: key,
              label: `${key.startsWith("opportunity.") ? "Opportunity: " : key.startsWith("trigger.") ? "Event: " : ""}${def.label}`,
            })),
            ...(allowSteps && stepOptions.length > 0
              ? [{ value: STEP_FIELD_DRAFT, label: "Output of an earlier step…" }]
              : []),
          ]}
        />
      </div>

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
            onChange={(next) => set({ event: next, filters: [] })}
            options={IMPLEMENTED_TRIGGER_EVENTS.map((key) => ({ value: key, label: TRIGGER_EVENTS[key].label }))}
          />
          {event ? <p className={shell.fieldHint}>{TRIGGER_EVENTS[event].description}</p> : null}
        </div>
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
    const rule: ConditionRule = {
      field: str(config.field),
      operator: (config.operator as ConditionRule["operator"]) ?? "equals",
      value: (config.value as ConditionRule["value"]) ?? null,
    };
    body = (
      <>
        <RuleEditor
          idPrefix={id("rule")}
          rule={rule}
          onChange={(next) => onChange({ ...next })}
          stepOptions={stepOptions}
          triggerEvent={triggerEvent}
          allowSteps
        />
        <p className={shell.fieldHint}>True continues on the Yes path (right); false on the No path (bottom).</p>
      </>
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
