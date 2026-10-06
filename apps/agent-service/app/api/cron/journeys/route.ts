import { NextRequest, NextResponse } from "next/server";
import { reconcileOutboundEmails } from "@/lib/email/email-reconciliation";
import { repairEmailSentActivities } from "@/lib/email/email-sent-activity";
import { getEnv } from "@/lib/env";
import { drainJourneyEventOutbox } from "@/lib/journeys/journey-event-dispatch";
import { drainLeadStatusOutbox } from "@/lib/journeys/lead-status-dispatch";
import { createLiveEngineDeps } from "@/lib/journeys/runtime/runtime";
import { authorizeCronRequest, handleJourneyWorkerRequest } from "@/lib/journeys/runtime/worker";

export const maxDuration = 300;

/** Delivers pending lead status changes; a failure here never blocks resuming runs. */
async function drainLeadStatusEvents(): Promise<Record<string, unknown>> {
  try {
    const summary = await drainLeadStatusOutbox();
    if (!summary || summary.claimed === 0) return {};
    console.log(`Lead status events: ${JSON.stringify(summary)}`);
    return { leadStatusEvents: summary };
  } catch (error) {
    console.log(`Lead status events failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { leadStatusEvents: { error: "Lead status event delivery failed." } };
  }
}

/** Delivers pending journey events (lead, message, appointment, task); never blocks resuming runs. */
async function drainJourneyEvents(): Promise<Record<string, unknown>> {
  try {
    const summary = await drainJourneyEventOutbox();
    if (!summary || summary.claimed === 0) return {};
    console.log(`Journey events: ${JSON.stringify(summary)}`);
    return { journeyEvents: summary };
  } catch (error) {
    console.log(`Journey events failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { journeyEvents: { error: "Journey event delivery failed." } };
  }
}

/** Settles outbound emails stuck pending or unknown from Resend's record; never resends. */
async function reconcileEmails(): Promise<Record<string, unknown>> {
  try {
    const summary = await reconcileOutboundEmails();
    if (!summary || (summary.claimed === 0 && summary.errors === 0 && summary.purgedEvents === 0)) return {};
    console.log(`Email reconciliation: ${JSON.stringify(summary)}`);
    return { emailReconciliation: summary };
  } catch (error) {
    console.log(`Email reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { emailReconciliation: { error: "Email reconciliation failed." } };
  }
}

/** Writes "Email sent" activities still owed by sent emails; never touches send state. */
async function repairSentActivities(): Promise<Record<string, unknown>> {
  try {
    const summary = await repairEmailSentActivities();
    if (!summary || (summary.checked === 0 && summary.errors === 0)) return {};
    console.log(`Email sent activity repair: ${JSON.stringify(summary)}`);
    return { emailSentActivityRepair: summary };
  } catch (error) {
    console.log(`Email sent activity repair failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { emailSentActivityRepair: { error: "Email sent activity repair failed." } };
  }
}

/** Resumes journey runs whose wait finished, whose retry is due, or whose inline execution was cut off. */
async function handleJourneyWorker(request: NextRequest) {
  const cronSecret = getEnv().CRON_SECRET;
  const outbox =
    authorizeCronRequest(request.headers, cronSecret) === "ok"
      ? { ...(await drainLeadStatusEvents()), ...(await drainJourneyEvents()), ...(await reconcileEmails()), ...(await repairSentActivities()) }
      : {};
  const { status, body } = await handleJourneyWorkerRequest(request.headers, {
    cronSecret,
    createDeps: createLiveEngineDeps,
  });
  return NextResponse.json(status === 200 ? { ...body, ...outbox } : body, { status });
}

export async function GET(request: NextRequest) {
  return handleJourneyWorker(request);
}

export async function POST(request: NextRequest) {
  return handleJourneyWorker(request);
}
