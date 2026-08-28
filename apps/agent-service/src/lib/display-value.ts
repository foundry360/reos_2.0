/** Empty-safe display helper — safe for Server and Client Components. */
export function displayValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}
