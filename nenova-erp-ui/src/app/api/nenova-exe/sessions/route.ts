import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type WorkUnitCategory = "고객응대" | "견적" | "계약" | "프로젝트" | "할일" | "정산" | "재고" | "보고" | "AI검토" | "기타";
type WorkUnitSource = "nenova.exe" | "PC";

type StoredNenovaEvent = {
  id: string;
  receivedAt: string;
  type: string;
  timestamp: string;
  sessionId: string;
  parentEventId?: string;
  employee: string;
  employeeId?: string;
  accountId: string;
  team: string;
  workArea: string;
  hostname: string;
  deviceId: string;
  source: WorkUnitSource;
  appName: string;
  processName: string;
  executablePath: string;
  windowTitle: string;
  url?: string;
  mouseClicks: number;
  keyboardCount: number;
  screenSummary: string;
  category: WorkUnitCategory;
  confidence: number;
  workUnitId: string;
};

type WorkUnitPayload = {
  id: string;
  type: string;
  eventType: string;
  source: WorkUnitSource;
  employeeName: string;
  employeeId?: string;
  accountId: string;
  hostname: string;
  team: string;
  workArea: string;
  appName: string;
  windowTitle: string;
  clickCount: number;
  clickEvidence: string[];
  category: WorkUnitCategory;
  title: string;
  detail: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  confidence: number;
  evidence: string[];
  pcEvidence: string[];
  validationStatus: "검증대기";
  validationMemo: string;
  nextAction: string;
  automationCandidate: boolean;
};

type SessionCandidate = {
  id: string;
  workUnitId: string;
  employee: string;
  employeeId?: string;
  accountId: string;
  team: string;
  workArea: string;
  source: WorkUnitSource;
  category: WorkUnitCategory;
  appName: string;
  windowTitle: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  durationMin: number;
  eventCount: number;
  mouseClicks: number;
  keyboardCount: number;
  screenCount: number;
  confidence: number;
  eventIds: string[];
  reasons: string[];
  recommendation: string;
  workUnit: WorkUnitPayload;
};

type SessionPostBody = {
  sessionIds?: string[];
  ids?: string[];
  date?: string;
  employee?: string;
  accountId?: string;
  gapMin?: number;
  limit?: number;
};

const DATA_FILE = path.join(process.cwd(), "data", "nenova-exe-events.json");

