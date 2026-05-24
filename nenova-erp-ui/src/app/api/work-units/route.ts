import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type TalkSource = "KakaoTalk" | "KakaoWork";
type WorkUnitSource = "nenova.exe" | "KakaoTalk" | "KakaoWork" | "GoogleSheet" | "nenovaweb" | "Mindmap" | "PC";
type WorkUnitCategory = "고객응대" | "견적" | "계약" | "프로젝트" | "할일" | "정산" | "재고" | "보고" | "AI검토" | "기타";
type TalkWorkRelation = "대화후작업" | "작업후대화" | "동시진행" | "미연결";
type CrossValidationStatus = "일치" | "부분일치" | "충돌" | "검증대기";

type WorkUnitPayload = {
  id?: string;
  type?: string;
  eventType?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  period?: { start?: string; end?: string };
  employee?: string;
  employeeName?: string;
  employeeId?: string;
  userName?: string;
  accountId?: string;
  team?: string;
  workArea?: string;
  source?: string;
  app?: string;
  appName?: string;
  window?: string;
  windowTitle?: string;
  clickCount?: number;
  clicks?: number;
  mouseClicks?: number;
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
  durationMin?: number;
  confidence?: number;
  evidence?: string[];
  pcEvidence?: string[];
  nextAction?: string;
  automationCandidate?: boolean;
  validationStatus?: string;
  validationMemo?: string;
  talkRelation?: string;
  relatedTalks?: Array<{
    id?: string;
    source?: TalkSource;
    room?: string;
    sender?: string;
    sentAt?: string;
    text?: string;
    intent?: string;
    relation?: string;
  }>;
};

type NormalizedTalk = {
  id: string;
  source: TalkSource;
  room: string;
  sender: string;
  sentAt: string;
  text: string;
  intent: string;
  relation: TalkWorkRelation;
};

type NormalizedWorkUnit = {
  id: string;
  receivedAt: string;
  sourceEventType: string;
  source: WorkUnitSource;
  employee: string;
  employeeId?: string;
  accountId: string;
  team: string;
  workArea: string;
  category: WorkUnitCategory;
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
  relatedTalks: NormalizedTalk[];
  talkRelation: TalkWorkRelation;
  validationStatus: CrossValidationStatus;
  validationMemo: string;
  status: "수집";
  nextAction: string;
  automationCandidate: boolean;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "work-units.json");
const MAX_STORED_UNITS = 2000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function readNumber(...values: unknown[]) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readString(item)).filter(Boolean);
}

function iso(value?: unknown, fallback = new Date()) {
  const parsed = value ? new Date(String(value)) : fallback;
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback.toISOString();
}

function normalizeTalkSource(value: unknown): TalkSource {
  const text = readString(value).toLowerCase();
  return text.includes("work") || text.includes("워크") ? "KakaoWork" : "KakaoTalk";
}

function normalizeRelation(value: unknown): TalkWorkRelation {
  const text = readString(value);
  if (text === "대화후작업" || text === "작업후대화" || text === "동시진행") return text;
  const lower = text.toLowerCase();
  if (["talk_before_work", "conversation_to_work", "chat_before_work", "before_work"].includes(lower)) return "대화후작업";
  if (["work_before_talk", "work_to_conversation", "work_before_chat", "after_work"].includes(lower)) return "작업후대화";
  if (["simultaneous", "during_work", "same_time"].includes(lower)) return "동시진행";
  return "미연결";
}

function normalizeValidation(value: unknown, relatedTalks: NormalizedTalk[], appName: string): CrossValidationStatus {
  const text = readString(value);
  if (text === "일치" || text === "부분일치" || text === "충돌" || text === "검증대기") return text;
  if (relatedTalks.length && appName) return relatedTalks.some((talk) => talk.relation !== "미연결") ? "부분일치" : "검증대기";
  return "검증대기";
}

function inferSource(source: string, appName: string, eventType: string): WorkUnitSource {
  const text = `${source} ${appName} ${eventType}`.toLowerCase();
  if (text.includes("nenova.exe")) return "nenova.exe";
  if (text.includes("kakaowork") || text.includes("카카오워크")) return "KakaoWork";
  if (text.includes("kakaotalk") || text.includes("카카오톡")) return "KakaoTalk";
  if (text.includes("sheet") || text.includes("spreadsheet") || text.includes("구글시트")) return "GoogleSheet";
  if (text.includes("nenovaweb")) return "nenovaweb";
  if (text.includes("mindmap") || text.includes("claude") || text.includes("gpt")) return "Mindmap";
  return "PC";
}

