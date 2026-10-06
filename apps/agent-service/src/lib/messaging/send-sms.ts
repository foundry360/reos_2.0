import { getTelnyxCredentials } from "@/lib/admin/platform-credentials";
import { getEnv } from "@/lib/env";
import { failureForStatus, failureForThrown, sendSignal, type ProviderFailure } from "@/lib/messaging/provider-outcome";

export async function sendSmsMessage(input: {
  fromE164: string;
  toE164: string;
  body: string;
}): Promise<{ ok: true; id: string | null } | ProviderFailure> {
  const { apiKey } = await getTelnyxCredentials();
  if (!apiKey) {
    return { ok: false, outcome: "rejected", error: "Telnyx is not configured." };
  }

  const messagingProfileId = getEnv().TELNYX_MESSAGING_PROFILE_ID?.trim();

  // Telnyx has no idempotency key for messages, so a thrown request is an unknown outcome, never retried here.
  let response: Response;
  try {
    response = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: input.fromE164,
        to: input.toE164,
        text: input.body,
        ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {}),
      }),
      signal: sendSignal(),
    });
  } catch (error) {
    return failureForThrown(error);
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: { id?: string };
    errors?: Array<{ title?: string; detail?: string }>;
  } | null;

  if (!response.ok) {
    const firstError = payload?.errors?.[0];
    return failureForStatus(response.status, firstError?.detail || firstError?.title || "Failed to send SMS.");
  }

  return { ok: true, id: payload?.data?.id?.trim() || null };
}
