/** Code-checked rules for agent eval turns. */
import {
  asksContactInfo,
  claimsBooked,
  extractClockTimes,
  formatMinutes,
} from "@/lib/agent/reply-checks";

export { asksContactInfo, claimsBooked, extractClockTimes, formatMinutes };

export interface TurnExpect {
  book?: string;
  noBooking?: boolean;
  checksCalendar?: boolean;
  asksContactInfo?: boolean;
  noContactAsk?: boolean;
  /** Every pattern must match (case-insensitive). */
  replyMatches?: string | string[];
  /** No pattern may match. */
  replyNotMatches?: string | string[];
  savesEmail?: string;
  optedOut?: boolean;
  /** Contact fields (camelCase) that must still be empty: the lead never stated them. */
  unsetFields?: string[];
}

export interface TurnObservation {
  reply: string;
  calendarReads: number;
  bookingsMade: number;
  /** Local "YYYY-MM-DD HH:MM" of bookings made this turn. */
  bookedLocal: string[];
  contactEmail?: string;
  contactFields: Record<string, unknown>;
  optedOut: boolean;
  apptBookedFlag: boolean;
  totalBookings: number;
  hadAppointmentBefore: boolean;
  contactInfoOnFileBefore: boolean;
  /** Local minutes the reply may mention without a calendar read. */
  knownTimes: Set<number>;
  /** Local minutes that are valid slot starts/ends in working hours (allowed after a calendar read). */
  workingTimes: Set<number>;
}

/** Rules every turn must follow, regardless of scenario. */
export function invariantFailures(obs: TurnObservation, expect: TurnExpect): string[] {
  const failures: string[] = [];
  if (!obs.reply.trim() && !expect.optedOut) failures.push("empty reply");

  const invented = extractClockTimes(obs.reply).filter(
    (t) => !obs.knownTimes.has(t) && !(obs.calendarReads > 0 && obs.workingTimes.has(t)),
  );
  if (invented.length > 0) {
    failures.push(
      `mentions time(s) not from the calendar: ${[...new Set(invented)].map(formatMinutes).join(", ")}`,
    );
  }

  if (claimsBooked(obs.reply) && obs.bookingsMade === 0 && !obs.hadAppointmentBefore) {
    failures.push("claims booked but nothing was booked");
  }
  if (obs.apptBookedFlag && obs.totalBookings === 0 && !obs.hadAppointmentBefore) {
    failures.push("appt_booked set without a booking");
  }
  if (obs.contactInfoOnFileBefore && asksContactInfo(obs.reply)) {
    failures.push("asked for contact info already on file");
  }
  return failures;
}

export function expectationFailures(obs: TurnObservation, expect: TurnExpect): string[] {
  const failures: string[] = [];
  if (expect.book && !obs.bookedLocal.includes(expect.book)) {
    failures.push(
      obs.bookedLocal.length > 0
        ? `booked ${obs.bookedLocal.join(", ")} instead of ${expect.book}`
        : `did not book ${expect.book}`,
    );
  }
  if (expect.noBooking && obs.bookingsMade > 0) {
    failures.push(`booked ${obs.bookedLocal.join(", ")} but should not have`);
  }
  if (expect.checksCalendar && obs.calendarReads === 0) failures.push("did not check the calendar");
  if (expect.asksContactInfo && !asksContactInfo(obs.reply)) failures.push("did not ask for contact info");
  if (expect.noContactAsk && asksContactInfo(obs.reply)) failures.push("asked for contact info");
  for (const pattern of [expect.replyMatches ?? []].flat()) {
    if (!new RegExp(pattern, "i").test(obs.reply)) failures.push(`reply missing /${pattern}/`);
  }
  for (const pattern of [expect.replyNotMatches ?? []].flat()) {
    if (new RegExp(pattern, "i").test(obs.reply)) failures.push(`reply should not match /${pattern}/`);
  }
  if (expect.savesEmail && obs.contactEmail?.toLowerCase() !== expect.savesEmail.toLowerCase()) {
    failures.push(`email not saved (have ${obs.contactEmail ?? "none"})`);
  }
  if (expect.optedOut && !obs.optedOut) failures.push("not opted out");
  for (const field of expect.unsetFields ?? []) {
    const value = obs.contactFields[field];
    if (value != null && String(value).trim()) failures.push(`assumed ${field} = ${String(value)}`);
  }
  return failures;
}
