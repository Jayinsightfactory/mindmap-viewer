import { NextResponse } from "next/server";
import { EMPLOYEE_DIRECTORY, resolveEmployeeIdentity } from "@/lib/employee-directory";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = {
    accountId: url.searchParams.get("accountId") || undefined,
    employeeName: url.searchParams.get("employeeName") || undefined,
    employeeId: url.searchParams.get("employeeId") || undefined,
    userId: url.searchParams.get("userId") || undefined,
    userEmail: url.searchParams.get("userEmail") || url.searchParams.get("email") || undefined,
    kakaoworkUserId: url.searchParams.get("kakaoworkUserId") || undefined,
    hostname: url.searchParams.get("hostname") || undefined,
  };
  const hasQuery = Object.values(query).some(Boolean);
  const resolved = hasQuery ? resolveEmployeeIdentity(query) : null;

  return NextResponse.json({
    status: "ready",
    count: EMPLOYEE_DIRECTORY.length,
    resolved,
    directory: EMPLOYEE_DIRECTORY.map((entry) => ({
      id: entry.id,
      employee: entry.employee,
      accountId: entry.accountId,
      team: entry.team,
      role: entry.role,
      defaultWorkArea: entry.defaultWorkArea,
      workAreas: entry.workAreas,
      emails: entry.emails,
      kakaoworkUserIds: entry.kakaoworkUserIds,
      orbitUserIds: entry.orbitUserIds,
      pcHostnames: entry.pcHostnames,
      aliases: entry.aliases,
    })),
  });
}
