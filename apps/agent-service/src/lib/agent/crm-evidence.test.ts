import assert from "node:assert/strict";
import { test } from "node:test";
import { unsupportedFields } from "./crm-evidence.ts";

test("listing details are not the lead's facts", () => {
  const lead = "I am interested in this property. Would love to see the house";
  assert.deepEqual(
    unsupportedFields(
      { budget: "$625,000", target_location: "Orange Park", intent: "Buyer", property_type: "Single Family" },
      lead,
    ),
    ["budget", "target_location", "property_type", "intent"],
  );
});

test("fields the lead stated are kept", () => {
  const lead = "We're looking to buy in Orange Park or Jacksonville, budget around 600k, pre-approved, within 3 months. Want a single family.";
  assert.deepEqual(
    unsupportedFields(
      {
        budget: "$600K",
        target_location: "Orange Park",
        intent: "Buyer",
        financing_status: "Pre-Approved",
        timeline: "1-3 Months",
        property_type: "Single Family",
        ai_summary: "Anything",
      },
      lead,
    ),
    [],
  );
});

test("free-text fields are not gated", () => {
  assert.deepEqual(unsupportedFields({ ai_summary: "x", must_haves: "yard" }, "hi"), []);
});
