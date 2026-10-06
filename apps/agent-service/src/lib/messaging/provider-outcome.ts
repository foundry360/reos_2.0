/**
 * What a provider said about one outbound send. Pure module (no `@/` imports)
 * so it runs under node --test.
 *
 * - accepted: the provider answered 2xx. Accepted is not delivered.
 * - rejected: the provider answered and refused (4xx other than 408). Nothing was sent.
 * - unknown: no usable answer (timeout, network error, 408, 5xx). The message may
 *   or may not have been sent, so it must not be resent automatically.
 */

export type ProviderFailure = { ok: false; outcome: "rejected" | "unknown"; error: string };

/** Longest a provider send may take before its outcome is treated as unknown. */
export const PROVIDER_SEND_TIMEOUT_MS = 20_000;

export function failureForStatus(status: number, detail: string | null | undefined): ProviderFailure {
  const unknown = status === 408 || status >= 500;
  const error = detail?.trim() || `HTTP ${status}`;
  return {
    ok: false,
    outcome: unknown ? "unknown" : "rejected",
    error: unknown ? `The provider didn't confirm the send (${error}); it may have been sent.` : error,
  };
}

/** A send whose request threw (timeout, connection reset): it may have reached the provider. */
export function failureForThrown(error: unknown): ProviderFailure {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const reason = timedOut ? "timed out" : "failed without a response";
  return { ok: false, outcome: "unknown", error: `The provider request ${reason}; the message may have been sent.` };
}

export function sendSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_SEND_TIMEOUT_MS);
}

/** What gets recorded on an outbound message row once the provider has answered (or failed to). */
export type OutboundOutcome =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed" | "unknown"; error: string };

export function outcomeOf(
  result: { ok: true; providerMessageId: string | null } | ProviderFailure,
): OutboundOutcome {
  if (result.ok) return { status: "sent", providerMessageId: result.providerMessageId };
  return { status: result.outcome === "rejected" ? "failed" : "unknown", error: result.error };
}