function readString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function readNumber(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function slug(value: string) {
  return value
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function compact(value: string, max = 140) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function dateKeyKst(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function minutesBetween(start: string, end: string) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 1;
  return Math.max(1, Math.round((endMs - startMs) / 60000));
}

function addSeconds(dateIso: string, seconds: number) {
  return new Date(new Date(dateIso).getTime() + Math.max(1, seconds) * 1000).toISOString();
}

function mode<T extends string>(values: T[], fallback: T): T {
  const counts = values.reduce<Record<string, number>>((acc, value) => {
    if (value) acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as T | undefined) || fallback;
}

async function loadEvents(): Promise<StoredNenovaEvent[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredNenovaEvent[]) : [];
  } catch {
    return [];
  }
}

function filterEvents(events: StoredNenovaEvent[], filters: { date?: string; employee?: string; accountId?: string }) {
  return events.filter((event) => {
    const dateOk = !filters.date || dateKeyKst(event.timestamp) === filters.date;
    const employeeOk = !filters.employee || event.employee === filters.employee;
    const accountOk = !filters.accountId || event.accountId === filters.accountId;
    return dateOk && employeeOk && accountOk;
  });
}

function baseGroupKey(event: StoredNenovaEvent) {
  return [event.accountId || event.employee, event.sessionId || "session-unknown", event.category || "기타", event.appName || "PC"].join("|");
}

function splitIntoGroups(events: StoredNenovaEvent[], gapMin: number) {
  const byKey = new Map<string, StoredNenovaEvent[]>();
  events.forEach((event) => {
    const key = baseGroupKey(event);
    byKey.set(key, [...(byKey.get(key) || []), event]);
  });

  const groups: StoredNenovaEvent[][] = [];
  byKey.forEach((groupEvents) => {
    const ordered = [...groupEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let current: StoredNenovaEvent[] = [];
    ordered.forEach((event) => {
      const previous = current[current.length - 1];
      const gapMs = previous ? new Date(event.timestamp).getTime() - new Date(previous.timestamp).getTime() : 0;
      if (previous && gapMs > gapMin * 60000) {
        groups.push(current);
        current = [event];
      } else {
        current.push(event);
      }
    });
    if (current.length) groups.push(current);
  });
  return groups;
}

function buildSessionCandidate(group: StoredNenovaEvent[], index: number): SessionCandidate {
  const ordered = [...group].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const startedAt = first.timestamp;
  const endedAt = addSeconds(last.timestamp, 60);
  const durationMin = minutesBetween(startedAt, endedAt);
  const durationSec = durationMin * 60;
  const source = ordered.some((event) => event.source === "nenova.exe") ? "nenova.exe" : "PC";
  const category = mode(
    ordered.map((event) => event.category).filter(Boolean),
    first.category || "기타",
  );
  const appName = mode(
    ordered.map((event) => event.appName).filter(Boolean),
    first.appName || "PC",
  );
  const windowTitle = mode(
    ordered.map((event) => event.windowTitle).filter(Boolean),
    first.windowTitle || "작업 창 미수집",
  );
  const workArea = mode(
    ordered.map((event) => event.workArea).filter(Boolean),
    first.workArea || category,
  );
  const mouseClicks = ordered.reduce((sum, event) => sum + (Number(event.mouseClicks) || 0), 0);
  const keyboardCount = ordered.reduce((sum, event) => sum + (Number(event.keyboardCount) || 0), 0);
  const screenSummaries = Array.from(new Set(ordered.map((event) => compact(event.screenSummary || "", 90)).filter(Boolean))).slice(0, 4);
  const screenCount = ordered.filter((event) => event.screenSummary).length;
  const confidence = Math.min(96, Math.round(ordered.reduce((sum, event) => sum + (Number(event.confidence) || 70), 0) / ordered.length) + (ordered.length > 1 ? 4 : 0));
  const sessionSlug = slug(`${first.accountId}-${first.sessionId}`) || slug(first.sessionId) || "session";
  const startStamp = startedAt.replace(/\D/g, "").slice(0, 14);
  const id = `NXS-${sessionSlug}-${startStamp}-${index + 1}`;
  const workUnitId = `NX-SESSION-${sessionSlug}-${startStamp}-${index + 1}`;
  const windowTitles = Array.from(new Set(ordered.map((event) => event.windowTitle).filter(Boolean))).slice(0, 5);
  const reasons = [
    `이벤트 ${ordered.length}건`,
    `${durationMin}분 세션`,
    `클릭 ${mouseClicks}회`,
    keyboardCount ? `키보드 ${keyboardCount}회` : "",
    screenCount ? `화면요약 ${screenCount}건` : "",
    `세션 ${first.sessionId}`,
  ].filter(Boolean);
  const evidence = Array.from(
    new Set(
      [
        `session_group=${id}`,
        `source_events=${ordered.length}`,
        `event_ids=${ordered.map((event) => event.id).slice(0, 12).join(",")}`,
        `session_id=${first.sessionId}`,
        first.hostname ? `hostname=${first.hostname}` : "",
        `category=${category}`,
        `mouse_clicks=${mouseClicks}`,
        `keyboard_count=${keyboardCount}`,
        screenSummaries.length ? `screen_summaries=${screenSummaries.join(" | ")}` : "",
      ].filter(Boolean),
    ),
  );
  const pcEvidence = Array.from(
    new Set(
      [
        `app=${appName}`,
        `window=${compact(windowTitle, 120)}`,
        first.hostname ? `hostname=${first.hostname}` : "",
        `session=${first.sessionId}`,
        `events=${ordered.length}`,
        `clicks=${mouseClicks}`,
        `keyboard=${keyboardCount}`,
        ...screenSummaries.map((summary) => `screen=${summary}`),
      ].filter(Boolean),
    ),
  );
  const title = `${first.employee} ${category} 세션 작업`;
  const detail = `${appName}/${windowTitle}에서 ${ordered.length}개 PC 이벤트가 ${durationMin}분짜리 실제 작업 흐름으로 묶였습니다.`;
  const workUnit: WorkUnitPayload = {
    id: workUnitId,
    type: "nenova.exe.session",
    eventType: "nenova.exe.session",
    source,
    employeeName: first.employee,
    employeeId: first.employeeId,
    accountId: first.accountId,
    hostname: first.hostname,
    team: first.team,
    workArea,
    appName,
    windowTitle,
    clickCount: mouseClicks,
    clickEvidence: windowTitles.map((titleItem) => `window=${compact(titleItem, 80)}`).slice(0, 8),
    category,
    title,
    detail,
    startedAt,
    endedAt,
    durationSec,
    confidence,
    evidence,
    pcEvidence,
    validationStatus: "검증대기",
    validationMemo: "원본 nenova.exe/PC 이벤트를 세션 단위로 병합했습니다. 카톡/카카오워크 대화 연결 후 직원 워크플로우 검증을 확정합니다.",
    nextAction: "같은 시간대 카톡/카카오워크 대화와 연결하고, 필요하면 ERP/구글시트 결과 데이터로 3차 검증합니다.",
    automationCandidate: ordered.length >= 4 || mouseClicks >= 20,
  };

  return {
    id,
    workUnitId,
    employee: first.employee,
    employeeId: first.employeeId,
    accountId: first.accountId,
    team: first.team,
    workArea,
    source,
    category,
    appName,
    windowTitle,
    startedAt,
    endedAt,
    durationSec,
    durationMin,
    eventCount: ordered.length,
    mouseClicks,
    keyboardCount,
    screenCount,
    confidence,
    eventIds: ordered.map((event) => event.id),
    reasons,
    recommendation: `${first.employee} ${category} 업무를 ${durationMin}분 세션으로 병합`,
    workUnit,
  };
}

function buildSessionCandidates(
  events: StoredNenovaEvent[],
  options: { date?: string; employee?: string; accountId?: string; gapMin: number; limit: number },
) {
  return splitIntoGroups(filterEvents(events, options), options.gapMin)
    .map((group, index) => buildSessionCandidate(group, index))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, options.limit);
}

async function syncWorkUnits(req: NextRequest, units: WorkUnitPayload[]) {
  if (!units.length) return { ok: true, status: 204, count: 0 };
  try {
    const response = await fetch(new URL("/api/work-units", req.nextUrl.origin), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ units }),
    });
    const result = (await response.json().catch(() => ({}))) as { ok?: boolean; count?: number; total?: number; error?: string };
    return {
      ok: response.ok && result.ok !== false,
      status: response.status,
      count: result.count ?? units.length,
      total: result.total,
      error: result.error,
    };
  } catch (err) {
    return { ok: false, status: 0, count: 0, error: err instanceof Error ? err.message : "work unit sync failed" };
  }
}

