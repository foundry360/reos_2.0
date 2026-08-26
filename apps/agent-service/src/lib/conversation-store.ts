import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const threads = new Map<string, ChatCompletionMessageParam[]>();

function threadKey(tenantId: string, phone: string): string {
  return `${tenantId}:${phone}`;
}

export function getThread(
  tenantId: string,
  phone: string,
): ChatCompletionMessageParam[] {
  const key = threadKey(tenantId, phone);
  if (!threads.has(key)) threads.set(key, []);
  return threads.get(key)!;
}

export function appendToThread(
  tenantId: string,
  phone: string,
  ...messages: ChatCompletionMessageParam[]
): void {
  const key = threadKey(tenantId, phone);
  const existing = threads.get(key) ?? [];
  threads.set(key, [...existing, ...messages]);
}

export function clearThread(tenantId: string, phone: string): void {
  threads.delete(threadKey(tenantId, phone));
}

/** Production: replace with Upstash Redis or persist summary on Contact only. */
