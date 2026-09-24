import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { buildJaasJoinUrl, isJaasConfigured } from "@/lib/calendar/jaas";
import { buildJitsiMeetingUrl } from "@/lib/calendar/jitsi";
import { verifyMeetingJoinToken } from "@/lib/calendar/meeting-join";

export const runtime = "nodejs";

/**
 * Public join redirect for older signed meeting links.
 * Prefer JaaS when configured; otherwise send guests to public Meet (meet.jit.si).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token) {
    return NextResponse.json({ error: "Missing join token." }, { status: 400 });
  }

  const payload = verifyMeetingJoinToken(token);
  if (!payload) {
    return NextResponse.json(
      { error: "This join link is invalid or has expired." },
      { status: 403 },
    );
  }

  const db = getSupabaseAdmin();
  if (!db) {
    return NextResponse.json({ error: "Server is not configured." }, { status: 503 });
  }

  const { data: activity, error } = await db
    .from("contact_activities")
    .select("id, tenant_id, title, metadata, activity_type")
    .eq("id", payload.activityId)
    .eq("tenant_id", payload.tenantId)
    .maybeSingle();

  if (error || !activity) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  const metadata =
    activity.metadata && typeof activity.metadata === "object" && !Array.isArray(activity.metadata)
      ? (activity.metadata as Record<string, unknown>)
      : {};
  const room =
    (typeof metadata.conference_room === "string" && metadata.conference_room.trim()) ||
    null;
  const storedUrl =
    (typeof metadata.conference_url === "string" && metadata.conference_url.trim()) ||
    (typeof metadata.conference_host_url === "string" &&
      metadata.conference_host_url.trim()) ||
    null;

  if (!room && !storedUrl) {
    return NextResponse.json(
      { error: "This meeting has no video room." },
      { status: 404 },
    );
  }

  // Prefer a stored public Meet URL when present and not a REOS redirect.
  if (
    storedUrl &&
    !storedUrl.includes("/api/meetings/join") &&
    !isJaasConfigured()
  ) {
    return NextResponse.redirect(storedUrl, 302);
  }

  if (room && isJaasConfigured()) {
    const isHost = payload.role === "host";
    try {
      const joinUrl = await buildJaasJoinUrl({
        room,
        participant: {
          id: `${payload.role}-${payload.activityId}`,
          name: isHost ? "Host" : "Guest",
          moderator: isHost,
        },
      });
      return NextResponse.redirect(joinUrl, 302);
    } catch (err) {
      console.error("meeting join redirect failed:", err);
      return NextResponse.json(
        { error: "Could not start the video meeting." },
        { status: 500 },
      );
    }
  }

  if (room) {
    return NextResponse.redirect(buildJitsiMeetingUrl(room), 302);
  }

  return NextResponse.redirect(storedUrl!, 302);
}
