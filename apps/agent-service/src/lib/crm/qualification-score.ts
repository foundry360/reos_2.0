/** Deterministic score / temperature from CRM qualification columns. */

export type LeadTemperatureValue = "Hot" | "Warm" | "Cold";

export type QualificationScoreInput = {
  intent?: string | null;
  target_location?: string | null;
  property_type?: string | null;
  budget?: string | null;
  timeline?: string | null;
  financing_status?: string | null;
  must_haves?: string | null;
  motivation?: string | null;
  preferences?: string | null;
  ai_summary?: string | null;
  appt_booked?: boolean | null;
  ready_to_book?: boolean | null;
};

function nearTermTimeline(timeline: string): boolean {
  return /\b(asap|0-30|1-3\s*months?|within\s*90|90\s*days?)\b/i.test(timeline);
}

function exploringTimeline(timeline: string): boolean {
  return /\b(just\s*exploring|6\+\s*months?|6\+|long[- ]?term)\b/i.test(timeline);
}

/**
 * Mirrors Concierge scoring rules so Score & Temperature stay populated
 * even when the model skips qualification_score / lead_temperature.
 */
export function computeQualificationScore(
  row: QualificationScoreInput,
): { score: number; temperature: LeadTemperatureValue } {
  let score = 0;
  const intent = (row.intent ?? "").trim();
  const timeline = row.timeline ?? "";
  const financing = (row.financing_status ?? "").toLowerCase();
  const summary = (row.ai_summary ?? "").toLowerCase();
  const wantsConsult = Boolean(row.ready_to_book || row.appt_booked);
  const nearTerm = nearTermTimeline(timeline);
  const exploring = exploringTimeline(timeline);

  if (intent === "Seller") {
    if (nearTerm) score += 25;
    if (row.target_location?.trim() || /\baddress\b/.test(summary)) score += 25;
    if (row.motivation?.trim()) score += 20;
    if (/\b(valuat|worth|asking|list\s*price)\b/.test(summary)) score += 20;
    else if (exploring) score += 10;
    if (wantsConsult) score += 20;
  } else if (intent === "Investor") {
    if (
      row.motivation?.trim() ||
      row.preferences?.trim() ||
      /\bstrateg/.test(summary)
    ) {
      score += 25;
    }
    if (row.target_location?.trim() || row.preferences?.trim()) score += 20;
    if (row.budget?.trim()) score += 20;
    if (nearTerm || wantsConsult) score += 20;
    else score += 10;
  } else {
    // Buyer / Referral / unknown
    if (/\b(pre-?approved|cash)\b/.test(financing)) score += 25;
    if (nearTerm) score += 25;
    if (row.budget?.trim()) score += 20;
    if (wantsConsult) score += 20;
    else if (exploring) score += 10;
    else if (row.target_location?.trim() || row.property_type?.trim()) score += 10;
  }

  // Baseline so partial intake still shows a real score, not empty.
  if (score === 0) {
    if (intent) score += 15;
    if (row.target_location?.trim()) score += 10;
    if (row.property_type?.trim()) score += 10;
    if (row.budget?.trim()) score += 15;
    if (timeline.trim()) score += 10;
    if (row.financing_status?.trim()) score += 10;
    if (row.must_haves?.trim()) score += 5;
  }

  if (row.appt_booked) {
    score = Math.max(score, 75);
  }

  score = Math.min(100, Math.max(0, Math.round(score)));
  const temperature: LeadTemperatureValue =
    score >= 70 ? "Hot" : score >= 40 ? "Warm" : "Cold";

  return { score, temperature };
}
