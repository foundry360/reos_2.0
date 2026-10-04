import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { resumeDueJourneyRuns } from "@/lib/journeys/runtime/runtime";

export const maxDuration = 300;

/** Batches per invocation; each batch re-queries due runs so a large backlog drains in one call. */
const MAX_BATCHES = 8;
const BATCH_SIZE = 25;

function readCronSecret(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return request.headers.get("x-cron-secret")?.trim() ?? null;
}

/** Resumes journey runs whose wait finished, whose retry is due, or whose inline execution was cut off. */
async function handleJourneyWorker(request: NextRequest) {
  const configuredSecret = getEnv().CRON_SECRET?.trim();
  if (!configuredSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 501 });
  }

  const providedSecret = readCronSecret(request);
  if (!providedSecret || providedSecret !== configuredSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const totals: Record<string, number> = {};
  let processed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const result = await resumeDueJourneyRuns(BATCH_SIZE);
    processed += result.processed;
    for (const outcome of result.outcomes) totals[outcome.status] = (totals[outcome.status] ?? 0) + 1;
    if (result.processed < BATCH_SIZE) break;
  }

  console.log("Journey worker:", processed, "runs", JSON.stringify(totals));
  return NextResponse.json({ ok: true, processed, totals });
}

export async function GET(request: NextRequest) {
  return handleJourneyWorker(request);
}

export async function POST(request: NextRequest) {
  return handleJourneyWorker(request);
}
