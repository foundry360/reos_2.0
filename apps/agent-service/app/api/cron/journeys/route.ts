import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { createLiveEngineDeps } from "@/lib/journeys/runtime/runtime";
import { handleJourneyWorkerRequest } from "@/lib/journeys/runtime/worker";

export const maxDuration = 300;

/** Resumes journey runs whose wait finished, whose retry is due, or whose inline execution was cut off. */
async function handleJourneyWorker(request: NextRequest) {
  const { status, body } = await handleJourneyWorkerRequest(request.headers, {
    cronSecret: getEnv().CRON_SECRET,
    createDeps: createLiveEngineDeps,
  });
  return NextResponse.json(body, { status });
}

export async function GET(request: NextRequest) {
  return handleJourneyWorker(request);
}

export async function POST(request: NextRequest) {
  return handleJourneyWorker(request);
}
