import { NextResponse } from "next/server";
import { getEnv, isOpenAIConfigured, isSupabaseConfigured } from "@/lib/env";

export async function GET() {
  const env = getEnv();
  return NextResponse.json({
    service: "reos-2",
    status: "ok",
    openai: isOpenAIConfigured(env),
    supabase: isSupabaseConfigured(env),
    twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
  });
}