function inferCategory(input: string): WorkUnitCategory {
  const text = input.toLowerCase();
  if (text.includes("견적") || text.includes("quote")) return "견적";
  if (text.includes("계약") || text.includes("contract")) return "계약";
  if (text.includes("프로젝트") || text.includes("project")) return "프로젝트";
  if (text.includes("할 일") || text.includes("할일") || text.includes("task")) return "할일";
  if (text.includes("세금") || text.includes("입금") || text.includes("정산") || text.includes("invoice")) return "정산";
  if (text.includes("재고") || text.includes("출고") || text.includes("inventory")) return "재고";
  if (text.includes("보고") || text.includes("report")) return "보고";
  if (text.includes("ai") || text.includes("claude") || text.includes("gpt")) return "AI검토";
  if (text.includes("kakao") || text.includes("카카오") || text.includes("상담") || text.includes("고객")) return "고객응대";
  return "기타";
}

function inferTalkRelation(relatedTalks: NormalizedTalk[], startedAt: string, endedAt: string): TalkWorkRelation {
  const explicit = relatedTalks.find((talk) => talk.relation !== "미연결")?.relation;
  if (explicit) return explicit;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const firstTalk = relatedTalks[0] ? new Date(relatedTalks[0].sentAt).getTime() : Number.NaN;
  if (!Number.isFinite(firstTalk)) return "미연결";
  if (firstTalk < start) return "대화후작업";
  if (firstTalk > end) return "작업후대화";
  return "동시진행";
}

