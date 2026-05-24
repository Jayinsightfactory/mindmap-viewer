import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { resolveEmployeeIdentity } from "@/lib/employee-directory";

export const runtime = "nodejs";

type WorkUnitCategory = "고객응대" | "견적" | "계약" | "프로젝트" | "할일" | "정산" | "재고" | "보고" | "AI검토" | "기타";
type WorkUnitSource = "nenova.exe" | "PC";

type RawNenovaEvent = Record<string, unknown> & {
  id?: string;
  type?: string;
  eventType?: string;
  sessionId?: string;
  parentEventId?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  events?: RawNenovaEvent[];
};

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
  raw: RawNenovaEvent;
};

type WorkUnitPayload = {
  id: string;
  type: string;
  eventType: string;
  timestamp: string;
  employeeName: string;
  employeeId?: string;
  accountId: string;
  userId?: string;
  userEmail?: string;
  hostname: string;
  team: string;
  workArea: string;
  source: WorkUnitSource;
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
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "nenova-exe-events.json");
const MAX_STORED_EVENTS = 5000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function iso(value?: unknown, fallback = new Date()) {
  const parsed = value ? new Date(String(value)) : fallback;
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback.toISOString();
}

function addSeconds(dateIso: string, seconds: number) {
  return new Date(new Date(dateIso).getTime() + Math.max(1, seconds) * 1000).toISOString();
}

