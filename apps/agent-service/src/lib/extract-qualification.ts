/**
 * Heuristic extraction when Concierge forgets update_contact for intake answers.
 */

const PROPERTY_TYPES: Array<{ label: string; pattern: RegExp }> = [
  { label: "Single Family", pattern: /\bsingle[-\s]?family\b|\bsfh\b/i },
  { label: "Condo", pattern: /\bcondo(minium)?s?\b/i },
  { label: "Townhome", pattern: /\btown\s*-?\s*homes?\b|\btownhouse\b/i },
  { label: "Multi-Family", pattern: /\bmulti[-\s]?family\b|\bduplex\b|\btriplex\b|\bfourplex\b/i },
  { label: "Land", pattern: /\b(land|lot|acreage)\b/i },
  { label: "Commercial", pattern: /\bcommercial\b/i },
];

export function extractPropertyType(text: string): string | null {
  for (const entry of PROPERTY_TYPES) {
    if (entry.pattern.test(text)) return entry.label;
  }
  return null;
}

export function extractTimeline(text: string): string | null {
  const t = text.toLowerCase();
  if (/\basap\b|\bright away\b|\bimmediately\b/.test(t)) return "ASAP";
  if (
    /\b(0\s*[-–to]+\s*30|within\s*(a\s+)?month|next\s*30\s*days|30\s*days)\b/.test(
      t,
    )
  ) {
    return "0-30 Days";
  }
  if (/\b(1\s*[-–to]+\s*3\s*months?|next\s*(few\s+)?months)\b/.test(t)) {
    return "1-3 Months";
  }
  if (/\b(3\s*[-–to]+\s*6\s*months?)\b/.test(t)) return "3-6 Months";
  if (/\b(6\s*\+?\s*months?|6\s*[-–to]+\s*12|next\s*year)\b/.test(t)) {
    return "6+ Months";
  }
  if (/\b(just\s+exploring|not\s+sure|no\s+rush|browsing)\b/.test(t)) {
    return "Just Exploring";
  }
  return null;
}

export function extractFinancingStatus(text: string): string | null {
  const t = text.toLowerCase();
  if (
    /\b(not|no|aren't|are not|havent|haven't|ain'?t)\s+(yet\s+)?(been\s+)?(pre[-\s]?approved|preapproved)\b/.test(
      t,
    ) ||
    /\bnot\s+pre[-\s]?approved\b/.test(t) ||
    /\bneed(s)?\s+(to\s+get\s+)?financ/.test(t) ||
    /\bstill\s+need\s+(a\s+)?(loan|mortgage|financ)/.test(t)
  ) {
    return "Needs Financing";
  }
  if (/\b(paying\s+)?cash\b|\bcash\s+buyer\b/.test(t)) return "Cash";
  if (/\bpre[-\s]?approved\b/.test(t)) return "Pre-Approved";
  if (/\bpre[-\s]?qualified\b/.test(t)) return "Pre-Qualified";
  return null;
}

export function extractTargetLocation(
  body: string,
  lastAssistantText: string,
): string | null {
  const askedArea =
    /\b(area|location|city|where|neighborhood|what part|looking)\b/i.test(
      lastAssistantText,
    );
  if (!askedArea) return null;

  const cleaned = body
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  if (/@/.test(cleaned)) return null;
  if (extractPropertyType(cleaned) && cleaned.split(/\s+/).length <= 4) {
    return null;
  }
  if (extractTimeline(cleaned)) return null;
  if (extractFinancingStatus(cleaned)) return null;
  if (
    /^(yes|no|yeah|yep|nope|ok|okay|sure|thanks|thank you)\b/i.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

export type ExtractedQualification = {
  target_location?: string;
  property_type?: string;
  timeline?: string;
  financing_status?: string;
};

/** Pull qualification facts from the lead's message (and prior agent question). */
export function extractQualificationFromInbound(
  body: string,
  lastAssistantText: string,
): ExtractedQualification {
  const out: ExtractedQualification = {};
  const propertyType = extractPropertyType(body);
  if (propertyType) out.property_type = propertyType;
  const timeline = extractTimeline(body);
  if (timeline) out.timeline = timeline;
  const financing = extractFinancingStatus(body);
  if (financing) out.financing_status = financing;
  const location = extractTargetLocation(body, lastAssistantText);
  if (location) out.target_location = location;
  return out;
}
