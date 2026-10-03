import OpenAI from "openai";
import { getOpenAIApiKey, getOpenAIModel } from "@/lib/admin/platform-credentials";
import { isCommentQuestion } from "@/lib/meta/comment-question";

export interface CommentTriage {
  isQuestion: boolean;
  needsFollowUp: boolean;
  reason: string;
  source: "ai" | "keywords";
}

const SYSTEM_PROMPT = `You triage public comments left on a real-estate business's Facebook or Instagram posts.
Decide whether the commenter should get a private follow-up message from the business.

needs_follow_up = true when the commenter:
- asks a question (price, availability, location, showings, financing, process, anything)
- shows interest or buying/selling intent ("interested", "I'd love to see it", "learn more", "looking for something like this")
- asks to be contacted or sent details ("DM me", "send info", "call me")

needs_follow_up = false for:
- compliments or reactions ("beautiful!", "love it", "congrats"), emojis only
- tagging friends without a request, or chatting with other commenters
- spam, promotions, or obvious tests by the business itself
- complaints or hostile remarks (a human should handle these)

is_question = true only when the comment asks something, with or without a question mark.
reason: at most 8 words.`;

function keywordTriage(text: string): CommentTriage {
  const isQuestion = isCommentQuestion(text);
  return {
    isQuestion,
    needsFollowUp: isQuestion,
    reason: isQuestion ? "keyword match" : "no keyword match",
    source: "keywords",
  };
}

/** Lets the AI decide whether a post comment is a question and needs a private follow-up. */
export async function triageComment(params: {
  text: string;
  platform: "facebook" | "instagram";
  isReply: boolean;
  /** What the post is about, e.g. the listing it promotes. */
  postSummary?: string | null;
}): Promise<CommentTriage> {
  const text = params.text.trim();
  if (!text) return { isQuestion: false, needsFollowUp: false, reason: "empty comment", source: "keywords" };

  const apiKey = await getOpenAIApiKey();
  if (!apiKey) return keywordTriage(text);

  try {
    const completion = await new OpenAI({ apiKey }).chat.completions.create({
      model: getOpenAIModel(),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Platform: ${params.platform}`,
            params.isReply ? "This comment is a reply inside another comment's thread." : "This is a top-level comment on the post.",
            params.postSummary ? `The post: ${params.postSummary.slice(0, 600)}` : null,
            `Comment: """${text.slice(0, 1000)}"""`,
            "",
            'Respond with JSON: {"is_question": boolean, "needs_follow_up": boolean, "reason": string}',
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return keywordTriage(text);
    const parsed = JSON.parse(raw) as {
      is_question?: unknown;
      needs_follow_up?: unknown;
      reason?: unknown;
    };
    return {
      isQuestion: parsed.is_question === true,
      needsFollowUp: parsed.needs_follow_up === true,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 120) : "",
      source: "ai",
    };
  } catch (error) {
    console.error("Comment triage failed, falling back to keywords:", error);
    return keywordTriage(text);
  }
}
