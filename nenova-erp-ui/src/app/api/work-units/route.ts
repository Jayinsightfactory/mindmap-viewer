import { NextRequest, NextResponse } from "next/server";

type WorkUnitPayload = {
  employee?: string;
  employeeName?: string;
  employeeId?: string;
  accountId?: string;
  team?: string;
  workArea?: string;
  source?: string;
  appName?: string;
  windowTitle?: string;
  clickCount?: number;
  clickEvidence?: string[];
  category?: string;
  title?: string;
  summary?: string;
  detail?: string;
  customer?: string;
  projectId?: string;
  taskId?: string;
  startedAt?: string;
  endedAt?: string;
  durationSec?: number;
  confidence?: number;
  evidence?: string[];
  pcEvidence?: string[];
  relatedTalks?: Array<{
    source?: "KakaoTalk" | "KakaoWork";
    room?: string;
    sender?: string;
    sentAt?: string;
    text?: string;
    intent?: string;
    relation?: string;
  }>;
};

type NormalizedWorkUnit = {
  id: string;
  receivedAt: string;
  source: string;
  employee: string;
  employeeId?: string;
  accountId: string;
  team: string;
  workArea: string;
  category: string;
  title: string;
  detail: string;
  appName: string;
  windowTitle: string;
  clickCount: number;
  clickEvidence: string[];
  customer?: string;
  projectId?: string;
  taskId?: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  durationMin: number;
  confidence: number;
  evidence: string[];
  pcEvidence: string[];
  relatedTalks: Array<{
    source: "KakaoTalk" | "KakaoWork";
    room: string;
    sender: string;
    sentAt: string;
    text: string;
    intent: string;
    relation: string;
  }>;
  talkRelation: string;
  validationStatus: string;
  validationMemo: string;
  status: "수집";
};

const receivedWorkUnits: NormalizedWorkUnit[] = [];

function iso(value?: string) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function normalize(payload: WorkUnitPayload): NormalizedWorkUnit {
  const startedAt = iso(payload.startedAt);
  const fallbackEnd = new Date(new Date(startedAt).getTime() + Math.max(1, Number(payload.durationSec || 60)) * 1000).toISOString();
  const endedAt = iso(payload.endedAt || fallbackEnd);
  const durationSec = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const employee = String(payload.employee || payload.employeeName || payload.employeeId || "미지정").trim();
  const appName = String(payload.appName || "nenova.exe").trim();
  const windowTitle = String(payload.windowTitle || "작업 창 미수집").trim();
  const relatedTalks = (payload.relatedTalks || []).map((talk, index) => ({
    source: talk.source || "KakaoTalk",
    room: String(talk.room || "대화방 미수집"),
    sender: String(talk.sender || "미지정"),
    sentAt: iso(talk.sentAt),
    text: String(talk.text || ""),
    intent: String(talk.intent || "unknown"),
    relation: String(talk.relation || "미연결"),
    id: `TALK-${index + 1}`,
  }));
  const talkRelation = relatedTalks[0]?.relation || "미연결";

  return {
    id: `WU-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(receivedWorkUnits.length + 1).padStart(3, "0")}`,
    receivedAt: new Date().toISOString(),
    source: String(payload.source || "nenova.exe"),
    employee,
    employeeId: payload.employeeId,
    accountId: String(payload.accountId || payload.employeeId || employee),
    team: String(payload.team || "미지정"),
    workArea: String(payload.workArea || payload.category || "기타"),
    category: String(payload.category || "기타"),
    title: String(payload.title || payload.summary || `${appName} 작업`).slice(0, 120),
    detail: String(payload.detail || payload.summary || `${windowTitle}에서 수집된 작업 단위입니다.`),
    appName,
    windowTitle,
    clickCount: Math.max(0, Number(payload.clickCount || 0)),
    clickEvidence: payload.clickEvidence || [],
    customer: payload.customer,
    projectId: payload.projectId,
    taskId: payload.taskId,
    startedAt,
    endedAt,
    durationSec,
    durationMin: Math.max(1, Math.round(durationSec / 60)),
    confidence: Math.min(100, Math.max(0, Number(payload.confidence ?? 70))),
    evidence: [
      ...(payload.evidence || []),
      `source=${payload.source || "nenova.exe"}`,
      `app=${appName}`,
      `window=${windowTitle}`,
    ],
    pcEvidence: payload.pcEvidence || [`app=${appName}`, `window=${windowTitle}`],
    relatedTalks,
    talkRelation,
    validationStatus: relatedTalks.length && appName ? "부분일치" : "검증대기",
    validationMemo: relatedTalks.length
      ? "대화 데이터와 PC 작업 이벤트가 같은 작업 단위 후보로 묶였습니다. ERP 고객/프로젝트 연결 확인이 필요합니다."
      : "카카오톡/워크 대화 연결이 없어 PC 작업 데이터만 수집된 상태입니다.",
    status: "수집",
  };
}

export async function GET() {
  return NextResponse.json({
    status: "ready",
    endpoint: "POST /api/work-units",
    purpose: "nenova.exe 직원 작업 이벤트를 네노바웹 작업 단위로 정규화합니다.",
    mergeRules: {
      mergeWindowSec: 30,
      sessionGapMin: 5,
      minimumBlockSec: 5,
      timezone: "Asia/Seoul",
    },
    expectedPayload: {
      employeeName: "설연주",
      accountId: "nenova:sales-support:sul-yeonju",
      team: "영업지원",
      workArea: "견적/거래처 단가",
      source: "nenova.exe",
      appName: "nenova.exe",
      windowTitle: "견적관리 - 거래처 단가",
      clickCount: 34,
      clickEvidence: ["거래처 검색", "품목 행 추가", "공급가 입력"],
      category: "견적",
      title: "대한상사 견적 단가표 입력",
      startedAt: "2026-05-24T09:10:00+09:00",
      endedAt: "2026-05-24T09:32:00+09:00",
      projectId: "PRJ-...",
      taskId: "TSK-...",
      confidence: 88,
      relatedTalks: [
        {
          source: "KakaoTalk",
          room: "대한상사",
          sender: "김철수 과장",
          sentAt: "2026-05-24T09:07:00+09:00",
          text: "6월 단가표 오늘 받을 수 있을까요?",
          intent: "quote_request",
          relation: "대화후작업",
        },
      ],
    },
    receivedCount: receivedWorkUnits.length,
    recent: receivedWorkUnits.slice(-20).reverse(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as WorkUnitPayload;
    const unit = normalize(payload);
    receivedWorkUnits.push(unit);
    return NextResponse.json({
      ok: true,
      unit,
      next: [
        "DB 연결 시 work_unit 원장에 저장",
        "employee/project/task 매핑 검증",
        "Claude 교차검증 에이전트 컨텍스트에 포함",
      ],
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "작업 단위 수집 실패" },
      { status: 500 },
    );
  }
}
