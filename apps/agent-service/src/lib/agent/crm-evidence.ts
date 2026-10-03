/**
 * CRM fields the lead must have actually stated. A value is only saved when the lead's own
 * messages support it, so listing details (price, city, beds) never become the lead's budget or area.
 */

const MONEY =
  /\$\s?\d|\b\d+(\.\d+)?\s?(k|m|mil|million|thousand)\b|\b(budget|afford|price range|spend|pre-?approved for)\b[^.?!]*\d/i;

const PROPERTY_TYPES: Record<string, RegExp> = {
  "Single Family": /\bsingle[- ]family\b|\b(a|any) (house|home)\b|\bdetached\b/i,
  Condo: /\bcondo|\bapartment\b/i,
  Townhome: /\btown ?(home|house)/i,
  "Multi-Family": /\bmulti[- ]family|\bduplex|\btriplex|\bfourplex/i,
  Land: /\b(land|lot|acreage)\b/i,
  Commercial: /\bcommercial\b/i,
};

const INTENTS: Record<string, RegExp> = {
  Buyer: /\b(buy|buying|purchas\w*|first[- ]time|looking for a (home|house|place))\b/i,
  Seller: /\b(sell|selling|list(ing)? my|sale of my)\b/i,
  Investor: /\b(invest\w*|rental|flip|cash flow)\b/i,
  Referral: /\brefer\w*\b/i,
};

const FINANCING = /\b(cash|pre-?approv\w*|pre-?qual\w*|loan|mortgage|financ\w*|lender|fha|va loan)\b/i;

const TIMELINE =
  /\b(asap|soon|right away|now|days?|weeks?|months?|years?|spring|summer|fall|autumn|winter|exploring|just looking|no rush|by (the )?(end|spring|summer|fall|winter))\b/i;

function locationSupported(value: string, leadText: string): boolean {
  const lower = leadText.toLowerCase();
  return value
    .split(/[,/]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
    .some((part) => lower.includes(part));
}

/** Fields in an update_contact call that the lead's messages don't support. */
export function unsupportedFields(args: Record<string, unknown>, leadText: string): string[] {
  const out: string[] = [];
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");

  if (str("budget") && !MONEY.test(leadText)) out.push("budget");
  if (str("target_location") && !locationSupported(str("target_location"), leadText)) out.push("target_location");
  if (str("property_type")) {
    const pattern = PROPERTY_TYPES[str("property_type")];
    if (!pattern || !pattern.test(leadText)) out.push("property_type");
  }
  if (str("intent")) {
    const pattern = INTENTS[str("intent")];
    if (!pattern || !pattern.test(leadText)) out.push("intent");
  }
  if (str("financing_status") && !FINANCING.test(leadText)) out.push("financing_status");
  if (str("timeline") && !TIMELINE.test(leadText)) out.push("timeline");
  return out;
}
