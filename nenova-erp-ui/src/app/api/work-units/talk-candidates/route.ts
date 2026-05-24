import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { resolveEmployeeIdentity } from "@/lib/employee-directory";

export const runtime = "nodejs";

type TalkRelation = "대화후작업" | "작업후대화" | "동시진행" | "미연결";

type WorkUnit = {
  id: string;
  source?: string;
  employee?: string;
  accountId?: string;
  category?: string;
  title?: string;
  detail?: string;
  customer?: string;
  startedAt?: string;
  endedAt?: string;
  evidence?: string[];
  relatedTalks?: Array<{ id: string; source: "KakaoTalk" | "KakaoWork"; room: string; sender: string; sentAt: string; text: string; intent: string; relation: TalkRelation }>;
  talkRelation?: TalkRelation;
  validationStatus?: string;
  validationMemo?: string;
};

type KakaoTalkMessage = {
  id: string;
  source: "KakaoTalk";
  room: string;
  sender: string;
  sentAt: string;
  text: string;
  intent: string;
  category: string;
};

type KakaoWorkEvent = {
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
  receivedAt: string;
};

type TalkMessage = {
  id: string;
  source: "KakaoTalk" | "KakaoWork";
  room: string;
  sender: string;
  sentAt: string;
  text: string;
  intent: string;
  category: string;
  accountId?: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const WORK_UNITS_FILE = path.join(DATA_DIR, "work-units.json");
const KAKAOTALK_FILE = path.join(DATA_DIR, "kakaotalk-messages.json");
const KAKAOWORK_FILE = path.join(DATA_DIR, "kakaowork-events.json");

async function readJsonArray<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(file: string, items: T[]) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

function minutesBetween(a?: string, b?: string) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 60000;
}

function normalizeKakaoWorkEvent(event: KakaoWorkEvent): TalkMessage {
  const identity = resolveEmployeeIdentity({
    employeeName: event.userName || undefined,
    userName: event.userName || undefined,
    userEmail: event.userEmail || undefined,
    email: event.userEmail || undefined,
    userId: event.userId ? String(event.userId) : undefined,
    kakaoworkUserId: event.userId ? String(event.userId) : undefined,
  });
  return {
    id: event.id,
    source: "KakaoWork",
    room: event.conversationName || event.conversationId || "KakaoWork",
    sender: identity?.employee || event.userName || event.userEmail || String(event.userId || "미지정"),
    sentAt: event.receivedAt,
    text: event.text,
    intent: event.intent,
    category: event.category,
    accountId: identity?.accountId,
  };
}

function inferRelation(unit: WorkUnit, talk: TalkMessage): TalkRelation {
  const talkAt = new Date(talk.sentAt).getTime();
  const start = new Date(unit.startedAt || "").getTime();
  const end = new Date(unit.endedAt || unit.startedAt || "").getTime();
  if (!Number.isFinite(talkAt) || !Number.isFinite(start) || !Number.isFinite(end)) return "미연결";
  if (talkAt < start) return "대화후작업";
  if (talkAt > end) return "작업후대화";
  return "동시진행";
}

function isSessionWorkUnit(unit: WorkUnit) {
  return unit.id.startsWith("NX-SESSION-") || (unit.evidence || []).some((item) => item.startsWith("session_group="));
}

function scoreCandidate(unit: WorkUnit, talk: TalkMessage) {
  let score = 0;
  const reasons: string[] = [];
  const timeDiff = Math.min(minutesBetween(unit.startedAt, talk.sentAt), minutesBetween(unit.endedAt, talk.sentAt));
  if (timeDiff <= 30) {
    score += 40;
    reasons.push("within_30min");
  } else if (timeDiff <= 180) {
    score += 18;
    reasons.push("within_3h");
  }

  if (unit.category && talk.category && unit.category === talk.category) {
    score += 22;
    reasons.push("same_category");
  }

  if (talk.accountId && unit.accountId && talk.accountId === unit.accountId) {
    score += 16;
    reasons.push("same_account");
  }

  if (talk.source === "KakaoWork") {
    score += 6;
    reasons.push("kakaowork_source");
  }

  if (isSessionWorkUnit(unit)) {
    score += 8;
    reasons.push("session_work_unit");
  }

  const target = `${unit.title || ""} ${unit.detail || ""} ${unit.customer || ""}`.toLowerCase();
  if (talk.room && target.includes(talk.room.toLowerCase())) {
    score += 18;
    reasons.push("room_in_work");
  }

  const alreadyLinked = (unit.relatedTalks || []).some((item) => item.id === talk.id);
  if (!alreadyLinked) {
    score += 10;
    reasons.push("not_yet_linked");
  }

  return { score: Math.min(100, score), reasons, timeDiff: Number.isFinite(timeDiff) ? Math.round(timeDiff) : null };
}

