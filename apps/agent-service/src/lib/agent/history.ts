import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { RecordedTurn, StoredMessage } from "@/lib/agent/backend";

const MAX_RESULT_CHARS = 1500;

function clip(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
}

/**
 * Chat history with earlier turns' tool calls and results replayed as real tool messages,
 * placed by timestamp between the lead's message and the agent's reply.
 * Turns are dropped when messages lack timestamps (in-memory dev threads).
 */
export function buildChatHistory(
  messages: StoredMessage[],
  turns: Array<RecordedTurn & { createdAt: string }>,
): ChatCompletionMessageParam[] {
  type Item =
    | { at: number; order: number; kind: "message"; message: StoredMessage }
    | { at: number; order: number; kind: "turn"; turn: RecordedTurn };

  const timed = messages.every((m) => m.createdAt);
  const items: Item[] = messages.map((message, order) => ({
    at: timed ? Date.parse(message.createdAt!) : order,
    order,
    kind: "message",
    message,
  }));
  if (timed) {
    const oldest = items.length > 0 ? items[0].at : Number.POSITIVE_INFINITY;
    turns.forEach((turn, i) => {
      const at = Date.parse(turn.createdAt);
      if (turn.toolEvents.length > 0 && at >= oldest) {
        items.push({ at, order: messages.length + i, kind: "turn", turn });
      }
    });
  }
  items.sort((a, b) => a.at - b.at || a.order - b.order);

  const out: ChatCompletionMessageParam[] = [];
  let callSeq = 0;
  for (const item of items) {
    if (item.kind === "turn") {
      const ids = item.turn.toolEvents.map(() => `call_hist_${++callSeq}`);
      out.push({
        role: "assistant",
        content: null,
        tool_calls: item.turn.toolEvents.map((event, i) => ({
          id: ids[i],
          type: "function" as const,
          function: { name: event.name, arguments: JSON.stringify(event.args) },
        })),
      });
      item.turn.toolEvents.forEach((event, i) => {
        out.push({ role: "tool", tool_call_id: ids[i], content: clip(event.result) });
      });
      continue;
    }
    const content = item.message.content?.trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === item.message.role && typeof last.content === "string") {
      last.content = `${last.content}\n${content}`;
      continue;
    }
    out.push({ role: item.message.role, content });
  }
  return out;
}
