import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateConsultSlots } from "./consult-slots.ts";
import {
  DEFAULT_WORKING_HOURS,
  bookingWindowsFor,
  describeWorkingHours,
  normalizeWorkingHours,
  validateWorkingHours,
  type WorkingHours,
} from "./working-hours.ts";

const timeZone = "America/New_York";
const now = new Date("2026-09-21T12:00:00.000Z"); // Mon 8:00 AM EDT

function hours(days: Partial<WorkingHours["days"]>, showingsOnDaysOff = false): WorkingHours {
  return {
    days: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], ...days },
    showingsOnDaysOff,
  };
}

describe("working hours", () => {
  it("falls back to defaults for missing or invalid data", () => {
    assert.deepEqual(normalizeWorkingHours(null), DEFAULT_WORKING_HOURS);
    assert.deepEqual(
      normalizeWorkingHours({ days: { mon: [{ start: "17:00", end: "09:00" }] } }),
      DEFAULT_WORKING_HOURS,
    );
  });

  it("rejects overlapping ranges and no working days", () => {
    assert.ok(
      validateWorkingHours(
        hours({ mon: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }),
      ),
    );
    assert.ok(validateWorkingHours(hours({})));
    assert.equal(validateWorkingHours(DEFAULT_WORKING_HOURS), null);
  });

  it("lets showings borrow weekday hours on days off only when allowed", () => {
    const h = hours({ mon: [{ start: "10:00", end: "14:00" }] }, true);
    assert.deepEqual(bookingWindowsFor(h, "Sat", "showing"), [{ startMinute: 600, endMinute: 840 }]);
    assert.deepEqual(bookingWindowsFor(h, "Sat", "consult"), []);
    assert.deepEqual(bookingWindowsFor({ ...h, showingsOnDaysOff: false }, "Sat", "showing"), []);
  });

  it("summarizes hours for the agent", () => {
    assert.equal(
      describeWorkingHours(DEFAULT_WORKING_HOURS),
      "Mon-Fri 9:00 AM-5:00 PM",
    );
  });

  it("drives slot generation", () => {
    const h = hours({ tue: [{ start: "14:30", end: "16:00" }] });
    const result = generateConsultSlots({
      preference: "any",
      day: "tuesday",
      limit: 5,
      timeZone,
      busy: [],
      now,
      windowsFor: (weekday) => bookingWindowsFor(h, weekday, "consult"),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.slots.map((s) => s.start),
      ["2026-09-22T18:30:00.000Z", "2026-09-22T19:00:00.000Z", "2026-09-22T19:30:00.000Z"],
    );

    const monday = generateConsultSlots({
      preference: "any",
      day: "monday",
      limit: 5,
      timeZone,
      busy: [],
      now,
      windowsFor: (weekday) => bookingWindowsFor(h, weekday, "consult"),
    });
    assert.equal(monday.ok, false);
  });
});
