/** Pure text checks shared by the live invariant guard and the eval suite. */

const CLOCK = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
const NOON = /\bnoon\b/gi;

/** Clock times in text as minutes after local midnight ("2:30 PM" -> 870). */
export function extractClockTimes(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(CLOCK)) {
    let hour = Number(match[1]) % 12;
    if (match[3].toLowerCase().startsWith("p")) hour += 12;
    out.push(hour * 60 + Number(match[2] ?? 0));
  }
  for (const _ of text.matchAll(NOON)) out.push(12 * 60);
  return out;
}

export function formatMinutes(total: number): string {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

const BOOKED_CLAIM =
  /\b(you['’]?re (all set|booked|scheduled|confirmed)|(it|that|this|you|appointment|showing|consult)\s+(is|are|has been|have been)\s+(now\s+)?(booked|scheduled|confirmed|reserved)|i['’]?ve (booked|scheduled|confirmed|reserved|locked)|(booked|scheduled|confirmed|reserved) (you|your|it|that)\b|invite (was |has been )?(sent|emailed)|see you (on|then|at))\b/i;

const DAY_WORD =
  /\b(today|tonight|tomorrow|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may \d|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b|\b\d{1,2}\/\d{1,2}\b/i;

/** Text says which day it means ("Monday", "Oct 5", "tomorrow", "10/5"). */
export function namesDay(text: string): boolean {
  return DAY_WORD.test(text);
}

export function claimsBooked(text: string): boolean {
  return BOOKED_CLAIM.test(text);
}

/** Hard rules checked in code after each draft. Returns plain-language problems for the retry. */
export function replyViolations(input: {
  reply: string;
  allowedTimes: Set<number>;
  bookedThisTurn: boolean;
  hasAppointment: boolean;
  contactInfoOnFile: boolean;
  firstReply?: boolean;
}): string[] {
  const problems: string[] = [];
  if (!input.reply.trim()) problems.push("The reply is empty. Write a reply to the lead.");
  if (input.firstReply && input.reply.trim() && !GREETING.test(input.reply)) {
    problems.push("This is your first message to this lead. Start with a short greeting by name and thanks for reaching out.");
  }
  const invented = [...new Set(extractClockTimes(input.reply))].filter((t) => !input.allowedTimes.has(t));
  if (invented.length > 0) {
    problems.push(
      `It mentions ${invented.map(formatMinutes).join(", ")}, which no tool returned in this conversation. Only mention times from find_open_times / book_appointment results, times the lead said, or their existing appointments. Call find_open_times if you need times.`,
    );
  }
  if (extractClockTimes(input.reply).length > 0 && !namesDay(input.reply)) {
    problems.push('It lists times without saying which day. Name the day and date with the times, e.g. "Monday, Oct 5 at 2:00 PM or 3:00 PM".');
  }
  if (claimsBooked(input.reply) && !input.bookedThisTurn && !input.hasAppointment) {
    problems.push(
      "It says or implies the appointment is booked, but book_appointment did not succeed. Either call book_appointment now, or don't claim it is booked.",
    );
  }
  if (input.contactInfoOnFile && asksContactInfo(input.reply)) {
    problems.push("It asks for email or mobile, but both are already on file. Don't ask again.");
  }
  return problems;
}

const BARE_YES =
  /^(y|ya|yes|yeah|yep|yup|sure|ok|okay|k|sounds good|that works|works|works for me|perfect|great|good|yes please|sure thing|absolutely|definitely)$/;

/** The agent offered two or more times and the lead answered with a bare "yes" that doesn't pick one. */
export function isAmbiguousPick(leadText: string, lastAgentText: string): boolean {
  const normalized = leadText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!BARE_YES.test(normalized)) return false;
  return new Set(extractClockTimes(lastAgentText)).size >= 2;
}

const POINTS_AT_TIME =
  /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|first|second|third|last|that one|this one|that works|either|any of|whichever|yes|yeah|yep|yup|sure|ok|okay|perfect|book it|sounds good|let'?s do)\b/i;

/** The lead's message names or points at a specific time ("2pm", "the second", "yes"), not just a day or range. */
export function pointsAtTime(leadText: string): boolean {
  return POINTS_AT_TIME.test(leadText);
}

const TIMING_TALK =
  /\b(earliest|soonest|asap|when|see (it|the|this|that)|visit|view(ing)?|tour|walk ?through|times?|slots?|days?|week|open)\b/i;

/** Loose check for whether a message could be about scheduling; errs toward yes. */
export function mightBeScheduling(text: string): boolean {
  return TIMING_TALK.test(text);
}

const GREETING = /^\s*(hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you)\b/i;

/** The reply asks the lead for their email or phone ("What's your email?", "I need your mobile. Can you share it?"). */
export function asksContactInfo(text: string): boolean {
  if (!text.includes("?")) return false;
  const sentences = text.match(/[^.?!]+[.?!]?/g) ?? [];
  const contactWord = /\b(e-?mail|mobile|cell|phone)\b/i;
  return sentences.some(
    (s) =>
      contactWord.test(s) &&
      (s.trim().endsWith("?") || /\b(need|share|send me|provide|what'?s|grab)\b/i.test(s)),
  );
}
