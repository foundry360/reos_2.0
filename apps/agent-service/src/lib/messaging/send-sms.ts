import { getTelnyxCredentials } from "@/lib/admin/platform-credentials";
import { getEnv } from "@/lib/env";

export async function sendSmsMessage(input: {
  fromE164: string;
  toE164: string;
  body: string;
}): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  const { apiKey } = await getTelnyxCredentials();
  if (!apiKey) {
    return { ok: false, error: "Telnyx is not configured." };
  }

  const messagingProfileId = getEnv().TELNYX_MESSAGING_PROFILE_ID?.trim();

  const response = await fetch("https://api.telnyx.com/v2/messages", {
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
  });

  const payload = (await response.json().catch(() => null)) as {
    data?: { id?: string };
    errors?: Array<{ title?: string; detail?: string }>;
  } | null;

  if (!response.ok) {
    const firstError = payload?.errors?.[0];
    return {
      ok: false,
      error:
        firstError?.detail?.trim() ||
        firstError?.title?.trim() ||
        "Failed to send SMS.",
    };
  }

  return { ok: true, id: payload?.data?.id?.trim() || null };
}
