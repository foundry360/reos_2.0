const QUESTION_START =
  /^(is|are|am|was|were|do|does|did|can|could|would|will|should|has|have|had|what|what's|whats|when|where|how|why|who|which|any|anyone|tell me|i (was )?wondering)\b/i;

/** Inquiries people post without a question mark ("price", "still available", "dm me"). */
const IMPLICIT_INQUIRY =
  /\b(how much|price|pricing|still available|more (info|information|details)|info please|details please|send (me )?(the )?(info|details|price)|(dm|pm|message|text|call) me)\b/i;

/** "What a view", "How beautiful" — exclamations, not questions. */
const EXCLAMATION_START =
  /^(what (a|an)|how (lovely|beautiful|gorgeous|nice|cute|cool|great|amazing|stunning|pretty|fun|exciting))\b/i;

const MENTION = /@[\w.]+/g;
const URL = /https?:\/\/\S+/gi;
const NON_WORD = /[^\p{L}\p{N}?]+/gu;

/** True when a post comment asks something the conversation agent should answer. */
export function isCommentQuestion(text: string): boolean {
  const cleaned = text.replace(URL, " ").replace(MENTION, " ").trim();
  const letters = cleaned.replace(NON_WORD, "");
  if (letters.replace(/\?/g, "").length < 3) return false;

  if (cleaned.includes("?")) return true;
  if (QUESTION_START.test(cleaned) && !EXCLAMATION_START.test(cleaned)) return true;
  return IMPLICIT_INQUIRY.test(cleaned);
}