export async function GET() {
  const [workUnits, kakaoTalkMessages, kakaoWorkEvents] = await Promise.all([
    readJsonArray<WorkUnit>(WORK_UNITS_FILE),
    readJsonArray<KakaoTalkMessage>(KAKAOTALK_FILE),
    readJsonArray<KakaoWorkEvent>(KAKAOWORK_FILE),
  ]);
  const messages: TalkMessage[] = [
    ...kakaoTalkMessages.map((message) => ({ ...message, accountId: undefined })),
    ...kakaoWorkEvents.map(normalizeKakaoWorkEvent),
  ];
  const targetWorkUnits = workUnits.filter((unit) => unit.source !== "KakaoTalk" && unit.source !== "KakaoWork");
  const candidates = targetWorkUnits.flatMap((unit) =>
    messages
      .map((talk) => {
        const scored = scoreCandidate(unit, talk);
        return {
          id: `${unit.id}__${talk.id}`,
          workUnitId: unit.id,
          talkId: talk.id,
          score: scored.score,
          reasons: scored.reasons,
          timeDiffMin: scored.timeDiff,
          relation: inferRelation(unit, talk),
          recommendation: scored.score >= 70 ? "연결 후보 높음" : scored.score >= 45 ? "검토 후 연결" : "낮은 우선순위",
          workUnit: {
            title: unit.title,
            employee: unit.employee,
            accountId: unit.accountId,
            category: unit.category,
            startedAt: unit.startedAt,
          },
          talk,
        };
      })
      .filter((candidate) => candidate.score >= 45),
  );
  candidates.sort((a, b) => b.score - a.score);
  return NextResponse.json({
    status: "ready",
    counts: {
      workUnits: workUnits.length,
      targetWorkUnits: targetWorkUnits.length,
      kakaotalkMessages: kakaoTalkMessages.length,
      kakaoworkMessages: kakaoWorkEvents.length,
      candidates: candidates.length,
    },
    candidates: candidates.slice(0, 80),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { workUnitId?: string; talkId?: string; note?: string };
    if (!body.workUnitId || !body.talkId) {
      return NextResponse.json({ ok: false, error: "workUnitId and talkId are required" }, { status: 400 });
    }
    const [workUnits, kakaoTalkMessages, kakaoWorkEvents] = await Promise.all([
      readJsonArray<WorkUnit>(WORK_UNITS_FILE),
      readJsonArray<KakaoTalkMessage>(KAKAOTALK_FILE),
      readJsonArray<KakaoWorkEvent>(KAKAOWORK_FILE),
    ]);
    const messages: TalkMessage[] = [
      ...kakaoTalkMessages.map((message) => ({ ...message, accountId: undefined })),
      ...kakaoWorkEvents.map(normalizeKakaoWorkEvent),
    ];
    const unitIndex = workUnits.findIndex((unit) => unit.id === body.workUnitId);
    const talk = messages.find((message) => message.id === body.talkId);
    if (unitIndex < 0 || !talk) {
      return NextResponse.json({ ok: false, error: "work unit or KakaoTalk message not found" }, { status: 404 });
    }
    const unit = workUnits[unitIndex];
    const scored = scoreCandidate(unit, talk);
    const relation = inferRelation(unit, talk);
    const relatedTalk = {
      id: talk.id,
      source: talk.source,
      room: talk.room,
      sender: talk.sender,
      sentAt: talk.sentAt,
      text: talk.text,
      intent: talk.intent,
      relation,
    };
    const existingTalks = unit.relatedTalks || [];
    const nextTalks = existingTalks.some((item) => item.id === talk.id) ? existingTalks : [...existingTalks, relatedTalk];
    const evidence = Array.from(
      new Set([
        ...(unit.evidence || []),
        `${talk.source === "KakaoWork" ? "kakaowork" : "kakaotalk"}=${talk.id}`,
        `${talk.source === "KakaoWork" ? "kakaowork" : "kakaotalk"}_room=${talk.room}`,
        `talk_merge_score=${scored.score}`,
        ...scored.reasons.map((reason) => `talk_merge_reason=${reason}`),
      ]),
    );

    workUnits[unitIndex] = {
      ...unit,
      relatedTalks: nextTalks,
      talkRelation: relation,
      validationStatus: scored.score >= 70 ? "부분일치" : unit.validationStatus || "검증대기",
      validationMemo: body.note || `${talk.source} ${talk.id}를 작업 근거로 연결했습니다. 관계: ${relation}.`,
      evidence,
    };
    await writeJsonArray(WORK_UNITS_FILE, workUnits);
    return NextResponse.json({ ok: true, workUnit: workUnits[unitIndex], talk, score: scored.score, reasons: scored.reasons });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "talk candidate confirm failed" }, { status: 500 });
  }
}
