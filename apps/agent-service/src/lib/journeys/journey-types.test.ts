import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canTransitionJourney,
  isJourneyStatus,
  JOURNEY_STATUS_LABELS,
  JOURNEY_STATUSES,
  nextJourneyStatus,
} from "./journey-types.ts";

describe("journey lifecycle", () => {
  it("keeps the existing transitions", () => {
    assert.equal(canTransitionJourney("draft", "active"), true);
    assert.equal(canTransitionJourney("active", "paused"), true);
    assert.equal(canTransitionJourney("paused", "active"), true);
    assert.equal(canTransitionJourney("active", "draft"), false);
    assert.equal(canTransitionJourney("paused", "draft"), false);
    assert.equal(canTransitionJourney("draft", "paused"), false);
  });

  it("draft, active, and paused journeys can be archived", () => {
    for (const from of ["draft", "active", "paused"] as const) {
      assert.equal(canTransitionJourney(from, "archived"), true, from);
    }
  });

  it("an archived journey can only be restored to draft", () => {
    assert.equal(canTransitionJourney("archived", "draft"), true);
    assert.equal(canTransitionJourney("archived", "active"), false);
    assert.equal(canTransitionJourney("archived", "paused"), false);
  });

  it("the lifecycle action for an archived journey is Restore, to draft", () => {
    assert.deepEqual(nextJourneyStatus("archived"), { status: "draft", label: "Restore" });
    assert.deepEqual(nextJourneyStatus("draft"), { status: "active", label: "Activate" });
    assert.deepEqual(nextJourneyStatus("active"), { status: "paused", label: "Pause" });
    assert.deepEqual(nextJourneyStatus("paused"), { status: "active", label: "Resume" });
  });

  it("archived is a known status with a label", () => {
    assert.equal(isJourneyStatus("archived"), true);
    assert.deepEqual([...JOURNEY_STATUSES], ["draft", "active", "paused", "archived"]);
    assert.equal(JOURNEY_STATUS_LABELS.archived, "Archived");
    assert.equal(isJourneyStatus("deleted"), false);
  });
});
