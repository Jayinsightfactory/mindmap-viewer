import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { resolveEmployeeIdentity } from "@/lib/employee-directory";

export const runtime = "nodejs";

type CallbackBody = {
  event?: string;
  type?: string;
  text?: string;
  user?: { id?: string | number; email?: string; name?: string };
  conversation?: { id?: string; name?: string; type?: string };
  message?: { id?: string; text?: string; createdAt?: string };
  actions?: Record<string, unknown>;
  syncWorkUnit?: boolean;
  syncErpIntake?: boolean;
  [key: string]: unknown;
};

type NormalizedKakaoWorkEvent = {
  id: string;
  source: "KakaoWork";
  event: string;
  intent: string;
  category: string;
  userId: string | number | null;
  userEmail: string | null;
  userName: string | null;
  conversationId: string | null;
  conversationName: string | null;
  conversationType: string | null;
  messageId: string | null;
  text: string;
  actions: Record<string, unknown> | null;
  receivedAt: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "kakaowork-events.json");
const MAX_STORED_EVENTS = 2000;

function verifySecret(req: NextRequest) {
  const expected = process.env.KAKAOWORK_CALLBACK_SECRET;
  if (!expected) return true;

  const provided =
    req.headers.get("x-nenova-kakaowork-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    "";

  return provided === expected;
}

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function inferIntent(text: string, event: string) {
  const target = `${event} ${text}`.toLowerCase();
  if (target.includes("견적") || target.includes("quote")) return { intent: "quote_request", category: "견적" };
  if (target.includes("계약") || target.includes("contract") || target.includes("승인")) return { intent: "approval_or_contract", category: "계약" };
  if (target.includes("프로젝트") || target.includes("project")) return { intent: "project_update", category: "프로젝트" };
  if (target.includes("할 일") || target.includes("할일") || target.includes("todo") || target.includes("task")) return { intent: "task_request", category: "할일" };
  if (target.includes("재고") || target.includes("출고") || target.includes("inventory")) return { intent: "inventory_check", category: "재고" };
  if (target.includes("입금") || target.includes("세금") || target.includes("invoice") || target.includes("정산")) return { intent: "finance_check", category: "정산" };
  if (target.includes("보고") || target.includes("report")) return { intent: "report_request", category: "보고" };
  if (target.includes("ai") || target.includes("claude") || target.includes("gpt")) return { intent: "ai_question", category: "AI검토" };
  return { intent: "message", category: "고객응대" };
}

function eventId(body: CallbackBody, receivedAt: string) {
  const messageId = body.message?.id || str(body.messageId);
  if (messageId) return `KW-${messageId}`;
  const stamp = receivedAt.replace(/\D/g, "").slice(0, 14);
  const user = String(body.user?.id || body.user?.email || "unknown").replace(/[^a-z0-9]+/gi, "-").slice(0, 32);
  return `KW-${stamp}-${user || "unknown"}`;
}

function normalizeEvent(body: CallbackBody): NormalizedKakaoWorkEvent {
  const text = body.message?.text || str(body.text);
  const event = body.event || body.type || "message";
  const receivedAt = new Date().toISOString();
  const inferred = inferIntent(text, event);

  return {
    id: eventId(body, receivedAt),
    source: "KakaoWork",
    event,
    intent: inferred.intent,
    category: inferred.category,
    userId: body.user?.id || null,
    userEmail: body.user?.email || null,
    userName: body.user?.name || null,
    conversationId: body.conversation?.id || null,
    conversationName: body.conversation?.name || null,
    conversationType: body.conversation?.type || null,
    messageId: body.message?.id || null,
    text,
    actions: body.actions || null,
    receivedAt,
  };
}

async function loadEvents(): Promise<NormalizedKakaoWorkEvent[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as NormalizedKakaoWorkEvent[]) : [];
  } catch {
    return [];
  }
}

