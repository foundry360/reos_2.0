import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
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

/** Resumes journey runs whose wait finished, whose retry is due, or whose inline execution was cut off. */
async function handleJourneyWorker(request: NextRequest) {
  const cronSecret = getEnv().CRON_SECRET;
  const outbox =
    authorizeCronRequest(request.headers, cronSecret) === "ok" ? await drainLeadStatusEvents() : {};
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
