import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enrollmentNotice,
  manualEnrollmentOptions,
  type ManualEnrollmentJourneyRow,
  type ManualEnrollmentVersionRow,
} from "./manual-enrollment-options.ts";

function journey(id: string, overrides: Partial<ManualEnrollmentJourneyRow> = {}): ManualEnrollmentJourneyRow {
  return { id, name: `Journey ${id}`, description: "", status: "active", version: 1, ...overrides };
}

function version(journeyId: string, v: number, triggerEvents: string[]): ManualEnrollmentVersionRow {
  return { journeyId, version: v, triggerEvents };
}

describe("manualEnrollmentOptions", () => {
  it("lists active journeys whose current version has a manual trigger", () => {
    const options = manualEnrollmentOptions(
      [journey("a", { name: "Nurture", description: "Monthly check-ins" })],
      [version("a", 1, ["manual"])],
      [],
    );
    assert.deepEqual(options, [{ id: "a", name: "Nurture", description: "Monthly check-ins", alreadyActive: false }]);
  });

  it("leaves out ineligible journeys", () => {
    const options = manualEnrollmentOptions(
      [
        journey("paused", { status: "paused" }),
        journey("draft", { status: "draft" }),
        journey("lead-only"),
        journey("old-manual", { version: 2 }),
        journey("no-version"),
        journey("ok"),
      ],
      [
        version("paused", 1, ["manual"]),
        version("draft", 1, ["manual"]),
        version("lead-only", 1, ["lead.created"]),
        version("old-manual", 1, ["manual"]),
        version("old-manual", 2, ["lead.created"]),
        version("ok", 1, ["lead.created", "manual"]),
      ],
      [],
    );
    assert.deepEqual(
      options.map((option) => option.id),
      ["ok"],
    );
  });

  it("marks journeys the lead is already active in and sorts by name", () => {
    const options = manualEnrollmentOptions(
      [journey("b", { name: "Buyer follow-up" }), journey("a", { name: "Annual check-in" })],
      [version("a", 1, ["manual"]), version("b", 1, ["manual"])],
      ["b"],
    );
    assert.deepEqual(
      options.map((option) => `${option.name}:${option.alreadyActive}`),
      ["Annual check-in:false", "Buyer follow-up:true"],
    );
  });
});

describe("enrollmentNotice", () => {
  it("maps every result to fixed, user-safe copy", () => {
    assert.deepEqual(enrollmentNotice("enrolled"), { tone: "success", message: "Lead enrolled in Journey." });
    assert.deepEqual(enrollmentNotice("already_active"), {
      tone: "info",
      message: "This lead is already active in this Journey.",
    });
    assert.deepEqual(enrollmentNotice("invalid_journey"), {
      tone: "error",
      message: "This Journey is no longer available for enrollment.",
    });
    assert.deepEqual(enrollmentNotice("invalid_contact"), { tone: "error", message: "This lead is no longer available." });
    assert.deepEqual(enrollmentNotice("unauthorized"), {
      tone: "error",
      message: "You don't have permission to enroll this lead in a Journey.",
    });
    assert.deepEqual(enrollmentNotice("failed"), {
      tone: "error",
      message: "Could not enroll the lead. Please try again.",
    });
  });

  it("falls back to the generic failure for an unexpected result", () => {
    assert.equal(enrollmentNotice("surprise" as never).message, "Could not enroll the lead. Please try again.");
  });
});
