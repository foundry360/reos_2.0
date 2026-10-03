import assert from "node:assert/strict";
import { test } from "node:test";
import { asksContactInfo, claimsBooked, extractClockTimes, isAmbiguousPick, replyViolations } from "./reply-checks.ts";

test("bare yes to several offered times is ambiguous; a pick or a single offer is not", () => {
  const two = "I have Monday at 2:00 PM or 3:00 PM. Which works?";
  assert.equal(isAmbiguousPick("yes", two), true);
  assert.equal(isAmbiguousPick("Sounds good!", two), true);
  assert.equal(isAmbiguousPick("yes 3", two), false);
  assert.equal(isAmbiguousPick("1:30 works", two), false);
  assert.equal(isAmbiguousPick("11 works", two), false);
  assert.equal(isAmbiguousPick("the first one", two), false);
  assert.equal(isAmbiguousPick("either works", two), false);
  assert.equal(isAmbiguousPick("yes", "Does Monday at 2:00 PM work?"), false);
});

const base = { allowedTimes: new Set([600, 630]), bookedThisTurn: false, hasAppointment: false, contactInfoOnFile: false };

test("guard flags invented times, false bookings, and redundant contact asks", () => {
  assert.deepEqual(replyViolations({ ...base, reply: "Monday at 10:00 AM or 10:30 AM?" }), []);
  assert.match(replyViolations({ ...base, reply: "How about 2:00 PM?" })[0], /2:00 PM/);
  assert.equal(replyViolations({ ...base, reply: "You're all set for 10:00 AM!" }).length, 1);
  assert.deepEqual(replyViolations({ ...base, bookedThisTurn: true, reply: "You're all set for 10:00 AM!" }), []);
  assert.equal(
    replyViolations({ ...base, contactInfoOnFile: true, reply: "What's the best email for you?" }).length,
    1,
  );
  assert.equal(replyViolations({ ...base, reply: "  " }).length, 1);
});

test("extracts clock times as local minutes", () => {
  assert.deepEqual(extractClockTimes("10:00 AM, 1:30pm or noon"), [600, 810, 720]);
  assert.deepEqual(extractClockTimes("12 PM and 12:30 a.m."), [720, 30]);
  assert.deepEqual(extractClockTimes("Call 973-555-0142 at 5"), []);
});

test("detects booked claims", () => {
  assert.ok(claimsBooked("You're all set for Monday at 2:00 PM."));
  assert.ok(claimsBooked("Your showing is booked for Saturday."));
  assert.ok(claimsBooked("I've scheduled you for 10 AM."));
  assert.ok(!claimsBooked("Monday at 2:00 PM is open. Want me to book it?"));
  assert.ok(!claimsBooked("Which time should I book?"));
});

test("detects contact-info asks", () => {
  assert.ok(asksContactInfo("Great. What's the best email and mobile for you?"));
  assert.ok(asksContactInfo("I need your email and mobile number to confirm. Could you share those?"));
  assert.ok(!asksContactInfo("A calendar invite was emailed to you."));
  assert.ok(!asksContactInfo("Booked! The invite went to your email. Anything else?"));
  assert.ok(!asksContactInfo("Monday at 2:00 PM is open. Want it?"));
});
