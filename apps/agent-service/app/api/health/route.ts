import { NextResponse } from "next/server";
import { getEnv, isOpenAIConfigured, isSalesforceConfigured } from "@/lib/env";

export async function GET() {
  const env = getEnv();
  return NextResponse.json({
    service: "reos-agent-service",
    status: "ok",
    openai: isOpenAIConfigured(env),
    salesforce: isSalesforceConfigured(env),
    twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
  });
}
