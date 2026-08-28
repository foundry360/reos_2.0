import { NextRequest, NextResponse } from "next/server";
import {
  fetchLeadsList,
  leadsToCsv,
  parseLeadsListParams,
} from "@/lib/leads/leads-list";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";

export async function GET(request: NextRequest) {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = parseLeadsListParams(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  const { rows } = await fetchLeadsList(tenantId, params, {
    forExport: true,
    kind: "lead",
  });
  const csv = leadsToCsv(rows);
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-export-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
