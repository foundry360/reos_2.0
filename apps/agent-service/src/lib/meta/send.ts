const META_GRAPH_VERSION = "v21.0";

export async function sendMetaTextMessage(input: {
  pageAccessToken: string;
  recipientId: string;
  text: string;
}): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(input.pageAccessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: input.recipientId },
        messaging_type: "RESPONSE",
        message: { text: input.text },
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    message_id?: string;
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    return {
      ok: false,
      error: payload?.error?.message?.trim() || "Failed to send Messenger message.",
    };
  }

  return { ok: true, messageId: payload?.message_id?.trim() || null };
}
