import { NextRequest, NextResponse } from "next/server";
import {
  fetchOpportunitiesList,
  opportunitiesToCsv,
  parseOpportunitiesListParams,
} from "@/lib/opportunities/opportunities-list";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";

export async function GET(request: NextRequest) {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = parseOpportunitiesListParams(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  const { rows } = await fetchOpportunitiesList(tenantId, params, {
    forExport: true,
  });
  const csv = opportunitiesToCsv(rows);
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="opportunities-export-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
