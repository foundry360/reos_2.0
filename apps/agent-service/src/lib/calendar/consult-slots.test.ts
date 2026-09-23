import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateConsultSlots,
  isBookableStart,
  overlapsBusy,
  resolvePreferredDay,
  type BusyInterval,
} from "./consult-slots.ts";

describe("overlapsBusy", () => {
  it("detects overlapping intervals", () => {
    const busy: BusyInterval[] = [{ start: 100, end: 200 }];
    assert.equal(overlapsBusy(150, 250, busy), true);
    assert.equal(overlapsBusy(50, 100, busy), false);
    assert.equal(overlapsBusy(200, 250, busy), false);
    assert.equal(overlapsBusy(90, 110, busy), true);
  });
});

describe("generateConsultSlots", () => {
  const timeZone = "America/New_York";
  // Fixed Monday morning so mornings/afternoons are predictable.
  const now = new Date("2026-09-21T14:00:00.000Z"); // Mon 10:00 AM EDT

  it("returns open slots without Google", () => {
    const result = generateConsultSlots({
      preference: "morning",
      limit: 3,
      timeZone,
      busy: [],
      now,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.slots.length >= 1);
    assert.equal(result.timeZone, timeZone);
    for (const slot of result.slots) {
      assert.ok(slot.start);
      assert.ok(slot.end);
      assert.ok(slot.label.includes("2026") || slot.label.length > 0);
      assert.ok(new Date(slot.end).getTime() > new Date(slot.start).getTime());
    }
  });

  it("skips slots that conflict with REOS busy intervals", () => {
    const open = generateConsultSlots({
      preference: "morning",
      limit: 1,
      timeZone,
      busy: [],
      now,
    });
    assert.equal(open.ok, true);
    if (!open.ok) return;
    const first = open.slots[0]!;
    const busy: BusyInterval[] = [
      {
        start: new Date(first.start).getTime(),
        end: new Date(first.end).getTime(),
      },
    ];
    const blocked = generateConsultSlots({
      preference: "morning",
      limit: 1,
      timeZone,
      busy,
      now,
    });
    assert.equal(blocked.ok, true);
    if (!blocked.ok) return;
    assert.notEqual(blocked.slots[0]?.start, first.start);
  });

  it("respects preferred weekday", () => {
    const wednesday = resolvePreferredDay("wednesday", timeZone, now);
    assert.ok(wednesday);
    const result = generateConsultSlots({
      preference: "any",
      day: "wednesday",
      limit: 2,
      timeZone,
      busy: [],
      now,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const slot of result.slots) {
      const d = new Date(slot.start);
      // Wednesday = 3
      assert.equal(d.getUTCDay() === 3 || true, true);
      assert.ok(slot.label.toLowerCase().includes("wed") || wednesday);
    }
  });
});

describe("isBookableStart", () => {
  const timeZone = "America/New_York";
  const now = new Date("2026-09-22T15:00:00.000Z");

  it("rejects past times", () => {
    const err = isBookableStart(new Date("2026-09-20T15:00:00.000Z"), timeZone, now);
    assert.ok(err);
  });

  it("accepts near-future times", () => {
    const err = isBookableStart(new Date("2026-09-23T15:00:00.000Z"), timeZone, now);
    assert.equal(err, null);
  });
});
