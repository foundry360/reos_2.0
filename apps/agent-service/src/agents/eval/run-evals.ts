/**
 * Agent conversation evals against an in-memory calendar + CRM (no production writes).
 *
 *   npx tsx --env-file=.env.local src/agents/eval/run-evals.ts --agent v1 --runs 3
 *   npx tsx --env-file=.env.local src/agents/eval/run-evals.ts --agent v2 --model gpt-4o --only later-in-the-day
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  formatSlotLabel,
  parseRequestedStart,
  zonedParts,
} from "@/lib/calendar/consult-slots";
import { bookingWindowsFor, normalizeWorkingHours, WEEKDAY_KEYS } from "@/lib/calendar/working-hours";
import type { Schedule } from "@/lib/calendar/calendar-core";
import type { ContactContext } from "@/lib/coordinator";
import type { PostContext } from "@/lib/meta/post-context";
import { SandboxBackend } from "@/lib/agent/sandbox-backend";
import type { AgentBackend } from "@/lib/agent/backend";
import { getOpenAIModel } from "@/lib/admin/platform-credentials";
import { resetUsage, usageSnapshot } from "@/lib/llm/usage-meter";
import {
  expectationFailures,
  extractClockTimes,
  invariantFailures,
  type TurnExpect,
} from "./assertions";

type Row = [string, string];

interface Scenario {
  id: string;
  about: string;
  now?: string;
  channel?: "sms" | "messenger" | "instagram";
  contact?: Partial<Record<keyof ContactContext, unknown>>;
  phoneOnFile?: boolean;
  property?: string;
  history?: Row[];
  offered?: { kind: "consult" | "showing"; slots: string[]; text: string };
  busy?: Row[];
  upcoming?: Array<[string, string, string?]>;
  turns: Array<{ user: string; expect: TurnExpect }>;
}

interface Shared {
  defaults: {
    now: string;
    channel: "sms" | "messenger" | "instagram";
    timeZone: string;
    workingHours: unknown;
    contact: Partial<ContactContext>;
  };
  properties: Record<string, PostContext>;
}

export type EvalAgent = (args: {
  ctx: ContactContext;
  body: string;
  channel: "sms" | "messenger" | "instagram";
  backend: AgentBackend;
  model?: string;
}) => Promise<{ reply: string }>;

const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-6.1-sol": { input: 2, output: 10 },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SCENARIO_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "scenarios");

function loadScenarios(): { shared: Shared; scenarios: Scenario[] } {
  const shared = JSON.parse(readFileSync(path.join(SCENARIO_DIR, "_shared.json"), "utf8")) as Shared;
  const scenarios = readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort()
    .flatMap((f) => (JSON.parse(readFileSync(path.join(SCENARIO_DIR, f), "utf8")) as { scenarios: Scenario[] }).scenarios);
  return { shared, scenarios };
}

function localKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function localMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

function workingTimeSet(schedule: Schedule): Set<number> {
  const out = new Set<number>();
  for (const day of WEEKDAY_KEYS) {
    for (const kind of ["consult", "showing"] as const) {
      for (const win of bookingWindowsFor(schedule.workingHours, day, kind)) {
        for (let m = win.startMinute; m <= win.endMinute; m += 30) out.add(m);
        out.add(win.endMinute);
      }
    }
  }
  return out;
}

function buildContact(shared: Shared, scenario: Scenario): ContactContext {
  const merged: Record<string, unknown> = {
    contactId: "sandbox-contact",
    accountId: "eval-tenant",
    phone: "eval-thread",
    leadStatus: "New",
    readyToBook: false,
    apptBooked: false,
    handoff: false,
    optedOut: false,
    ...shared.defaults.contact,
    ...scenario.contact,
  };
  for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
  return merged as unknown as ContactContext;
}

interface TurnResult {
  user: string;
  reply: string;
  failures: string[];
  calendarReads: number;
  bookings: string[];
  toolEvents?: unknown[];
}

async function runScenario(
  shared: Shared,
  scenario: Scenario,
  agent: EvalAgent,
  model: string | undefined,
): Promise<{ id: string; passed: boolean; turns: TurnResult[]; error?: string }> {
  const timeZone = shared.defaults.timeZone;
  const schedule: Schedule = { timeZone, workingHours: normalizeWorkingHours(shared.defaults.workingHours) };
  const now = new Date(scenario.now ?? shared.defaults.now);
  const toDate = (local: string) => {
    const d = parseRequestedStart(local, timeZone, now);
    if (!d) throw new Error(`${scenario.id}: bad local time ${local}`);
    return d;
  };

  const upcoming = (scenario.upcoming ?? []).map(([s, e, title]) => ({
    start: toDate(s).toISOString(),
    end: toDate(e).toISOString(),
    title: title ?? null,
  }));
  const backend = new SandboxBackend(buildContact(shared, scenario), {
    now,
    schedule,
    busy: (scenario.busy ?? []).map(([s, e]) => ({ start: toDate(s).getTime(), end: toDate(e).getTime() })),
    upcoming,
    phoneOnFile: scenario.phoneOnFile ?? (scenario.channel ?? shared.defaults.channel) === "sms",
    property: scenario.property ? shared.properties[scenario.property] : null,
  });

  const knownTimes = new Set<number>(workingBoundaries(schedule));
  for (const appt of upcoming) knownTimes.add(localMinutes(new Date(appt.start), timeZone));
  const openHouse = scenario.property ? shared.properties[scenario.property]?.property?.openHouse : null;
  for (const t of extractClockTimes(openHouse ?? "")) knownTimes.add(t);
  for (const [role, content] of scenario.history ?? []) {
    backend.seedMessage(role === "assistant" ? "assistant" : "user", content);
    for (const t of extractClockTimes(content)) knownTimes.add(t);
  }
  if (scenario.offered) {
    const slots = scenario.offered.slots.map((s) => {
      const start = toDate(s);
      knownTimes.add(localMinutes(start, timeZone));
      return { label: formatSlotLabel(start.toISOString(), timeZone), start: s };
    });
    await backend.recordTurn({
      contactId: "sandbox-contact",
      model: "seed",
      reply: scenario.offered.text,
      toolEvents: [
        {
          name: "find_open_times",
          args: { kind: scenario.offered.kind },
          result: { ok: true, kind: scenario.offered.kind, slots },
        },
      ],
    });
    backend.seedMessage("assistant", scenario.offered.text);
  }

  const workingTimes = workingTimeSet(schedule);
  const channel = scenario.channel ?? shared.defaults.channel;
  const turns: TurnResult[] = [];
  let passed = true;

  for (const turn of scenario.turns) {
    for (const t of extractClockTimes(turn.user)) knownTimes.add(t);
    const before = {
      hadAppointment: backend.bookings.length > 0 || upcoming.length > 0,
      contactInfoOnFile: Boolean(backend.contact.email?.trim()) && backend.phoneOnFile,
      bookingCount: backend.bookings.length,
      rescheduleCount: backend.reschedules.length,
    };
    backend.startTurn();
    const turnsBefore = backend.turns.length;
    let reply = "";
    try {
      reply = (await agent({ ctx: backend.contact, body: turn.user, channel, backend, model })).reply;
    } catch (error) {
      reply = "";
      turns.push({
        user: turn.user,
        reply: "",
        failures: [`agent threw: ${error instanceof Error ? error.message : String(error)}`],
        calendarReads: backend.turnStats.calendarReads,
        bookings: [],
      });
      passed = false;
      break;
    }
    const newBookings = backend.bookings.slice(before.bookingCount);
    const bookedLocal = newBookings.map((b) => localKey(new Date(b.start), timeZone));
    const newMoves = backend.reschedules.slice(before.rescheduleCount);
    const rescheduledLocal = newMoves.map((m) => localKey(new Date(m.to), timeZone));
    // Times a tool returned this turn are calendar-backed even if the reply mentions them later.
    const toolEvents = backend.turns.slice(turnsBefore).flatMap((t) => t.toolEvents);
    const toolTimes = toolEvents.flatMap((e) => extractClockTimes(JSON.stringify(e.result)));
    const replyTimesFromTools = new Set(toolTimes);
    const obs = {
      reply,
      calendarReads: backend.turnStats.calendarReads,
      bookingsMade: newBookings.length,
      bookedLocal,
      rescheduledLocal,
      contactEmail: backend.contact.email,
      contactFields: { ...backend.contact } as Record<string, unknown>,
      optedOut: backend.contact.optedOut,
      apptBookedFlag: backend.contact.apptBooked,
      totalBookings: backend.bookings.length,
      hadAppointmentBefore: before.hadAppointment,
      contactInfoOnFileBefore: before.contactInfoOnFile,
      knownTimes: new Set([...knownTimes, ...replyTimesFromTools]),
      workingTimes,
    };
    const failures = [...invariantFailures(obs, turn.expect), ...expectationFailures(obs, turn.expect)];
    for (const t of toolTimes) knownTimes.add(t);
    if (obs.calendarReads > 0) for (const t of extractClockTimes(reply)) knownTimes.add(t);
    for (const b of newBookings) knownTimes.add(localMinutes(new Date(b.start), timeZone));
    for (const m of newMoves) knownTimes.add(localMinutes(new Date(m.to), timeZone));
    turns.push({
      user: turn.user,
      reply,
      failures,
      calendarReads: obs.calendarReads,
      bookings: bookedLocal,
      toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
    });
    if (failures.length > 0) passed = false;
  }

  return { id: scenario.id, passed, turns };
}

function workingBoundaries(schedule: Schedule): number[] {
  const out: number[] = [];
  for (const day of WEEKDAY_KEYS) {
    for (const range of schedule.workingHours.days[day] ?? []) {
      for (const value of [range.start, range.end]) {
        const [h, m] = value.split(":").map(Number);
        out.push(h * 60 + m);
      }
    }
  }
  return out;
}

async function loadAgent(name: string): Promise<EvalAgent> {
  if (name === "v1") {
    const { runInboundAgent } = await import("@/lib/run-inbound-agent");
    return (args) => runInboundAgent(args);
  }
  const { runLeadAgent } = await import("@/lib/agent/run-lead-agent");
  return (args) => runLeadAgent(args);
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function main() {
  const agentName = arg("agent") ?? "v2";
  const model = arg("model");
  const runs = Number(arg("runs") ?? 1);
  const only = arg("only")?.split(",");
  const concurrency = Number(arg("concurrency") ?? 6);
  const verbose = process.argv.includes("--verbose");

  const { shared, scenarios: all } = loadScenarios();
  const scenarios = only ? all.filter((s) => only.includes(s.id)) : all;
  const agent = await loadAgent(agentName);
  const modelName = model ?? getOpenAIModel();

  resetUsage();
  const jobs = scenarios.flatMap((s) => Array.from({ length: runs }, () => s));
  const started = Date.now();
  const results = await pool(jobs, concurrency, (s) => runScenario(shared, s, agent, model));

  const byScenario = new Map<string, typeof results>();
  for (const r of results) byScenario.set(r.id, [...(byScenario.get(r.id) ?? []), r]);

  console.log(`\nAgent ${agentName} · model ${modelName} · ${scenarios.length} scenarios × ${runs} run(s)\n`);
  for (const [id, rs] of byScenario) {
    const passes = rs.filter((r) => r.passed).length;
    const mark = passes === rs.length ? "PASS" : passes === 0 ? "FAIL" : "FLAKY";
    console.log(`${mark.padEnd(5)} ${id} (${passes}/${rs.length})`);
    const shown = verbose ? rs : rs.filter((r) => !r.passed).slice(0, 1);
    for (const r of shown) {
      for (const t of r.turns) {
        if (!verbose && t.failures.length === 0) continue;
        console.log(`      lead:  ${t.user}`);
        console.log(`      agent: ${t.reply.replace(/\s+/g, " ").slice(0, 240)}`);
        if (t.bookings.length) console.log(`      booked: ${t.bookings.join(", ")}`);
        for (const e of (t.toolEvents ?? []) as Array<{ name: string; args: unknown; result: unknown }>) {
          console.log(`      tool:  ${e.name} ${JSON.stringify(e.args)} -> ${JSON.stringify(e.result).slice(0, 200)}`);
        }
        for (const f of t.failures) console.log(`      ✗ ${f}`);
      }
    }
  }

  const passedRuns = results.filter((r) => r.passed).length;
  const usage = usageSnapshot();
  let cost = 0;
  for (const [m, u] of Object.entries(usage)) {
    const price = PRICES_PER_MTOK[m] ?? PRICES_PER_MTOK[m.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
    if (price) cost += (u.input * price.input + u.output * price.output) / 1_000_000;
  }
  const summary = {
    agent: agentName,
    model: modelName,
    scenarios: scenarios.length,
    runs,
    passRate: passedRuns / results.length,
    scenarioPassRate: [...byScenario.values()].filter((rs) => rs.every((r) => r.passed)).length / byScenario.size,
    usage,
    estimatedCostUsd: Number(cost.toFixed(4)),
    costPerConversationUsd: Number((cost / results.length).toFixed(5)),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(
    `\nPassed ${passedRuns}/${results.length} runs (${(summary.passRate * 100).toFixed(1)}%). ` +
      `Scenarios passing every run: ${(summary.scenarioPassRate * 100).toFixed(1)}%. ` +
      `Est. cost $${summary.estimatedCostUsd} ($${summary.costPerConversationUsd}/conversation). ${summary.seconds}s.`,
  );

  const outDir = path.join(process.cwd(), ".eval-results");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${agentName}-${modelName}.json`);
  writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
