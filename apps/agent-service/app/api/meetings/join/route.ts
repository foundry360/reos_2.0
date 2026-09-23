import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { buildJaasJoinUrl, isJaasConfigured } from "@/lib/calendar/jaas";
import { verifyMeetingJoinToken } from "@/lib/calendar/meeting-join";

export const runtime = "nodejs";

/**
 * Public join redirect: validates signed token, mints a fresh JaaS JWT, redirects to 8x8.vc.
 * Host tokens get moderator=true; guest tokens get moderator=false — no Jitsi login required.
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

  if (!isJaasConfigured()) {
    return NextResponse.json(
      { error: "Video conferencing is not configured." },
      { status: 503 },
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
  if (!room) {
    return NextResponse.json(
      { error: "This meeting has no video room." },
      { status: 404 },
    );
  }

  const isHost = payload.role === "host";
  const displayName = isHost
    ? "Host"
    : typeof activity.title === "string" && activity.title.trim()
      ? "Guest"
      : "Guest";

  try {
    const joinUrl = await buildJaasJoinUrl({
      room,
      participant: {
        id: `${payload.role}-${payload.activityId}`,
        name: displayName,
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
