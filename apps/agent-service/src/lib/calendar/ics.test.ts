import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIcsInvite, formatIcsUtc } from "./ics.ts";

describe("buildIcsInvite", () => {
  it("builds a METHOD:REQUEST calendar body with organizer and attendees", () => {
    const start = new Date("2026-10-01T15:00:00.000Z");
    const end = new Date("2026-10-01T15:30:00.000Z");
    const ics = buildIcsInvite({
      uid: "appt-123@reos",
      summary: "Consult - Jane",
      description: "Booked via REOS.",
      location: "123 Main St",
      start,
      end,
      organizer: { email: "agent@broker.com", name: "Alex Agent" },
      attendees: [
        { email: "jane@gmail.com", name: "Jane Lead" },
        { email: "agent@broker.com", name: "Alex Agent" },
      ],
    });

    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /METHOD:REQUEST/);
    assert.match(ics, /UID:appt-123@reos/);
    assert.match(ics, new RegExp(`DTSTART:${formatIcsUtc(start)}`));
    assert.match(ics, new RegExp(`DTEND:${formatIcsUtc(end)}`));
    assert.match(ics, /SUMMARY:Consult - Jane/);
    assert.match(ics, /LOCATION:123 Main St/);
    assert.match(ics, /ORGANIZER;CN=Alex Agent:mailto:agent@broker\.com/);
    assert.match(ics, /ATTENDEE;CN=Jane Lead;RSVP=TRUE/);
    assert.match(ics, /mailto:jane@gmail\.com/);
  });
});
