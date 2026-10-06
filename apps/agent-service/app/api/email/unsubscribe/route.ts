import { NextResponse } from "next/server";
import { UNSUBSCRIBE_PATH, unsubscribeFromAutomatedEmail } from "@/lib/email/unsubscribe";

export const runtime = "nodejs";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(status: number, title: string, body: string): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111827"><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function tokenOf(request: Request): string {
  return new URL(request.url).searchParams.get("token")?.trim() ?? "";
}

/**
 * Shows a confirmation button. GET never unsubscribes: mail scanners open links,
 * and an unsubscribe must be the recipient's action.
 */
export async function GET(request: Request) {
  const token = tokenOf(request);
  if (!token) return page(400, "This unsubscribe link isn't valid", "<p>Use the link from the email you received.</p>");
  const action = `${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`;
  return page(
    200,
    "Unsubscribe from these emails",
    `<p>You'll stop getting emails from us, including emails like this one.</p><form method="post" action="${escapeHtml(action)}"><button type="submit" style="padding:.5rem 1rem;font-size:1rem">Unsubscribe</button></form>`,
  );
}

/** The confirmation button, and RFC 8058 one-click unsubscribe from mail clients (List-Unsubscribe-Post). */
export async function POST(request: Request) {
  const result = await unsubscribeFromAutomatedEmail(tokenOf(request));
  if (result === "unsubscribed") {
    return page(200, "You're unsubscribed", "<p>You won't get emails from us anymore.</p>");
  }
  if (result === "invalid") {
    return page(400, "This unsubscribe link isn't valid", "<p>Use the link from the email you received.</p>");
  }
  return page(503, "We couldn't unsubscribe you just now", "<p>Nothing was changed. Please try the link again in a few minutes.</p>");
}
