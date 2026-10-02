const META_GRAPH_VERSION = "v21.0";

/** Page webhook fields REOS needs. Stored on the channel so a change triggers re-subscription. */
export const META_PAGE_WEBHOOK_FIELDS = "messages,messaging_postbacks,message_echoes,feed";

/** Subscribe a Page to this app's webhook fields so Messenger and post-comment events are delivered. */
export async function subscribeMetaPageToAppWebhooks(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  const params = new URLSearchParams({
    subscribed_fields: META_PAGE_WEBHOOK_FIELDS,
    access_token: pageAccessToken,
  });

  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(pageId)}/subscribed_apps?${params.toString()}`,
    { method: "POST" },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Failed to subscribe Page to Meta webhooks.");
  }
}