async function saveEvent(event: NormalizedKakaoWorkEvent) {
  const events = await loadEvents();
  const index = events.findIndex((item) => item.id === event.id);
  if (index >= 0) {
    events[index] = event;
  } else {
    events.unshift(event);
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(events.slice(0, MAX_STORED_EVENTS), null, 2)}\n`, "utf8");
}

function toWorkUnitPayload(event: NormalizedKakaoWorkEvent) {
  const identity = resolveEmployeeIdentity({
    employeeName: event.userName || undefined,
    userName: event.userName || undefined,
    userEmail: event.userEmail || undefined,
    email: event.userEmail || undefined,
    userId: event.userId ? String(event.userId) : undefined,
    kakaoworkUserId: event.userId ? String(event.userId) : undefined,
  });
  const sender = identity?.employee || event.userName || event.userEmail || String(event.userId || "unknown");

  return {
    id: `KW-WU-${event.id.replace(/^KW-/, "")}`,
    type: `kakaowork.${event.event}`,
    employeeName: identity?.employee || event.userName || event.userEmail || String(event.userId || "KakaoWork"),
    employeeId: identity?.id || (event.userId ? String(event.userId) : undefined),
    userId: event.userId ? String(event.userId) : undefined,
    userEmail: event.userEmail || undefined,
    accountId: identity?.accountId || event.userEmail || (event.userId ? `kakaowork:${event.userId}` : "kakaowork:unknown"),
    team: identity?.team || event.conversationName || "KakaoWork",
    workArea: identity?.defaultWorkArea || `${event.category}/KakaoWork`,
    source: "KakaoWork",
    appName: "KakaoWork",
    windowTitle: event.conversationName || event.conversationId || "KakaoWork conversation",
    clickCount: 0,
    clickEvidence: [],
    category: event.category,
    title: `${event.category} 카카오워크 수신`,
    detail: event.text || "카카오워크 이벤트가 수신되었습니다.",
    startedAt: event.receivedAt,
    endedAt: event.receivedAt,
    confidence: 70,
    evidence: [
      "source=KakaoWork callback",
      `event=${event.event}`,
      `intent=${event.intent}`,
      `conversation=${event.conversationName || event.conversationId || "unknown"}`,
      identity ? `employee_match=${identity.matchedBy}:${identity.confidence}` : "",
    ],
    pcEvidence: ["app=KakaoWork", `conversation=${event.conversationName || event.conversationId || "unknown"}`],
    relatedTalks: [
      {
        id: event.id,
        source: "KakaoWork",
        room: event.conversationName || event.conversationId || "KakaoWork",
        sender,
        sentAt: event.receivedAt,
        text: event.text,
        intent: event.intent,
        relation: "미연결",
      },
    ],
    talkRelation: "미연결",
    validationStatus: "검증대기",
    validationMemo: "카카오워크 대화는 수신됐지만 아직 같은 시간대 PC 작업 또는 ERP 원장과 연결되지 않았습니다.",
    nextAction: "30분 창 안의 PC 작업 단위, 고객/프로젝트/할 일 원장과 매칭합니다.",
    automationCandidate: ["quote_request", "task_request", "inventory_check", "finance_check"].includes(event.intent),
  };
}

async function syncToWorkUnits(req: NextRequest, event: NormalizedKakaoWorkEvent) {
  const payload = toWorkUnitPayload(event);
  const response = await fetch(new URL("/api/work-units", req.nextUrl.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { ok: response.ok, status: response.status, payload, response: body };
}

async function syncToErpIntake(req: NextRequest, event: NormalizedKakaoWorkEvent) {
  const identity = resolveEmployeeIdentity({
    employeeName: event.userName || undefined,
    userName: event.userName || undefined,
    userEmail: event.userEmail || undefined,
    email: event.userEmail || undefined,
    userId: event.userId ? String(event.userId) : undefined,
    kakaoworkUserId: event.userId ? String(event.userId) : undefined,
  });
  const response = await fetch(new URL("/api/erp/intake", req.nextUrl.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      id: `ERP-IN-${event.id}`,
      source: "KakaoWork",
      sourceEventId: event.id,
      intent: event.intent,
      category: event.category,
      title: `${event.category} 카카오워크 요청`,
      detail: event.text || "카카오워크에서 업무 요청이 들어왔습니다.",
      owner: identity?.employee || event.userName || "미지정",
      accountId: identity?.accountId || event.userEmail || undefined,
      team: identity?.team || event.conversationName || undefined,
      conversationName: event.conversationName || undefined,
      evidence: [
        `source=KakaoWork callback`,
        `event=${event.event}`,
        `intent=${event.intent}`,
        `conversation=${event.conversationName || event.conversationId || "unknown"}`,
        identity ? `employee_match=${identity.matchedBy}:${identity.confidence}` : "",
      ].filter(Boolean),
    }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { ok: response.ok, status: response.status, response: body };
}

export async function GET() {
  const events = await loadEvents();
  return NextResponse.json({
    status: "ready",
    storage: {
      mode: "file",
      path: "nenova-erp-ui/data/kakaowork-events.json",
      maxStoredEvents: MAX_STORED_EVENTS,
    },
    receivedCount: events.length,
    recent: events.slice(0, 20),
  });
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ error: "카카오워크 콜백 시크릿이 일치하지 않습니다." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as CallbackBody;
  const normalized = normalizeEvent(body);
  await saveEvent(normalized);
  const shouldSync = body.syncWorkUnit !== false;
  const shouldSyncIntake = body.syncErpIntake !== false && ["quote_request", "task_request", "inventory_check", "finance_check", "project_update"].includes(normalized.intent);
  let workUnitSync = null;
  if (shouldSync) {
    try {
      workUnitSync = await syncToWorkUnits(req, normalized);
    } catch (err) {
      workUnitSync = { ok: false, error: err instanceof Error ? err.message : "work unit sync failed" };
    }
  }
  let erpIntakeSync = null;
  if (shouldSyncIntake) {
    try {
      erpIntakeSync = await syncToErpIntake(req, normalized);
    } catch (err) {
      erpIntakeSync = { ok: false, error: err instanceof Error ? err.message : "ERP intake sync failed" };
    }
  }

  return NextResponse.json({
    received: true,
    mode: "ingest",
    normalized,
    workUnitSync,
    erpIntakeSync,
    nextPipeline: [
      "work_event.raw 저장",
      "직원/대화방 매핑",
      "AI 의도 분류",
      "작업 단위 relatedTalks 후보 등록",
      "ERP 초안 수신함 등록",
      "PC 작업/ERP 원장과 30분 창 교차검증",
      "카카오워크 확인 메시지 발송",
    ],
  });
}
