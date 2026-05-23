import { NextRequest, NextResponse } from "next/server";

const KAKAOWORK_API_BASE = "https://api.kakaowork.com/v1";

type NotifyBody = {
  conversationId?: string;
  email?: string;
  userId?: string | number;
  text?: string;
  blocks?: unknown[];
  dryRun?: boolean;
};

type KakaoWorkResponse<T = unknown> = {
  success: boolean;
  error?: { code?: string; message?: string };
} & T;

function getBotKey() {
  return (
    process.env.KAKAOWORK_BOT_APP_KEY ||
    process.env.KAKAOWORK_BOT_TOKEN ||
    process.env.KAKAOTALK_TOKEN ||
    ""
  );
}

function targetType(body: NotifyBody) {
  if (body.conversationId) return "conversationId";
  if (body.email) return "email";
  if (body.userId) return "userId";
  return null;
}

async function callKakaoWork<T>(path: string, botKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${KAKAOWORK_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as KakaoWorkResponse<T>;
  if (!res.ok || !data.success) {
    const message = data.error?.message || data.error?.code || `KakaoWork API ${res.status}`;
    throw new Error(message);
  }

  return data;
}

function messagePayload(conversationId: string, body: NotifyBody) {
  return {
    conversation_id: conversationId,
    text: body.text,
    ...(body.blocks?.length ? { blocks: body.blocks } : {}),
  };
}

export async function GET() {
  return NextResponse.json({
    configured: Boolean(getBotKey()),
    adminConversationConfigured: Boolean(process.env.KAKAOWORK_ADMIN_CONVERSATION_ID || process.env.KAKAO_ADMIN_CONV_ID),
    supportedTargets: ["conversationId", "email", "userId"],
    requiredEnv: ["KAKAOWORK_BOT_APP_KEY", "KAKAOWORK_CALLBACK_SECRET"],
    optionalEnv: ["KAKAOWORK_ADMIN_CONVERSATION_ID", "NENOVA_PUBLIC_BASE_URL"],
    upstream: {
      baseUrl: KAKAOWORK_API_BASE,
      send: "messages.send",
      sendByEmail: "messages.send_by_email",
      openConversation: "conversations.open",
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as NotifyBody;
    const text = String(body.text || "").trim();
    const target = targetType(body);

    if (!text) {
      return NextResponse.json({ error: "text가 필요합니다." }, { status: 400 });
    }

    if (text.length > 10000) {
      return NextResponse.json({ error: "카카오워크 메시지는 10,000자 이하로 보내야 합니다." }, { status: 400 });
    }

    if (body.blocks && !Array.isArray(body.blocks)) {
      return NextResponse.json({ error: "blocks는 배열이어야 합니다." }, { status: 400 });
    }

    if (!target) {
      return NextResponse.json({ error: "conversationId, email, userId 중 하나가 필요합니다." }, { status: 400 });
    }

    const botKey = getBotKey();
    if (!botKey || body.dryRun) {
      return NextResponse.json({
        mode: "demo",
        targetType: target,
        preview: {
          conversation_id: body.conversationId || process.env.KAKAOWORK_ADMIN_CONVERSATION_ID || process.env.KAKAO_ADMIN_CONV_ID,
          email: body.email,
          user_id: body.userId,
          text,
          blocks: body.blocks || [],
        },
        note: botKey ? "dryRun 요청이라 실제 발송하지 않았습니다." : "KAKAOWORK_BOT_APP_KEY가 없어 데모 모드로 처리했습니다.",
      });
    }

    if (target === "email" && body.email) {
      const result = await callKakaoWork("/messages.send_by_email", botKey, {
        email: body.email,
        text,
        ...(body.blocks?.length ? { blocks: body.blocks } : {}),
      });
      return NextResponse.json({ mode: "live", targetType: "email", result });
    }

    let conversationId = body.conversationId;
    if (!conversationId && body.userId) {
      const opened = await callKakaoWork<{ conversation?: { id?: string } }>("/conversations.open", botKey, {
        user_id: body.userId,
      });
      conversationId = opened.conversation?.id;
    }

    if (!conversationId) {
      return NextResponse.json({ error: "카카오워크 대화방 ID를 만들 수 없습니다." }, { status: 502 });
    }

    const result = await callKakaoWork("/messages.send", botKey, messagePayload(conversationId, { ...body, text }));
    return NextResponse.json({ mode: "live", targetType: body.conversationId ? "conversationId" : "userId", result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "카카오워크 알림 처리 실패" },
      { status: 500 },
    );
  }
}
