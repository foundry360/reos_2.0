export interface BillingCycleWindow {
  start: string;
  end: string;
  label: string;
}

export function getCurrentBillingCycle(reference = new Date()): BillingCycleWindow {
  const start = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const end = new Date(reference.getFullYear(), reference.getMonth() + 1, 0, 23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(start),
  };
}

/** Calendar month immediately before the reference date. */
export function getPreviousBillingCycle(reference = new Date()): BillingCycleWindow {
  const previousMonth = new Date(reference.getFullYear(), reference.getMonth() - 1, 1);
  return getCurrentBillingCycle(previousMonth);
}

export function getBillingCycleForMonth(year: number, month: number): BillingCycleWindow | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  return getCurrentBillingCycle(new Date(year, month - 1, 1));
}

export function parseBillingCyclePeriod(value: string): BillingCycleWindow | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  return getBillingCycleForMonth(Number(match[1]), Number(match[2]));
}
