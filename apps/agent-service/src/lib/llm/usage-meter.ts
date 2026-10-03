/** Process-wide token totals per model; the eval runner reads these to estimate cost. */
const totals = new Map<string, { input: number; output: number; calls: number }>();

export function meterUsage(
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined,
): void {
  if (!usage) return;
  const row = totals.get(model) ?? { input: 0, output: 0, calls: 0 };
  row.input += usage.prompt_tokens ?? 0;
  row.output += usage.completion_tokens ?? 0;
  row.calls += 1;
  totals.set(model, row);
}

export function usageSnapshot(): Record<string, { input: number; output: number; calls: number }> {
  return Object.fromEntries([...totals].map(([model, row]) => [model, { ...row }]));
}

export function resetUsage(): void {
  totals.clear();
}
