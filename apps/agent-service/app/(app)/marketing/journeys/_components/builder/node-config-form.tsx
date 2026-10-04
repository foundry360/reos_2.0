"use client";

import {
  ACTION_TYPES,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  NOTIFY_RECIPIENTS,
  STEP_FIELD_PATTERN,
  TEMPLATE_TOKENS,
  TRIGGER_EVENTS,
  UPDATE_LEAD_FIELDS,
  WAIT_UNITS,
  isTriggerEventType,
  operatorsForField,
  validateNodeConfig,
  type ConditionRule,
  type FieldDefinition,
  type TriggerEventType,
} from "@/lib/journeys/runtime/contracts";
import type { JourneyNodeConfig, JourneyNodeType } from "@/lib/journeys/journey-types";
import shell from "@/components/shell/shell.module.css";
import styles from "../journeys.module.css";

export interface StepOption {
  key: string;
  label: string;
}

interface NodeConfigFormProps {
  nodeId: string;
  nodeType: JourneyNodeType;
  config: JourneyNodeConfig;
  onChange: (config: JourneyNodeConfig) => void;
  agentOptions: { id: string; label: string }[];
  /** Other steps whose output a condition can read. */
  stepOptions: StepOption[];
  /** The journey's trigger event, so conditions can offer trigger fields. */
  triggerEvent: TriggerEventType | null;
}

const STEP_FIELD = "__step__";
const TOKEN_HINT = `Personalize with ${TEMPLATE_TOKENS.map((token) => `{{${token}}}`).join(", ")}.`;

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function fieldsFor(event: TriggerEventType | null, includeTrigger: boolean) {
  return Object.entries(CONDITION_FIELDS).filter(([key, def]) => {
    if (!key.startsWith("trigger.")) return true;
    return includeTrigger && (!def.events || (event !== null && def.events.includes(event)));
  });
}

