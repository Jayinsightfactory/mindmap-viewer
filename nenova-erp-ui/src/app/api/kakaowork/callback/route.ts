import { NextRequest, NextResponse } from "next/server";

type CallbackBody = {
  event?: string;
  type?: string;
  user?: { id?: string | number; email?: string; name?: string };
  conversation?: { id?: string; name?: string; type?: string };
  message?: { id?: string; text?: string };
  actions?: Record<string, unknown>;
  [key: string]: unknown;
};

function verifySecret(req: NextRequest) {
  const expected = process.env.KAKAOWORK_CALLBACK_SECRET;
  if (!expected) return true;

  const provided =
    req.headers.get("x-nenova-kakaowork-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    "";

  return provided === expected;
}

function normalizeEvent(body: CallbackBody) {
  const text = body.message?.text || (typeof body.text === "string" ? body.text : "");
  return {
    source: "kakaowork",
    event: body.event || body.type || "message",
    userId: body.user?.id || null,
    userEmail: body.user?.email || null,
    userName: body.user?.name || null,
    conversationId: body.conversation?.id || null,
    conversationName: body.conversation?.name || null,
    messageId: body.message?.id || null,
    text,
    actions: body.actions || null,
    receivedAt: new Date().toISOString(),
  };
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ error: "카카오워크 콜백 시크릿이 일치하지 않습니다." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as CallbackBody;
  const normalized = normalizeEvent(body);

  return NextResponse.json({
    received: true,
    mode: "design",
    normalized,
    nextPipeline: [
      "work_event.raw 저장",
      "직원/대화방 매핑",
      "AI 의도 분류",
      "주문/견적/프로젝트/할 일 생성 또는 상태 갱신",
      "카카오워크 확인 메시지 발송",
    ],
  });
}
