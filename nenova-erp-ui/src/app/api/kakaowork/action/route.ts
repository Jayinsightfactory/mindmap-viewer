import { NextRequest, NextResponse } from "next/server";
import { resolveEmployeeIdentity } from "@/lib/employee-directory";

export const runtime = "nodejs";

type IntakeStatus = "초안" | "승인대기" | "승인완료" | "전환완료" | "보류";

type ActionBody = {
  action?: string;
  intakeId?: string;
  erpIntakeId?: string;
  id?: string;
  note?: string;
  user?: { id?: string | number; email?: string; name?: string };
  actions?: Record<string, unknown>;
};

function verifySecret(req: NextRequest) {
  const expected = process.env.KAKAOWORK_CALLBACK_SECRET;
  if (!expected) return true;

  const provided = req.headers.get("x-nenova-kakaowork-secret") || req.nextUrl.searchParams.get("secret") || "";
  return provided === expected;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeAction(raw?: string) {
  const value = (raw || "").trim().toLowerCase();
  if (["approve", "approved", "confirm", "confirmed", "ok", "yes", "승인", "확인"].includes(value)) return "approve";
  if (["hold", "pause", "pending", "보류"].includes(value)) return "hold";
  if (["restore", "reopen", "draft", "reset", "초안", "복귀"].includes(value)) return "restore";
  if (["convert", "create", "execute", "전환", "생성", "실행"].includes(value)) return "convert";
  if (["reject", "deny", "cancel", "반려", "취소"].includes(value)) return "hold";
  return value || undefined;
}

function actionStatus(action?: string): IntakeStatus | undefined {
  if (action === "approve") return "승인완료";
  if (action === "hold") return "보류";
  if (action === "restore") return "초안";
  if (action === "convert") return "승인완료";
  return undefined;
}

function pickAction(body: ActionBody) {
  return normalizeAction(
    body.action ||
      readString(body.actions?.action) ||
      readString(body.actions?.type) ||
      readString(body.actions?.value) ||
      readString(body.actions?.name),
  );
}

function pickIntakeId(body: ActionBody) {
  return (
    body.intakeId ||
    body.erpIntakeId ||
    body.id ||
    readString(body.actions?.intakeId) ||
    readString(body.actions?.erpIntakeId) ||
    readString(body.actions?.id)
  );
}

export async function GET() {
  return NextResponse.json({
    status: "ready",
    contract: {
      method: "POST",
      body: ["action", "intakeId", "user?", "note?"],
      actions: ["approve", "hold", "restore", "convert"],
    },
    effect: {
      approve: "ERP intake status -> 승인완료",
      hold: "ERP intake status -> 보류",
      restore: "ERP intake status -> 초안",
      convert: "ERP intake status -> 승인완료 and requestedConversionAt is stored",
    },
  });
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ ok: false, error: "카카오워크 액션 시크릿이 일치하지 않습니다." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as ActionBody;
  const action = pickAction(body);
  const intakeId = pickIntakeId(body);
  const status = actionStatus(action);

  if (!action || !status || !intakeId) {
    return NextResponse.json(
      {
        ok: false,
        error: "action and intakeId are required",
        supportedActions: ["approve", "hold", "restore", "convert"],
      },
      { status: 400 },
    );
  }

  const identity = resolveEmployeeIdentity({
    employeeName: body.user?.name || undefined,
    userName: body.user?.name || undefined,
    userEmail: body.user?.email || undefined,
    email: body.user?.email || undefined,
    userId: body.user?.id ? String(body.user.id) : undefined,
    kakaoworkUserId: body.user?.id ? String(body.user.id) : undefined,
  });
  const actedAt = new Date().toISOString();
  const patch = {
    id: intakeId,
    status,
    requestedConversionAt: action === "convert" ? actedAt : undefined,
    conversionNote: action === "convert" ? "카카오워크에서 전환 실행이 요청되었습니다." : undefined,
    lastAction: {
      source: "KakaoWork",
      action,
      actor: identity?.employee || body.user?.name || body.user?.email || (body.user?.id ? String(body.user.id) : undefined),
      accountId: identity?.accountId || body.user?.email || undefined,
      note: body.note || readString(body.actions?.note),
      actedAt,
    },
  };

  const response = await fetch(new URL("/api/erp/intake", req.nextUrl.origin), {
    method: "PATCH",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(patch),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return NextResponse.json({
    ok: response.ok,
    status: response.status,
    action,
    intakeId,
    patch,
    response: data,
  }, { status: response.ok ? 200 : response.status });
}