function compact(value: string, max = 140) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function slug(value: string) {
  return value
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function inferCategory(input: string): WorkUnitCategory {
  const text = input.toLowerCase();
  if (text.includes("견적") || text.includes("quote") || text.includes("단가")) return "견적";
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

function inferSource(appName: string, processName: string, executablePath: string): WorkUnitSource {
  const text = `${appName} ${processName} ${executablePath}`.toLowerCase();
  return text.includes("nenova.exe") ? "nenova.exe" : "PC";
}

function inferConfidence(input: {
  hasIdentity: boolean;
  mouseClicks: number;
  keyboardCount: number;
  screenSummary: string;
  windowTitle: string;
}) {
  let score = input.hasIdentity ? 72 : 58;
  if (input.windowTitle && input.windowTitle !== "작업 창 미수집") score += 6;
  if (input.mouseClicks > 0) score += 6;
  if (input.keyboardCount > 0) score += 4;
  if (input.screenSummary) score += 8;
  return Math.min(94, score);
}

function readScreenSummary(payload: RawNenovaEvent, data: Record<string, unknown>) {
  const screen = asRecord(data.screen ?? payload.screen);
  return compact(
    readString(
      data.screenSummary,
      payload.screenSummary,
      data.visionSummary,
      payload.visionSummary,
      screen.summary,
      screen.text,
      screen.ocrText,
      data.ocrText,
      payload.ocrText,
      data.screenText,
      payload.screenText,
    ),
    220,
  );
}

function readKeyboardCount(payload: RawNenovaEvent, data: Record<string, unknown>) {
  const textLength = readString(data.text, payload.text, data.inputText, payload.inputText).length;
  return Math.max(
    0,
    Math.round(
      readNumber(
        data.keyboardCount,
        payload.keyboardCount,
        data.keyCount,
        payload.keyCount,
        data.keystrokes,
        payload.keystrokes,
        data.textLength,
        payload.textLength,
        textLength || undefined,
      ) ?? 0,
    ),
  );
}

function readMouseClicks(payload: RawNenovaEvent, data: Record<string, unknown>) {
  return Math.max(
    0,
    Math.round(
      readNumber(
        data.mouseClicks,
        payload.mouseClicks,
        data.clickCount,
        payload.clickCount,
        data.clicks,
        payload.clicks,
        asArray(data.recentClicks ?? payload.recentClicks).length || undefined,
        asArray(data.mousePositions ?? payload.mousePositions).length || undefined,
      ) ?? 0,
    ),
  );
}

function readClickEvidence(payload: RawNenovaEvent, data: Record<string, unknown>) {
  const evidence: string[] = [];
  const explicit = [...asArray(data.clickEvidence), ...asArray(payload.clickEvidence)];
  explicit.forEach((item) => {
    const value = readString(item);
    if (value) evidence.push(compact(value, 80));
  });

  const regions = asRecord(data.mouseRegions ?? payload.mouseRegions);
  Object.entries(regions).forEach(([key, value]) => {
    const count = readNumber(value);
    evidence.push(count === undefined ? `region=${key}` : `region=${key}:${count}`);
  });

  [...asArray(data.recentClicks ?? payload.recentClicks), ...asArray(data.mousePositions ?? payload.mousePositions)]
    .slice(-8)
    .forEach((item, index) => {
      const click = asRecord(item);
      const label = readString(click.label, click.target, click.selector, click.text);
      const x = readNumber(click.x, click.left);
      const y = readNumber(click.y, click.top);
      if (label) evidence.push(`click=${compact(label, 60)}`);
      else if (x !== undefined && y !== undefined) evidence.push(`click_${index + 1}=x:${Math.round(x)},y:${Math.round(y)}`);
    });

  return Array.from(new Set(evidence)).slice(0, 18);
}

function makeWorkUnitId(payload: RawNenovaEvent, sessionId: string, timestamp: string) {
  const rawId = readString(payload.id);
  if (rawId) return `NX-${slug(rawId) || timestamp.replace(/\D/g, "").slice(0, 14)}`;
  const sessionPart = slug(sessionId) || "session";
  const stamp = timestamp.replace(/\D/g, "").slice(0, 14) || String(Date.now());
  return `NX-${sessionPart}-${stamp}`;
}

function normalizeRawEvent(payload: RawNenovaEvent): { stored: StoredNenovaEvent; workUnit: WorkUnitPayload } {
  const data = asRecord(payload.data);
  const period = asRecord(data.period ?? payload.period);
  const activeWindow = asRecord(data.activeWindow ?? payload.activeWindow);
  const timestamp = iso(payload.timestamp ?? data.timestamp ?? payload.startedAt ?? data.startedAt ?? period.start);
  const eventType = readString(payload.eventType, payload.type, data.eventType, data.type, "pc.event");
  const sessionId = readString(payload.sessionId, data.sessionId, payload.parentEventId, data.parentEventId, "session-unknown");
  const hostname = readString(payload.hostname, data.hostname, payload.hostName, data.hostName, payload.pcName, data.pcName);
  const deviceId = readString(payload.deviceId, data.deviceId, payload.machineId, data.machineId, hostname);
  const processName = readString(data.processName, payload.processName, activeWindow.processName, data.exe, payload.exe);
  const executablePath = readString(data.executablePath, payload.executablePath, activeWindow.executablePath, activeWindow.path);
  const appName = readString(data.appName, payload.appName, data.app, payload.app, activeWindow.appName, activeWindow.app, processName, "PC");
  const windowTitle = readString(
    data.windowTitle,
    payload.windowTitle,
    data.activeWindowTitle,
    payload.activeWindowTitle,
    activeWindow.windowTitle,
    activeWindow.title,
    payload.window,
    data.window,
    "작업 창 미수집",
  );
  const url = readString(data.url, payload.url, activeWindow.url) || undefined;
  const mouseClicks = readMouseClicks(payload, data);
  const keyboardCount = readKeyboardCount(payload, data);
  const screenSummary = readScreenSummary(payload, data);
  const source = inferSource(appName, processName, executablePath);
  const category = inferCategory(
    readString(data.category, payload.category, data.title, payload.title, data.summary, payload.summary, windowTitle, screenSummary, appName, processName),
  );
  const identity = resolveEmployeeIdentity({
    employee: readString(payload.employee, data.employee),
    employeeName: readString(payload.employeeName, data.employeeName),
    employeeId: readString(payload.employeeId, data.employeeId),
    accountId: readString(payload.accountId, data.accountId),
    userName: readString(payload.userName, data.userName),
    userId: readString(payload.userId, data.userId),
    userEmail: readString(payload.userEmail, payload.email, data.userEmail, data.email),
    kakaoworkUserId: readString(payload.kakaoworkUserId, data.kakaoworkUserId, payload.userId, data.userId),
    hostname,
  });
  const employee = identity?.employee || readString(payload.employeeName, data.employeeName, payload.employee, data.employee, payload.userName, data.userName, "미지정");
  const employeeId = identity?.id || readString(payload.employeeId, data.employeeId) || undefined;
  const accountId = identity?.accountId || readString(payload.accountId, data.accountId, employeeId, employee);
  const team = identity?.team || readString(payload.team, data.team, "미지정");
  const workArea = readString(payload.workArea, data.workArea, identity?.defaultWorkArea, category);
  const durationSec =
    Math.max(
      1,
      Math.round(
        readNumber(
          payload.durationSec,
          data.durationSec,
          payload.activeSeconds,
          data.activeSeconds,
          readNumber(payload.durationMs, data.durationMs, payload.activeMs, data.activeMs) !== undefined
            ? (readNumber(payload.durationMs, data.durationMs, payload.activeMs, data.activeMs) ?? 0) / 1000
            : undefined,
        ) ?? 60,
      ),
    ) || 60;
  const startedAt = iso(payload.startedAt ?? data.startedAt ?? period.start ?? timestamp);
  const endedAt = iso(payload.endedAt ?? data.endedAt ?? period.end, new Date(addSeconds(startedAt, durationSec)));
  const clickEvidence = readClickEvidence(payload, data);
  const confidence = inferConfidence({
    hasIdentity: Boolean(identity),
    mouseClicks,
    keyboardCount,
    screenSummary,
    windowTitle,
  });
  const workUnitId = makeWorkUnitId(payload, sessionId, timestamp);
  const sourceEventType = source === "nenova.exe" ? `nenova.exe.${eventType}` : eventType;
  const titleSeed = readString(payload.title, data.title, screenSummary, windowTitle);
  const title = compact(titleSeed ? `${employee} ${category} - ${titleSeed}` : `${employee} ${category} ${appName} 작업`, 120);
  const detail = compact(
    readString(
      payload.detail,
      data.detail,
      data.summary,
      payload.summary,
      `${eventType} 이벤트에서 ${appName}/${windowTitle} 작업이 수집되었습니다.`,
    ),
    260,
  );
  const evidence = Array.from(
    new Set(
      [
        `raw_event_id=${readString(payload.id, workUnitId)}`,
        `event_type=${eventType}`,
        `session_id=${sessionId}`,
        hostname ? `hostname=${hostname}` : "",
        deviceId ? `device_id=${deviceId}` : "",
        processName ? `process=${processName}` : "",
        executablePath ? `executable=${executablePath}` : "",
        windowTitle ? `active_window=${compact(windowTitle, 120)}` : "",
        url ? `url=${url}` : "",
        `mouse_clicks=${mouseClicks}`,
        `keyboard_count=${keyboardCount}`,
        screenSummary ? `screen_summary=${screenSummary}` : "",
        identity ? `employee_match=${identity.matchedBy}:${identity.confidence}` : "",
      ].filter(Boolean),
    ),
  );
  const pcEvidence = Array.from(
    new Set(
      [
        `app=${appName}`,
        windowTitle ? `window=${compact(windowTitle, 120)}` : "",
        hostname ? `hostname=${hostname}` : "",
        `session=${sessionId}`,
        `clicks=${mouseClicks}`,
        `keyboard=${keyboardCount}`,
        screenSummary ? `screen=${screenSummary}` : "",
      ].filter(Boolean),
    ),
  );

  const stored: StoredNenovaEvent = {
    id: readString(payload.id, workUnitId),
    receivedAt: new Date().toISOString(),
    type: eventType,
    timestamp,
    sessionId,
    parentEventId: readString(payload.parentEventId, data.parentEventId) || undefined,
    employee,
    employeeId,
    accountId,
    team,
    workArea,
    hostname,
    deviceId,
    source,
    appName,
    processName,
    executablePath,
    windowTitle,
    url,
    mouseClicks,
    keyboardCount,
    screenSummary,
    category,
    confidence,
    workUnitId,
    raw: payload,
  };

  const workUnit: WorkUnitPayload = {
    id: workUnitId,
    type: sourceEventType,
    eventType: sourceEventType,
    timestamp,
    employeeName: employee,
    employeeId,
    accountId,
    userId: readString(payload.userId, data.userId) || undefined,
    userEmail: readString(payload.userEmail, payload.email, data.userEmail, data.email) || undefined,
    hostname,
    team,
    workArea,
    source,
    appName,
    windowTitle,
    clickCount: mouseClicks,
    clickEvidence,
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
    validationMemo: "nenova.exe 원본 이벤트가 작업 단위로 변환되었습니다. 같은 시간대 카톡/카카오워크 대화와 ERP/구글시트 근거 연결이 필요합니다.",
    nextAction: "같은 시간대 카톡/카카오워크 대화와 연결해 직원 워크플로우를 확정합니다.",
  };

  return { stored, workUnit };
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

async function saveEvents(events: StoredNenovaEvent[]) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(events.slice(0, MAX_STORED_EVENTS), null, 2)}\n`, "utf8");
}

function upsertEvents(existing: StoredNenovaEvent[], incoming: StoredNenovaEvent[]) {
  const events = [...existing];
  incoming.forEach((event) => {
    const index = events.findIndex((item) => item.id === event.id);
    if (index >= 0) events[index] = event;
    else events.unshift(event);
  });
  return events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, MAX_STORED_EVENTS);
}

function extractPayloads(body: unknown): RawNenovaEvent[] {
  if (Array.isArray(body)) return body.map((item) => asRecord(item) as RawNenovaEvent);
  const object = asRecord(body) as RawNenovaEvent;
  if (Array.isArray(object.events)) return object.events.map((item) => asRecord(item) as RawNenovaEvent);
  const items = asArray(object.items);
  if (items.length) return items.map((item) => asRecord(item) as RawNenovaEvent);
  return [object];
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
    return {
      ok: false,
      status: 0,
      count: 0,
      error: err instanceof Error ? err.message : "work unit sync failed",
    };
  }
}

export async function GET() {
  const events = await loadEvents();
  return NextResponse.json({
    status: "ready",
    endpoint: "POST /api/nenova-exe/events",
    purpose: "nenova.exe 원본 PC 이벤트를 저장하고 직원 워크플로우 작업 단위로 변환합니다.",
    storage: {
      mode: "file",
      path: "nenova-erp-ui/data/nenova-exe-events.json",
      maxStoredEvents: MAX_STORED_EVENTS,
    },
    acceptedEventTypes: ["active_window", "mouse.chunk", "keyboard.chunk", "screen.capture", "screen.analyzed", "clipboard.change", "recorder.click"],
    nextSync: "정규화된 결과는 내부적으로 /api/work-units에 동기화됩니다.",
    count: events.length,
    recent: events.slice(0, 30),
    events,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as unknown;
    const payloads = extractPayloads(body).filter((payload) => Object.keys(payload).length > 0);
    const normalized = payloads.map(normalizeRawEvent);
    const storedEvents = normalized.map((item) => item.stored);
    const workUnits = normalized.map((item) => item.workUnit);
    const existing = await loadEvents();
    const events = upsertEvents(existing, storedEvents);
    await saveEvents(events);
    const workUnitSync = await syncWorkUnits(req, workUnits);

    return NextResponse.json({
      ok: true,
      count: storedEvents.length,
      total: events.length,
      event: storedEvents[0],
      events: storedEvents,
      workUnit: workUnits[0],
      workUnits,
      workUnitSync,
      next: [
        "카톡/카카오워크 메시지와 시간대 매칭",
        "직원별 작업 흐름 카드에서 PC 근거 확인",
        "Claude/GPT 검증 에이전트에 원본 이벤트와 작업 단위 함께 제공",
      ],
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "nenova.exe event import failed" }, { status: 500 });
  }
}
