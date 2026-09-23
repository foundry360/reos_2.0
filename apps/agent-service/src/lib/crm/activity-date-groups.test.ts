import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityGroupForDate,
  groupByActivityDate,
} from "./activity-date-groups.ts";

describe("activityGroupForDate", () => {
  it("orders buckets so recent groups sort before older months", () => {
    const now = new Date("2026-09-22T15:00:00");
    const today = activityGroupForDate(now.toISOString(), now);
    const yesterday = activityGroupForDate("2026-09-21T12:00:00", now);
    const lastMonth = activityGroupForDate("2026-08-10T12:00:00", now);
    const older = activityGroupForDate("2025-01-05T12:00:00", now);

    assert.equal(today.sort < yesterday.sort, true);
    assert.equal(yesterday.sort < lastMonth.sort, true);
    assert.equal(lastMonth.sort < older.sort, true);
  });
});

describe("groupByActivityDate", () => {
  it("lists most recent groups and items first", () => {
    const now = new Date("2026-09-22T15:00:00");
    const items = [
      { id: "old", occurredAt: "2025-03-01T10:00:00" },
      { id: "today-am", occurredAt: "2026-09-22T09:00:00" },
      { id: "today-pm", occurredAt: "2026-09-22T14:00:00" },
      { id: "last-month", occurredAt: "2026-08-15T12:00:00" },
    ];

    const groups = groupByActivityDate(items, (item) => item.occurredAt, now);

    assert.equal(groups[0]?.label, "Today");
    assert.deepEqual(
      groups[0]?.items.map((item) => item.id),
      ["today-pm", "today-am"],
    );
    assert.equal(groups.at(-1)?.items[0]?.id, "old");
  });
});
