/**
 * Parse a lead budget string into opportunity amount_cents.
 * Supports: 400k, $400k, 400,000, $400000, 1.2m, etc.
 */
export function parseBudgetToCents(
  budget: string | null | undefined,
): number | null {
  if (!budget?.trim()) return null;
  const t = budget.trim().toLowerCase().replace(/,/g, "");

  const million = t.match(/\$?\s*(\d+(?:\.\d+)?)\s*(m|mm|mil|million)\b/);
  if (million) {
    const n = Number.parseFloat(million[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 1_000_000 * 100);
  }

  const thousand = t.match(/\$?\s*(\d+(?:\.\d+)?)\s*k\b/);
  if (thousand) {
    const n = Number.parseFloat(thousand[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 1_000 * 100);
  }

  const plain = t.match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (plain) {
    const n = Number.parseFloat(plain[1]);
    if (!Number.isFinite(n) || n < 1000) return null;
    return Math.round(n * 100);
  }

  return null;
}
