import { getTwilioCredentials } from "@/lib/admin/platform-credentials";

export async function sendSmsMessage(input: {
  fromE164: string;
  toE164: string;
  body: string;
}): Promise<{ ok: true; sid: string | null } | { ok: false; error: string }> {
  const { accountSid, authToken } = await getTwilioCredentials();
  if (!accountSid || !authToken) {
    return { ok: false, error: "Twilio is not configured." };
  }

  const params = new URLSearchParams({
    From: input.fromE164,
    To: input.toE164,
    Body: input.body,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    sid?: string;
    message?: string;
    error_message?: string;
  } | null;

  if (!response.ok) {
    return {
      ok: false,
      error:
        payload?.error_message?.trim() ||
        payload?.message?.trim() ||
        "Failed to send SMS.",
    };
  }

  return { ok: true, sid: payload?.sid?.trim() || null };
}
