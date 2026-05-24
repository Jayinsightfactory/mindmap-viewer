import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type WorkUnit = {
  id: string;
  source?: string;
  accountId?: string;
  employee?: string;
  category?: string;
  title?: string;
  detail?: string;
  customer?: string;
  startedAt?: string;
  endedAt?: string;
  relatedTalks?: Array<{ id?: string; sentAt?: string; text?: string; intent?: string }>;
  validationStatus?: string;
  validationMemo?: string;
  nextAction?: string;
  evidence?: string[];
  taskId?: string;
  projectId?: string;
};

type IntakeItem = {
  id: string;
  sourceEventId?: string;
  source?: string;
  accountId?: string;
  owner?: string;
  category?: string;
  suggestedEntity?: string;
  title?: string;
  detail?: string;
  customer?: string;
  dueDate?: string;
  amount?: number;
  status?: string;
  createdAt?: string;
  linkedEntityType?: string;
  linkedEntityId?: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const WORK_UNITS_FILE = path.join(DATA_DIR, "work-units.json");
const ERP_INTAKE_FILE = path.join(DATA_DIR, "erp-intake.json");

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

function eventSuffix(value?: string) {
  return (value || "").replace(/^KW-WU-/, "").replace(/^KW-/, "").trim();
}

function normalizeCategory(value?: string) {
  const text = (value || "").toLowerCase();
  if (text.includes("quote") || text.includes("견적")) return "견적";
  if (text.includes("task") || text.includes("todo") || text.includes("할")) return "할일";
  if (text.includes("project") || text.includes("프로젝트")) return "프로젝트";
  if (text.includes("finance") || text.includes("invoice") || text.includes("정산") || text.includes("세금") || text.includes("입금")) return "정산";
  if (text.includes("inventory") || text.includes("재고") || text.includes("출고")) return "재고";
  return value || "기타";
}

function minutesBetween(a?: string, b?: string) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 60000;
}

function scoreCandidate(unit: WorkUnit, intake: IntakeItem) {
  let score = 0;
  const reasons: string[] = [];
  const unitEvent = eventSuffix(unit.id);
  const intakeEvent = eventSuffix(intake.sourceEventId || intake.id);

  if (unitEvent && intakeEvent && unitEvent === intakeEvent) {
    score += 55;
    reasons.push("same_kakaowork_event");
  }

  if (unit.accountId && intake.accountId && unit.accountId === intake.accountId) {
    score += 18;
    reasons.push("same_account");
  }

  if (normalizeCategory(unit.category) === normalizeCategory(intake.category || intake.suggestedEntity)) {
    score += 12;
    reasons.push("same_category");
  }

  if (unit.customer && intake.customer && unit.customer === intake.customer) {
    score += 10;
    reasons.push("same_customer");
  }

  const intakeTime = intake.createdAt || intake.dueDate;
  const timeDiff = Math.min(
    minutesBetween(unit.startedAt, intakeTime),
    ...(unit.relatedTalks || []).map((talk) => minutesBetween(talk.sentAt, intakeTime)),
  );
  if (timeDiff <= 30) {
    score += 10;
    reasons.push("within_30min");
  } else if (timeDiff <= 180) {
    score += 4;
    reasons.push("within_3h");
  }

  if (intake.linkedEntityId) {
    score += 5;
    reasons.push("erp_already_linked");
  }

  return { score: Math.min(100, score), reasons, timeDiff: Number.isFinite(timeDiff) ? Math.round(timeDiff) : null };
}

