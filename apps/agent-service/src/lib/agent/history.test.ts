import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChatHistory } from "./history.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 18, minute)).toISOString();

test("replays tool calls between the lead's message and the reply", () => {
  const history = buildChatHistory(
    [
      { role: "user", content: "Monday?", createdAt: at(0) },
      { role: "assistant", content: "Monday: 10:00 AM or 10:30 AM?", createdAt: at(2) },
      { role: "user", content: "the second one", createdAt: at(3) },
    ],
    [
      {
        model: "m",
        reply: "",
        createdAt: at(1),
        toolEvents: [{ name: "find_open_times", args: { day: "monday" }, result: { ok: true, slots: [{ start: "x" }] } }],
      },
    ],
  );
  assert.deepEqual(
    history.map((m) => m.role),
    ["user", "assistant", "tool", "assistant", "user"],
  );
  const call = history[1] as { tool_calls: Array<{ id: string; function: { name: string } }> };
  assert.equal(call.tool_calls[0].function.name, "find_open_times");
  assert.equal((history[2] as { tool_call_id: string }).tool_call_id, call.tool_calls[0].id);
});

test("skips tool replay when messages have no timestamps", () => {
  const history = buildChatHistory(
    [
      { role: "user", content: "hi" },
      { role: "user", content: "anyone there?" },
    ],
    [{ model: "m", reply: "", createdAt: at(1), toolEvents: [{ name: "x", args: {}, result: {} }] }],
  );
  assert.deepEqual(history, [{ role: "user", content: "hi\nanyone there?" }]);
});

test("drops turns older than the oldest loaded message", () => {
  const history = buildChatHistory(
    [{ role: "user", content: "hi", createdAt: at(5) }],
    [{ model: "m", reply: "", createdAt: at(1), toolEvents: [{ name: "x", args: {}, result: {} }] }],
  );
  assert.equal(history.length, 1);
});
