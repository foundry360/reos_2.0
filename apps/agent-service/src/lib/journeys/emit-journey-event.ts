import { after } from "next/server";
import type { JourneyEvent } from "./runtime/engine";

/**
 * Publish a CRM event to the journey runtime without slowing the caller down.
 * Execution runs after the response is sent (Next `after`); outside a request
 * it runs in the background. Never throws into the producing flow.
 *
 * The runtime is imported lazily so producers (CRM, webhooks, agent) don't pull
 * the journey engine into their module graph or create import cycles.
 */
export function emitJourneyEvent(event: JourneyEvent): void {
  const run = async () => {
    try {
      const { runJourneyEvent } = await import("./runtime/runtime");
      await runJourneyEvent(event);
    } catch (error) {
      console.error("[journeys] event failed:", event.type, error);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}
