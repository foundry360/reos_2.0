import { NextResponse } from "next/server";
import {
  isOpenAIConfiguredAsync,
  isTwilioConfiguredAsync,
} from "@/lib/admin/platform-credentials";
import { isStripeConfiguredAsync } from "@/lib/admin/stripe";
import { isSupabaseConfigured, getEnv } from "@/lib/env";

export async function GET() {
  const [openai, twilio, stripe] = await Promise.all([
    isOpenAIConfiguredAsync(),
    isTwilioConfiguredAsync(),
    isStripeConfiguredAsync(),
  ]);

  return NextResponse.json({
    service: "reos-2",
    status: "ok",
    openai,
    supabase: isSupabaseConfigured(getEnv()),
    twilio,
    stripe,
  });
}
