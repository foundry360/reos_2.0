import { NextResponse } from "next/server";
import {
  isOpenAIConfiguredAsync,
  isTelnyxConfiguredAsync,
} from "@/lib/admin/platform-credentials";
import { isResendConfigured } from "@/lib/admin/resend";
import { isStripeConfiguredAsync } from "@/lib/admin/stripe";
import { isSupabaseConfigured, getEnv } from "@/lib/env";

export async function GET() {
  const [openai, telnyx, stripe, resend] = await Promise.all([
    isOpenAIConfiguredAsync(),
    isTelnyxConfiguredAsync(),
    isStripeConfiguredAsync(),
    isResendConfigured(),
  ]);

  return NextResponse.json({
    service: "reos-2",
    status: "ok",
    openai,
    supabase: isSupabaseConfigured(getEnv()),
    telnyx,
    stripe,
    resend,
  });
}