function nextUnitId(units: NormalizedWorkUnit[], startedAt: string) {
  const ymd = startedAt.slice(0, 10).replace(/-/g, "");
  const prefix = `WU-${ymd}-`;
  const max = units.reduce((current, unit) => {
    if (!unit.id.startsWith(prefix)) return current;
    const seq = Number(unit.id.slice(prefix.length));
    return Number.isFinite(seq) ? Math.max(current, seq) : current;
  }, 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

async function loadUnits(): Promise<NormalizedWorkUnit[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as NormalizedWorkUnit[];
    const object = asRecord(parsed);
    return Array.isArray(object.units) ? (object.units as NormalizedWorkUnit[]) : [];
  } catch {
    return [];
  }
}

async function saveUnits(units: NormalizedWorkUnit[]) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(units, null, 2)}\n`, "utf8");
}

function normalize(payload: WorkUnitPayload, existingUnits: NormalizedWorkUnit[]): NormalizedWorkUnit {
  const data = asRecord(payload.data);
  const period = asRecord(data.period ?? payload.period);
  const eventType = readString(payload.eventType, payload.type, data.type, data.eventType, "work_unit");
  const startedAt = iso(payload.startedAt ?? period.start ?? data.startedAt ?? data.start ?? payload.timestamp ?? data.timestamp);
  const durationSecInput = readNumber(payload.durationSec, data.durationSec, payload.durationMin ? payload.durationMin * 60 : undefined);
  const fallbackEnd = new Date(new Date(startedAt).getTime() + Math.max(1, durationSecInput ?? 60) * 1000);
  const endedAt = iso(payload.endedAt ?? period.end ?? data.endedAt ?? data.end, fallbackEnd);
  const durationSec = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const employee = readString(payload.employee, payload.employeeName, data.employee, data.employeeName, payload.userName, data.userName, payload.employeeId, "미지정");
  const employeeId = readString(payload.employeeId, data.employeeId) || undefined;
  const appName = readString(payload.appName, payload.app, data.appName, data.app, "nenova.exe");
  const windowTitle = readString(payload.windowTitle, payload.window, data.windowTitle, data.window, "작업 창 미수집");
  const source = inferSource(readString(payload.source, data.source), appName, eventType);
  const category = inferCategory(readString(payload.category, data.category, payload.workArea, payload.title, payload.summary, appName, windowTitle));
  const clickCount = Math.max(0, Math.round(readNumber(payload.clickCount, payload.clicks, payload.mouseClicks, data.clickCount, data.clicks, data.mouseClicks) ?? 0));
  const payloadClickEvidence = readStringList(payload.clickEvidence);
  const dataClickEvidence = readStringList(data.clickEvidence);
  const clickEvidence = payloadClickEvidence.length ? payloadClickEvidence : dataClickEvidence;
  const relatedTalks = (Array.isArray(payload.relatedTalks) ? payload.relatedTalks : []).map((talk, index) => {
    const sentAt = iso(talk.sentAt, new Date(startedAt));
    return {
      id: readString(talk.id, `TALK-${index + 1}`),
      source: normalizeTalkSource(talk.source),
      room: readString(talk.room, "대화방 미수집"),
      sender: readString(talk.sender, "미지정"),
      sentAt,
      text: readString(talk.text),
      intent: readString(talk.intent, "unknown"),
      relation: normalizeRelation(talk.relation),
    };
  });
  const payloadRelationText = readString(payload.talkRelation);
  const payloadRelation = normalizeRelation(payloadRelationText);
  const talkRelation = payloadRelationText ? payloadRelation : inferTalkRelation(relatedTalks, startedAt, endedAt);
  const validationStatus = normalizeValidation(payload.validationStatus, relatedTalks, appName);
  const evidence = [
    ...readStringList(payload.evidence),
    ...readStringList(data.evidence),
    `event_type=${eventType}`,
    `source=${source}`,
    `app=${appName}`,
    `window=${windowTitle}`,
  ];
  const payloadPcEvidence = readStringList(payload.pcEvidence);
  const dataPcEvidence = readStringList(data.pcEvidence);
  const pcEvidence = payloadPcEvidence.length
    ? payloadPcEvidence
    : dataPcEvidence.length
      ? dataPcEvidence
      : [`app=${appName}`, `window=${windowTitle}`, `clicks=${clickCount}`];

  return {
    id: readString(payload.id, data.id) || nextUnitId(existingUnits, startedAt),
    receivedAt: new Date().toISOString(),
    sourceEventType: eventType,
    source,
    employee,
    employeeId,
    accountId: readString(payload.accountId, data.accountId, employeeId, employee),
    team: readString(payload.team, data.team, "미지정"),
    workArea: readString(payload.workArea, data.workArea, category),
    category,
    title: readString(payload.title, payload.summary, data.title, data.summary, `${appName} 작업`).slice(0, 120),
    detail: readString(payload.detail, payload.summary, data.detail, data.summary, `${windowTitle}에서 수집된 작업 단위입니다.`),
    appName,
    windowTitle,
    clickCount,
    clickEvidence,
    customer: readString(payload.customer, data.customer) || undefined,
    projectId: readString(payload.projectId, data.projectId) || undefined,
    taskId: readString(payload.taskId, data.taskId) || undefined,
    startedAt,
    endedAt,
    durationSec,
    durationMin: Math.max(1, Math.round(durationSec / 60)),
    confidence: Math.min(100, Math.max(0, readNumber(payload.confidence, data.confidence) ?? (relatedTalks.length ? 78 : 64))),
    evidence: Array.from(new Set(evidence.filter(Boolean))),
    pcEvidence: Array.from(new Set(pcEvidence.filter(Boolean))),
    relatedTalks,
    talkRelation,
    validationStatus,
    validationMemo:
      readString(payload.validationMemo, data.validationMemo) ||
      (relatedTalks.length
        ? "대화 데이터와 PC 작업 이벤트가 같은 작업 단위 후보로 묶였습니다. ERP 고객/프로젝트 연결 확인이 필요합니다."
        : "카카오톡/워크 대화 연결이 없어 PC 작업 데이터만 수집된 상태입니다."),
    status: "수집",
    nextAction:
      readString(payload.nextAction, data.nextAction) ||
      (relatedTalks.length ? "ERP 고객/프로젝트/할 일과 연결해 3차 검증을 완료합니다." : "같은 시간대 카카오톡/워크 대화와 ERP 화면 기록을 추가 매칭합니다."),
    automationCandidate: Boolean(payload.automationCandidate ?? data.automationCandidate ?? (clickCount >= 20 && relatedTalks.length > 0)),
  };
}

function upsertUnit(units: NormalizedWorkUnit[], unit: NormalizedWorkUnit) {
  const index = units.findIndex((item) => item.id === unit.id);
  if (index >= 0) {
    units[index] = { ...units[index], ...unit };
  } else {
    units.push(unit);
  }
  return units
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_STORED_UNITS);
}

export async function GET() {
  const units = await loadUnits();
  return NextResponse.json({
    status: "ready",
    endpoint: "POST /api/work-units",
    purpose: "nenova.exe, PC 이벤트, 카카오톡/워크 데이터를 네노바웹 직원 작업 단위로 정규화해 저장합니다.",
    storage: {
      mode: "file",
      path: "nenova-erp-ui/data/work-units.json",
      maxStoredUnits: MAX_STORED_UNITS,
    },
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
    receivedCount: units.length,
    lastReceivedAt: units[0]?.receivedAt ?? null,
    recent: units.slice(0, 20),
    units,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as WorkUnitPayload | WorkUnitPayload[] | { units?: WorkUnitPayload[] };
    const payloads = Array.isArray(body) ? body : Array.isArray((body as { units?: WorkUnitPayload[] }).units) ? (body as { units: WorkUnitPayload[] }).units : [body as WorkUnitPayload];
    let units = await loadUnits();
    const normalizedUnits: NormalizedWorkUnit[] = [];

    for (const payload of payloads) {
      const unit = normalize(payload, units);
      normalizedUnits.push(unit);
      units = upsertUnit(units, unit);
    }

    await saveUnits(units);

    return NextResponse.json({
      ok: true,
      count: normalizedUnits.length,
      total: units.length,
      unit: normalizedUnits[0],
      units: normalizedUnits,
      next: [
        "employee/project/task 매핑 검증",
        "KakaoTalk/KakaoWork 대화 전후관계 재계산",
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