export async function GET() {
  const [workUnits, intakeItems] = await Promise.all([readJsonArray<WorkUnit>(WORK_UNITS_FILE), readJsonArray<IntakeItem>(ERP_INTAKE_FILE)]);
  const candidates = workUnits.flatMap((unit) =>
    intakeItems
      .map((intake) => {
        const scored = scoreCandidate(unit, intake);
        return {
          id: `${unit.id}__${intake.id}`,
          workUnitId: unit.id,
          intakeId: intake.id,
          score: scored.score,
          reasons: scored.reasons,
          timeDiffMin: scored.timeDiff,
          recommendation: scored.score >= 85 ? "자동 병합 후보" : scored.score >= 60 ? "검토 후 병합" : "낮은 우선순위",
          workUnit: {
            title: unit.title,
            employee: unit.employee,
            accountId: unit.accountId,
            category: unit.category,
            startedAt: unit.startedAt,
            validationStatus: unit.validationStatus,
          },
          intake: {
            title: intake.title,
            owner: intake.owner,
            accountId: intake.accountId,
            category: intake.category,
            status: intake.status,
            customer: intake.customer,
            amount: intake.amount,
            createdAt: intake.createdAt,
            linkedEntityId: intake.linkedEntityId,
          },
        };
      })
      .filter((candidate) => candidate.score >= 45),
  );

  candidates.sort((a, b) => b.score - a.score);

  return NextResponse.json({
    status: "ready",
    counts: {
      workUnits: workUnits.length,
      intakeItems: intakeItems.length,
      candidates: candidates.length,
      autoMergeCandidates: candidates.filter((candidate) => candidate.score >= 85).length,
    },
    scoring: ["same_kakaowork_event", "same_account", "same_category", "same_customer", "within_30min", "erp_already_linked"],
    candidates: candidates.slice(0, 50),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { workUnitId?: string; intakeId?: string; note?: string };
    if (!body.workUnitId || !body.intakeId) {
      return NextResponse.json({ ok: false, error: "workUnitId and intakeId are required" }, { status: 400 });
    }

    const [workUnits, intakeItems] = await Promise.all([readJsonArray<WorkUnit>(WORK_UNITS_FILE), readJsonArray<IntakeItem>(ERP_INTAKE_FILE)]);
    const unitIndex = workUnits.findIndex((unit) => unit.id === body.workUnitId);
    const intake = intakeItems.find((item) => item.id === body.intakeId);
    if (unitIndex < 0 || !intake) {
      return NextResponse.json({ ok: false, error: "work unit or intake not found" }, { status: 404 });
    }

    const unit = workUnits[unitIndex];
    const scored = scoreCandidate(unit, intake);
    const evidence = Array.from(
      new Set([
        ...(unit.evidence || []),
        `erp_intake=${intake.id}`,
        intake.linkedEntityId ? `erp_linked_entity=${intake.linkedEntityType || "ERP"}:${intake.linkedEntityId}` : "",
        intake.status ? `erp_intake_status=${intake.status}` : "",
        `erp_merge_score=${scored.score}`,
        ...scored.reasons.map((reason) => `erp_merge_reason=${reason}`),
      ].filter(Boolean)),
    );

    workUnits[unitIndex] = {
      ...unit,
      customer: unit.customer || intake.customer,
      taskId: unit.taskId || (intake.linkedEntityType === "task" ? intake.linkedEntityId : undefined),
      projectId: unit.projectId || (intake.linkedEntityType === "project" ? intake.linkedEntityId : undefined),
      validationStatus: scored.score >= 85 ? "일치" : "부분일치",
      validationMemo:
        body.note ||
        `ERP 수신함 ${intake.id}와 병합 확인. 근거: ${scored.reasons.join(", ") || "manual"}.`,
      nextAction: intake.linkedEntityId ? "ERP 수신함과 실제 업무 객체가 연결되었습니다. 후속 상태만 추적합니다." : "ERP 수신함은 연결됐지만 실제 견적/할 일 전환 여부를 확인합니다.",
      evidence,
    };

    await writeJsonArray(WORK_UNITS_FILE, workUnits);

    return NextResponse.json({
      ok: true,
      workUnit: workUnits[unitIndex],
      intake,
      score: scored.score,
      reasons: scored.reasons,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "candidate confirm failed" }, { status: 500 });
  }
}
