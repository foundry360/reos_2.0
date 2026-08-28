import { NextRequest, NextResponse } from "next/server";
import {
  accountsToCsv,
  fetchAccountsList,
  parseAccountsListParams,
} from "@/lib/admin/accounts-list";
import { requirePlatformAdmin } from "@/lib/admin/auth";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = parseAccountsListParams(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  const { rows } = await fetchAccountsList(params, { forExport: true });
  const csv = accountsToCsv(rows);
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="accounts-export-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
