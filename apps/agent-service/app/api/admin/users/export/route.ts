import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import {
  fetchUsersList,
  parseUsersListParams,
  usersToCsv,
} from "@/lib/admin/users-list";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = parseUsersListParams(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  const { rows } = await fetchUsersList(params, { forExport: true });
  const csv = usersToCsv(rows);
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="users-export-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