function optionsFromRequest(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  return {
    date: readString(params.get("date")) || undefined,
    employee: readString(params.get("employee")) || undefined,
    accountId: readString(params.get("accountId")) || undefined,
    gapMin: Math.min(60, Math.max(1, Math.round(readNumber(params.get("gapMin")) ?? 5))),
    limit: Math.min(200, Math.max(1, Math.round(readNumber(params.get("limit")) ?? 50))),
  };
}

export async function GET(req: NextRequest) {
  const events = await loadEvents();
  const options = optionsFromRequest(req);
  const sessions = buildSessionCandidates(events, options);
  return NextResponse.json({
    status: "ready",
    endpoint: "GET/POST /api/nenova-exe/sessions",
    purpose: "잘게 들어온 nenova.exe/PC 이벤트를 직원 실제 업무 세션 단위로 병합합니다.",
    rules: {
      gapMin: options.gapMin,
      groupBy: ["accountId", "sessionId", "category", "appName"],
      source: "하나라도 nenova.exe 이벤트가 있으면 세션 source를 nenova.exe로 봅니다.",
    },
    totalRawEvents: events.length,
    count: sessions.length,
    sessions,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SessionPostBody;
    const events = await loadEvents();
    const options = {
      date: body.date,
      employee: body.employee,
      accountId: body.accountId,
      gapMin: Math.min(60, Math.max(1, Math.round(Number(body.gapMin) || 5))),
      limit: Math.min(200, Math.max(1, Math.round(Number(body.limit) || 50))),
    };
    const selectedIds = new Set([...(body.sessionIds || []), ...(body.ids || [])]);
    const sessions = buildSessionCandidates(events, options).filter((session) => !selectedIds.size || selectedIds.has(session.id) || selectedIds.has(session.workUnitId));
    const workUnits = sessions.map((session) => session.workUnit);
    const workUnitSync = await syncWorkUnits(req, workUnits);
    return NextResponse.json({
      ok: true,
      count: sessions.length,
      pushed: workUnits.length,
      sessions,
      workUnits,
      workUnitSync,
      next: ["세션 작업 단위를 카톡/카카오워크 연결 후보와 매칭", "직원별 업무 리스크에서 세션 단위 근거 우선 반영"],
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "nenova.exe session merge failed" }, { status: 500 });
  }
}