function ValueInput({
  id,
  definition,
  value,
  onChange,
}: {
  id: string;
  definition: FieldDefinition | null;
  value: unknown;
  onChange: (value: string | number | boolean | null) => void;
}) {
  if (definition?.type === "boolean") {
    return (
      <select
        id={id}
        className={shell.select}
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value === "true")}
      >
        <option value="">Choose…</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (definition?.type === "enum" && definition.options) {
    return (
      <select id={id} className={shell.select} value={str(value)} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Choose…</option>
        {definition.options.map((option) => (
          <option key={option} value={option}>
            {option.replace(/_/g, " ")}
          </option>
        ))}
      </select>
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
  const stepMatch = STEP_FIELD_PATTERN.exec(rule.field);
  const isStepField = Boolean(stepMatch) || rule.field === STEP_FIELD;
  const definition = Object.hasOwn(CONDITION_FIELDS, rule.field) ? CONDITION_FIELDS[rule.field] : null;
  const operators = rule.field && rule.field !== STEP_FIELD ? operatorsForField(rule.field) : [];
  const needsValue = CONDITION_OPERATORS[rule.operator]?.needsValue ?? true;

  const setStepPath = (key: string, field: string) => {
    const cleanField = field.toLowerCase().replace(/[^a-z0-9_]/g, "");
    onChange({ ...rule, field: key && cleanField ? `steps.${key}.output.${cleanField}` : STEP_FIELD });
  };

  return (
    <div className={styles.configRule}>
      <div className={shell.field}>
        <label className={shell.label} htmlFor={`${idPrefix}-field`}>
          Field
        </label>
        <select
          id={`${idPrefix}-field`}
          className={shell.select}
          value={isStepField ? STEP_FIELD : rule.field}
          onChange={(event) => {
            const field = event.target.value;
            const allowed = field && field !== STEP_FIELD ? operatorsForField(field) : [];
            onChange({
              field,
              operator: allowed.includes(rule.operator) ? rule.operator : (allowed[0] ?? "equals"),
              value: null,
            });
          }}
        >
          <option value="">Choose a field…</option>
          {fieldsFor(triggerEvent, true).map(([key, def]) => (
            <option key={key} value={key}>
              {key.startsWith("opportunity.") ? "Opportunity: " : key.startsWith("trigger.") ? "Event: " : ""}
              {def.label}
            </option>
          ))}
          {allowSteps && stepOptions.length > 0 ? <option value={STEP_FIELD}>Output of an earlier step…</option> : null}
        </select>
      </div>

      {isStepField ? (
        <div className={shell.fieldRow}>
          <div className={shell.field}>
            <label className={shell.label} htmlFor={`${idPrefix}-step`}>
              Step
            </label>
            <select
              id={`${idPrefix}-step`}
              className={shell.select}
              value={stepMatch?.[1] ?? ""}
              onChange={(event) => setStepPath(event.target.value, stepMatch?.[2] ?? "")}
            >
              <option value="">Choose…</option>
              {stepOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className={shell.field}>
            <label className={shell.label} htmlFor={`${idPrefix}-output`}>
              Output field
            </label>
            <input
              id={`${idPrefix}-output`}
              className={shell.input}
              placeholder="e.g. result"
              defaultValue={stepMatch?.[2] ?? ""}
              onBlur={(event) => setStepPath(stepMatch?.[1] ?? "", event.target.value)}
            />
          </div>
        </div>
      ) : null}

      <div className={shell.field}>
        <label className={shell.label} htmlFor={`${idPrefix}-operator`}>
          Operator
        </label>
        <select
          id={`${idPrefix}-operator`}
          className={shell.select}
          value={rule.operator}
          disabled={operators.length === 0}
          onChange={(event) => onChange({ ...rule, operator: event.target.value as ConditionRule["operator"] })}
        >
          {(operators.length ? operators : (["equals"] as const)).map((operator) => (
            <option key={operator} value={operator}>
              {CONDITION_OPERATORS[operator].label}
            </option>
          ))}
        </select>
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
          <select
            id={id("event")}
            className={shell.select}
            value={event ?? ""}
            onChange={(e) => set({ event: e.target.value, filters: [] })}
          >
            <option value="">Choose an event…</option>
            {(Object.keys(TRIGGER_EVENTS) as TriggerEventType[]).map((key) => (
              <option key={key} value={key} disabled={!TRIGGER_EVENTS[key].implemented}>
                {TRIGGER_EVENTS[key].label}
                {TRIGGER_EVENTS[key].implemented ? "" : " (coming soon)"}
              </option>
            ))}
          </select>
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
        <p className={styles.panelNote}>
          No AI agent is connected to journeys yet, so this step is recorded as skipped and the journey
          continues.
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
          <select
            id={id("action")}
            className={shell.select}
            value={action}
            onChange={(e) =>
              onChange(
                e.target.value === "wait"
                  ? { action: "wait", duration: 1, unit: "days" }
                  : e.target.value === "notify_team"
                    ? { action: "notify_team", recipients: "assigned_agent" }
                    : { action: e.target.value },
              )
            }
          >
            <option value="">Choose an action…</option>
            {Object.entries(ACTION_TYPES).map(([key, def]) => (
              <option key={key} value={key}>
                {def.label}
              </option>
            ))}
          </select>
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
            <select id={id("agent")} className={shell.select} value={str(config.agentUserId)} onChange={(e) => set({ agentUserId: e.target.value })}>
              <option value="">Choose a team member…</option>
              {agentOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
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
                  <ValueInput id={id(`field-${key}`)} definition={def} value={fields[key]} onChange={setField} />
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
              <select id={id("recipients")} className={shell.select} value={str(config.recipients) || "assigned_agent"} onChange={(e) => set({ recipients: e.target.value })}>
                {NOTIFY_RECIPIENTS.map((value) => (
                  <option key={value} value={value}>
                    {value === "assigned_agent" ? "The lead's agent" : "Everyone in the workspace"}
                  </option>
                ))}
              </select>
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
              <select id={id("unit")} className={shell.select} value={str(config.unit) || "days"} onChange={(e) => set({ unit: e.target.value })}>
                {WAIT_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
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
