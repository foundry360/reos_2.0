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

/**
 * Private reply: a Messenger / Instagram DM addressed to a post comment.
 * Meta allows one per comment, within 7 days of it. `recipientId` is the commenter's
 * DM-scoped id (PSID / IGSID), which links the comment to the DM thread.
 */
export async function sendMetaPrivateReply(input: {
  pageAccessToken: string;
  commentId: string;
  text: string;
}): Promise<
  | { ok: true; messageId: string | null; recipientId: string | null }
  | { ok: false; error: string }
> {
  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(input.pageAccessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { comment_id: input.commentId },
        message: { text: input.text },
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    message_id?: string;
    recipient_id?: string;
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    return {
      ok: false,
      error: payload?.error?.message?.trim() || "Failed to send private reply.",
    };
  }

  return {
    ok: true,
    messageId: payload?.message_id?.trim() || null,
    recipientId: payload?.recipient_id?.trim() || null,
  };
}
