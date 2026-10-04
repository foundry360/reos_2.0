/**
 * AI step routing. A journey AI node names an agent key (config.agent), never a
 * model. The router maps that key to an executor registered by the server; the
 * executor decides which model/provider to use. With nothing registered, AI
 * steps are recorded as skipped and the journey continues.
 */

import type { AIConfig } from "./contracts.ts";
import type { ExecutionContext } from "./conditions.ts";

export interface AIStepInput {
  tenantId: string;
  runId: string;
  nodeId: string;
  contactId: string | null;
  config: AIConfig;
  context: ExecutionContext;
}

export type AIStepResult =
  | { status: "completed"; output: Record<string, unknown> }
  | { status: "skipped"; output: Record<string, unknown>; reason: string };

export interface AIStepExecutor {
  run(input: AIStepInput): Promise<AIStepResult>;
}

export interface AIStepRouter {
  resolve(agentKey: string): AIStepExecutor | null;
}

export function createAIStepRouter(executors: Record<string, AIStepExecutor> = {}): AIStepRouter {
  return {
    resolve(agentKey) {
      return Object.hasOwn(executors, agentKey) ? executors[agentKey] : null;
    },
  };
}

export async function runAIStep(router: AIStepRouter, input: AIStepInput): Promise<AIStepResult> {
  const executor = router.resolve(input.config.agent);
  if (!executor) {
    return {
      status: "skipped",
      reason: "No AI agent is configured for journey steps yet.",
      output: { skipped: true, agent: input.config.agent },
    };
  }
  return executor.run(input);
}
