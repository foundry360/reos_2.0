import {
  appendMessage,
  linkContactDmIdentity,
  resolveCommentContact,
  resolveInboundTenantId,
  updateContactFields,
} from "@/lib/db/contacts";
import { isSupabaseConfigured } from "@/lib/env";
import { loadPageAccessToken } from "@/lib/handle-inbound-meta";
import { isCommentQuestion } from "@/lib/meta/comment-question";
import { sendMetaPrivateReply } from "@/lib/meta/send";
import type { MetaCommentEvent } from "@/lib/meta/webhook";
import { runInboundAgent } from "@/lib/run-inbound-agent";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type AgentStatus = "skipped" | "replied" | "no_reply" | "failed";

export interface HandleMetaCommentResult {
  ok: boolean;
  skipped?: string;
  contactId?: string;
  agent?: AgentStatus;
  detail?: string;
}

const PLATFORMS = {
  facebook: {
    dmChannel: "messenger",
    identityChannel: "facebook_comment",
    label: "Facebook",
    dmLabel: "Messenger",
  },
  instagram: {
    dmChannel: "instagram",
    identityChannel: "instagram_comment",
    label: "Instagram",
    dmLabel: "Instagram",
  },
} as const;

function profileFromComment(event: MetaCommentEvent): {
  firstName: string | null;
  lastName: string | null;
} {
  const name = event.commenterName?.trim();
  if (!name) return { firstName: null, lastName: null };
  if (event.platform === "instagram") {
    return { firstName: `@${name.replace(/^@/, "")}`, lastName: null };
  }
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

/**
 * Every new post comment creates or updates a contact and is logged on their thread.
 * Top-level comments that ask a question also run the conversation agent, whose answer
 * goes out as a private reply (DM) to the commenter.
 */
export async function handleMetaComment(
  event: MetaCommentEvent,
): Promise<HandleMetaCommentResult> {
  if (!isSupabaseConfigured()) return { ok: false, skipped: "supabase_not_configured" };
  const db = getSupabaseAdmin();
  if (!db) return { ok: false, skipped: "supabase_not_configured" };

  const platform = PLATFORMS[event.platform];
  const tenantId = await resolveInboundTenantId({
    channel: platform.dmChannel,
    from: event.commenterId,
    to: event.accountId,
  });
  if (!tenantId) return { ok: false, skipped: "tenant_unresolved" };

  const isQuestion = isCommentQuestion(event.text);

  // Claim the comment before doing any work; Meta retries hit the unique key and stop here.
  const { data: claimed, error: claimError } = await db
    .from("meta_comment_events")
    .insert({
      tenant_id: tenantId,
      platform: event.platform,
      account_id: event.accountId,
      comment_id: event.commentId,
      post_id: event.postId,
      parent_comment_id: event.parentCommentId,
      commenter_id: event.commenterId,
      commenter_name: event.commenterName,
      body: event.text,
      is_question: isQuestion,
    })
    .select("id")
    .single();

  if (claimError || !claimed) {
    if (claimError?.code === "23505") return { ok: true, skipped: "duplicate" };
    console.error("Meta comment claim failed:", claimError);
    return { ok: false, skipped: "claim_failed" };
  }

  async function finish(
    patch: {
      contact_id?: string;
      message_id?: string | null;
      agent_status: AgentStatus;
      agent_detail?: string | null;
    },
  ): Promise<void> {
    const { error } = await db!
      .from("meta_comment_events")
      .update(patch)
      .eq("id", claimed!.id);
    if (error) console.error("Meta comment status update failed:", error);
  }

  try {
    const profile = profileFromComment(event);
    const resolved = await resolveCommentContact({
      tenantId,
      identityChannel: platform.identityChannel,
      dmChannel: platform.dmChannel,
      commenterId: event.commenterId,
      profile,
    });
    if (!resolved?.ctx.contactId) {
      await finish({ agent_status: "skipped", agent_detail: "contact_not_created" });
      return { ok: false, skipped: "contact_not_created" };
    }

    let contactId = resolved.ctx.contactId;
    if (!resolved.created && !resolved.ctx.firstName && profile.firstName) {
      await updateContactFields(contactId, {
        first_name: profile.firstName,
        last_name: profile.lastName,
      });
      resolved.ctx.firstName = profile.firstName;
      resolved.ctx.lastName = profile.lastName ?? undefined;
    }

    const skipReason = !event.text
      ? "empty_comment"
      : !isQuestion
        ? "not_a_question"
        : event.parentCommentId
          ? "reply_thread"
          : null;

    const pageToken = skipReason
      ? null
      : await loadPageAccessToken(tenantId, platform.dmChannel, event.accountId);

    if (skipReason || !pageToken) {
      const messageId = event.text
        ? await appendMessage({
            tenantId,
            contactId,
            channel: platform.identityChannel,
            direction: "inbound",
            body: event.text,
          })
        : null;
      const detail = skipReason ?? "missing_page_token";
      await finish({
        contact_id: contactId,
        message_id: messageId,
        agent_status: "skipped",
        agent_detail: detail,
      });
      return { ok: true, contactId, agent: "skipped", detail };
    }

    const result = await runInboundAgent({
      ctx: resolved.ctx,
      body: event.text,
      channel: platform.dmChannel,
      inboundChannel: platform.identityChannel,
      contextNote: `Source: they asked this in a public comment on the business's ${platform.label} post. Your reply is delivered to them as a private ${platform.dmLabel} message; answer their question first and keep it short.`,
    });
    if (result.contactId) contactId = result.contactId;

    if (!result.reply) {
      await finish({
        contact_id: contactId,
        agent_status: "no_reply",
        agent_detail: result.optedOut ? "opted_out" : `playbook:${result.playbook}`,
      });
      return { ok: true, contactId, agent: "no_reply" };
    }

    const sent = await sendMetaPrivateReply({
      pageAccessToken: pageToken,
      commentId: event.commentId,
      text: result.reply,
    });
    if (!sent.ok) {
      console.error("Meta private reply failed:", sent.error);
      await finish({ contact_id: contactId, agent_status: "failed", agent_detail: sent.error });
      return { ok: true, contactId, agent: "failed", detail: sent.error };
    }

    if (sent.recipientId) {
      contactId = await linkContactDmIdentity({
        tenantId,
        contactId,
        channel: platform.dmChannel,
        externalId: sent.recipientId,
      });
    }

    await finish({
      contact_id: contactId,
      agent_status: "replied",
      agent_detail: `playbook:${result.playbook}`,
    });
    return { ok: true, contactId, agent: "replied" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unexpected_error";
    await finish({ agent_status: "failed", agent_detail: detail });
    throw error;
  }
}
