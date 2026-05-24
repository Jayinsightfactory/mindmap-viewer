"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getWorkUnits,
  updateWorkUnitStatus,
  type CrossValidationStatus,
  type TalkEvent,
  type TalkWorkRelation,
  type WorkUnit,
  type WorkUnitCategory,
  type WorkUnitSource,
  type WorkUnitStatus,
} from "@/lib/store";

const STATUS_STYLE: Record<string, string> = {
  수집: "bg-slate-100 text-slate-600",
  확인필요: "bg-amber-100 text-amber-700",
  진행중: "bg-blue-50 text-brand",
  완료: "bg-green-50 text-green-700",
  자동화후보: "bg-purple-50 text-purple-700",
};

const VALIDATION_STYLE: Record<string, string> = {
  일치: "bg-green-50 text-green-700",
  부분일치: "bg-amber-100 text-amber-700",
  충돌: "bg-red-50 text-red-700",
  검증대기: "bg-slate-100 text-slate-600",
};

const RELATION_STYLE: Record<TalkWorkRelation, string> = {
  대화후작업: "bg-blue-50 text-brand",
  작업후대화: "bg-green-50 text-green-700",
  동시진행: "bg-purple-50 text-purple-700",
  미연결: "bg-slate-100 text-slate-600",
};

const WORK_UNIT_STATUSES: WorkUnitStatus[] = ["수집", "확인필요", "진행중", "완료", "자동화후보"];
const WORK_UNIT_SOURCES: WorkUnitSource[] = ["nenova.exe", "KakaoTalk", "KakaoWork", "GoogleSheet", "nenovaweb", "Mindmap", "PC"];
const WORK_UNIT_CATEGORIES: WorkUnitCategory[] = ["고객응대", "견적", "계약", "프로젝트", "할일", "정산", "재고", "보고", "AI검토", "기타"];
const VALIDATION_STATUSES: CrossValidationStatus[] = ["일치", "부분일치", "충돌", "검증대기"];
const TALK_RELATIONS: TalkWorkRelation[] = ["대화후작업", "작업후대화", "동시진행", "미연결"];

type WorkUnitsApiResponse = {
  receivedCount?: number;
  units?: Partial<WorkUnit>[];
};

type IntakeCandidate = {
  id: string;
  workUnitId: string;
  intakeId: string;
  score: number;
  reasons: string[];
  recommendation: string;
  timeDiffMin: number | null;
  workUnit: {
    title?: string;
    employee?: string;
    accountId?: string;
    category?: string;
    startedAt?: string;
    validationStatus?: string;
  };
  intake: {
    title?: string;
    owner?: string;
    accountId?: string;
    category?: string;
    status?: string;
    customer?: string;
    amount?: number;
    createdAt?: string;
    linkedEntityId?: string;
  };
};

type IntakeCandidateApiResponse = {
  counts?: { candidates?: number; autoMergeCandidates?: number };
  candidates?: IntakeCandidate[];
};

type TalkCandidate = {
  id: string;
  workUnitId: string;
  talkId: string;
  score: number;
  reasons: string[];
  timeDiffMin: number | null;
  relation: TalkWorkRelation;
  recommendation: string;
  workUnit: {
    title?: string;
    employee?: string;
    accountId?: string;
    category?: string;
    startedAt?: string;
  };
  talk: {
    id: string;
    room: string;
    sender: string;
    sentAt: string;
    text: string;
    intent: string;
    category: string;
  };
};

type TalkCandidateApiResponse = {
  counts?: { candidates?: number; kakaotalkMessages?: number };
  candidates?: TalkCandidate[];
};

function formatWon(value: number) {
  return `${value.toLocaleString()}원`;
}

function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function dateLabel(value: string) {
  return new Date(value).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
  });
}

function shortList(items: string[], fallback: string) {
  return items.length ? items : [fallback];
}

function identityMatch(unit: WorkUnit) {
  const raw = unit.evidence.find((item) => item.startsWith("employee_match="));
  if (!raw) return null;
  const [method = "unknown", confidence = ""] = raw.replace("employee_match=", "").split(":");
  const methodLabel: Record<string, string> = {
    accountId: "내부계정",
    employeeId: "직원ID",
    email: "이메일",
    kakaoworkUserId: "워크ID",
    orbitUserId: "OrbitID",
    hostname: "PC명",
    name: "이름",
  };
  return {
    method,
    label: methodLabel[method] || method,
    confidence: Number(confidence) || 0,
  };
}

function durationMinutes(startedAt: string, endedAt: string, fallback = 1) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fallback;
  return Math.max(1, Math.round((end - start) / 60000));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeRemoteWorkUnit(input: Partial<WorkUnit>): WorkUnit | null {
  if (!input.id) return null;
  const startedAt = typeof input.startedAt === "string" ? input.startedAt : new Date().toISOString();
  const endedAt = typeof input.endedAt === "string" ? input.endedAt : startedAt;
  const talkRelation = enumValue(input.talkRelation, TALK_RELATIONS, "미연결");
  const relatedTalks: TalkEvent[] = Array.isArray(input.relatedTalks)
    ? input.relatedTalks.map((talk, index) => ({
        id: talk.id || `${input.id}-TALK-${index + 1}`,
        source: talk.source === "KakaoWork" ? ("KakaoWork" as const) : ("KakaoTalk" as const),
        room: talk.room || "대화방 미수집",
        sender: talk.sender || "미지정",
        sentAt: talk.sentAt || startedAt,
        text: talk.text || "",
        intent: talk.intent || "unknown",
        relation: enumValue(talk.relation, TALK_RELATIONS, talkRelation),
      }))
    : [];

  return {
    id: input.id,
    employee: input.employee || "미지정",
    accountId: input.accountId || input.employee || "미지정",
    team: input.team || "미지정",
    workArea: input.workArea || input.category || "기타",
    source: enumValue(input.source, WORK_UNIT_SOURCES, "PC"),
    category: enumValue(input.category, WORK_UNIT_CATEGORIES, "기타"),
    title: input.title || `${input.appName || "PC"} 작업`,
    detail: input.detail || "API로 수집된 작업 단위입니다.",
    appName: input.appName || "작업 앱 미수집",
    windowTitle: input.windowTitle || "작업 창 미수집",
    clickCount: Number.isFinite(Number(input.clickCount)) ? Number(input.clickCount) : 0,
    clickEvidence: Array.isArray(input.clickEvidence) ? input.clickEvidence : [],
    customer: input.customer,
    projectId: input.projectId,
    taskId: input.taskId,
    startedAt,
    endedAt,
    durationMin: Number.isFinite(Number(input.durationMin)) ? Number(input.durationMin) : durationMinutes(startedAt, endedAt),
    status: enumValue(input.status, WORK_UNIT_STATUSES, "수집"),
    confidence: Math.min(100, Math.max(0, Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 70)),
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    pcEvidence: Array.isArray(input.pcEvidence) ? input.pcEvidence : [],
    relatedTalks,
    talkRelation,
    validationStatus: enumValue(input.validationStatus, VALIDATION_STATUSES, "검증대기"),
    validationMemo: input.validationMemo || "API 수집 후 카카오톡/PC/ERP 3차 교차검증 대기 중입니다.",
    nextAction: input.nextAction || "ERP 고객/프로젝트/할 일과 연결해 검증을 완료합니다.",
    automationCandidate: Boolean(input.automationCandidate),
  };
}

function mergeWorkUnits(localUnits: WorkUnit[], remoteUnits: Partial<WorkUnit>[]) {
  const map = new Map<string, WorkUnit>();
  localUnits.forEach((unit) => map.set(unit.id, unit));
  remoteUnits.forEach((unit) => {
    const normalized = normalizeRemoteWorkUnit(unit);
    if (normalized) map.set(normalized.id, normalized);
  });
  return Array.from(map.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function buildWorkUnitSnapshot(workUnits: WorkUnit[]) {
  const today = new Date().toISOString().slice(0, 10);
  const todayUnits = workUnits.filter((unit) => unit.startedAt.slice(0, 10) === today);
  const targetUnits = todayUnits.length ? todayUnits : workUnits;
  const totalMinutes = targetUnits.reduce((sum, unit) => sum + unit.durationMin, 0);
  const employeeMap = targetUnits.reduce<
    Record<
      string,
      {
        accountId: string;
        team: string;
        minutes: number;
        count: number;
        latest: string;
        workAreas: Set<string>;
        clickCount: number;
        talkLinked: number;
        validated: number;
      }
    >
  >((acc, unit) => {
    const current = acc[unit.employee] ?? {
      accountId: unit.accountId,
      team: unit.team,
      minutes: 0,
      count: 0,
      latest: "",
      workAreas: new Set<string>(),
      clickCount: 0,
      talkLinked: 0,
      validated: 0,
    };
    current.minutes += unit.durationMin;
    current.count += 1;
    current.clickCount += unit.clickCount;
    current.workAreas.add(unit.workArea);
    if (unit.relatedTalks.length > 0 || unit.talkRelation !== "미연결") current.talkLinked += 1;
    if (unit.validationStatus === "일치") current.validated += 1;
    current.latest = current.latest && current.latest > unit.startedAt ? current.latest : unit.startedAt;
    acc[unit.employee] = current;
    return acc;
  }, {});

  return {
    counts: {
      totalUnits: workUnits.length,
      activeEmployees: Object.keys(employeeMap).length,
      talkLinked: workUnits.filter((unit) => unit.relatedTalks.length > 0 || unit.talkRelation !== "미연결").length,
      tripleValidated: workUnits.filter((unit) => unit.validationStatus === "일치").length,
      automationCandidates: workUnits.filter((unit) => unit.automationCandidate || unit.status === "자동화후보").length,
    },
    time: {
      totalMinutes,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    },
    byEmployee: Object.entries(employeeMap)
      .map(([employee, item]) => ({
        employee,
        accountId: item.accountId,
        team: item.team,
        workAreas: Array.from(item.workAreas),
        minutes: item.minutes,
        count: item.count,
        latest: item.latest,
        clickCount: item.clickCount,
        talkLinked: item.talkLinked,
        validated: item.validated,
      }))
      .sort((a, b) => b.minutes - a.minutes),
  };
}

function sourceLabel(source: WorkUnitSource) {
  const labels: Record<WorkUnitSource, string> = {
    "nenova.exe": "nenova.exe",
    KakaoTalk: "카톡",
    KakaoWork: "워크",
    GoogleSheet: "시트",
    nenovaweb: "웹",
    Mindmap: "마인드맵",
    PC: "PC",
  };
  return labels[source];
}

function hourKey(value: string) {
  return new Date(value).toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    hour12: false,
  });
}

function buildEmployeeWorkflows(workUnits: WorkUnit[]) {
  const grouped = new Map<string, WorkUnit[]>();
  workUnits.forEach((unit) => {
    grouped.set(unit.employee, [...(grouped.get(unit.employee) || []), unit]);
  });

  return Array.from(grouped.entries())
    .map(([employee, employeeUnits]) => {
      const ordered = [...employeeUnits].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const minutes = ordered.reduce((sum, unit) => sum + unit.durationMin, 0);
      const sourceSummary = WORK_UNIT_SOURCES.map((source) => {
        const sourceUnits = ordered.filter((unit) => unit.source === source);
        return {
          source,
          count: sourceUnits.length,
          minutes: sourceUnits.reduce((sum, unit) => sum + unit.durationMin, 0),
        };
      }).filter((item) => item.count > 0);
      const areaCounts = ordered.reduce<Record<string, number>>((acc, unit) => {
        acc[unit.workArea] = (acc[unit.workArea] || 0) + 1;
        return acc;
      }, {});
      const primaryArea = Object.entries(areaCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "미지정";
      const contextSwitches = ordered.reduce((count, unit, index) => {
        if (index === 0) return count;
        return ordered[index - 1].category === unit.category ? count : count + 1;
      }, 0);
      const talkLinked = ordered.filter((unit) => unit.relatedTalks.length > 0 || unit.talkRelation !== "미연결").length;
      const pcBacked = ordered.filter((unit) => unit.pcEvidence.length > 0 || unit.clickCount > 0 || unit.source === "PC" || unit.source === "nenova.exe").length;
      const validated = ordered.filter((unit) => unit.validationStatus === "일치" || unit.validationStatus === "부분일치").length;
      const workflowRisk =
        ordered.some((unit) => unit.validationStatus === "충돌")
          ? "충돌 확인"
          : talkLinked === 0
            ? "대화 근거 부족"
            : pcBacked === 0
              ? "PC 근거 부족"
              : validated < Math.ceil(ordered.length / 2)
                ? "검증 보강"
                : "흐름 안정";

      return {
        employee,
        accountId: ordered[0]?.accountId || "미지정",
        team: ordered[0]?.team || "미지정",
        primaryArea,
        minutes,
        count: ordered.length,
        talkLinked,
        pcBacked,
        validated,
        contextSwitches,
        workflowRisk,
        sourceSummary,
        timeline: ordered.slice(0, 5),
      };
    })
    .sort((a, b) => b.minutes - a.minutes);
}

function buildCompanyWorkflow(workUnits: WorkUnit[]) {
  const ordered = [...workUnits].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const transitions = new Map<string, { from: WorkUnitCategory; to: WorkUnitCategory; count: number }>();
  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1].category;
    const to = ordered[index].category;
    const key = `${from}->${to}`;
    const current = transitions.get(key) || { from, to, count: 0 };
    current.count += 1;
    transitions.set(key, current);
  }

  const hourly = new Map<string, { hour: string; minutes: number; units: number; employees: Set<string> }>();
  ordered.forEach((unit) => {
    const key = hourKey(unit.startedAt);
    const current = hourly.get(key) || { hour: key, minutes: 0, units: 0, employees: new Set<string>() };
    current.minutes += unit.durationMin;
    current.units += 1;
    current.employees.add(unit.employee);
    hourly.set(key, current);
  });

  const sourceCoverage = WORK_UNIT_SOURCES.map((source) => {
    const sourceUnits = ordered.filter((unit) => unit.source === source);
    return {
      source,
      count: sourceUnits.length,
      minutes: sourceUnits.reduce((sum, unit) => sum + unit.durationMin, 0),
    };
  }).filter((item) => item.count > 0);

  const bottlenecks = ordered
    .filter((unit) => unit.validationStatus === "충돌" || unit.validationStatus === "검증대기" || unit.talkRelation === "미연결")
    .slice(0, 5);

  return {
    transitions: Array.from(transitions.values()).sort((a, b) => b.count - a.count).slice(0, 6),
    hourly: Array.from(hourly.values())
      .map((item) => ({ ...item, employees: item.employees.size }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
    sourceCoverage,
    bottlenecks,
  };
}

export default function WorkUnitsPage() {
  const [units, setUnits] = useState<WorkUnit[]>([]);
  const [employeeFilter, setEmployeeFilter] = useState("전체");
  const [areaFilter, setAreaFilter] = useState("전체");
  const [validationFilter, setValidationFilter] = useState("전체");
  const [apiCount, setApiCount] = useState(0);
  const [intakeCandidates, setIntakeCandidates] = useState<IntakeCandidate[]>([]);
  const [talkCandidates, setTalkCandidates] = useState<TalkCandidate[]>([]);
  const [syncError, setSyncError] = useState("");
  const [candidateMessage, setCandidateMessage] = useState("");

  async function refresh() {
    const localUnits = getWorkUnits();
    setUnits(localUnits);
    setSyncError("");
    try {
      const response = await fetch("/api/work-units", { cache: "no-store" });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const data = (await response.json()) as WorkUnitsApiResponse;
      setApiCount(data.receivedCount ?? data.units?.length ?? 0);
      setUnits(mergeWorkUnits(localUnits, data.units ?? []));
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "API 동기화 실패");
    }
    try {
      const response = await fetch("/api/work-units/intake-candidates", { cache: "no-store" });
      if (!response.ok) throw new Error(`candidate API ${response.status}`);
      const data = (await response.json()) as IntakeCandidateApiResponse;
      setIntakeCandidates(data.candidates ?? []);
    } catch {
      setIntakeCandidates([]);
    }
    try {
      const response = await fetch("/api/work-units/talk-candidates", { cache: "no-store" });
      if (!response.ok) throw new Error(`talk candidate API ${response.status}`);
      const data = (await response.json()) as TalkCandidateApiResponse;
      setTalkCandidates(data.candidates ?? []);
    } catch {
      setTalkCandidates([]);
    }
  }

  async function confirmIntakeCandidate(candidate: IntakeCandidate) {
    setCandidateMessage("");
    const response = await fetch("/api/work-units/intake-candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        workUnitId: candidate.workUnitId,
        intakeId: candidate.intakeId,
        note: `ERP 수신함 ${candidate.intakeId} 병합 확정`,
      }),
    });
    if (!response.ok) {
      setCandidateMessage(`병합 실패: API ${response.status}`);
      return;
    }
    setCandidateMessage(`${candidate.workUnitId}와 ${candidate.intakeId} 병합 근거를 저장했습니다.`);
    await refresh();
  }

  async function confirmTalkCandidate(candidate: TalkCandidate) {
    setCandidateMessage("");
    const response = await fetch("/api/work-units/talk-candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        workUnitId: candidate.workUnitId,
        talkId: candidate.talkId,
        note: `카톡 ${candidate.talkId} 작업 근거 연결`,
      }),
    });
    if (!response.ok) {
      setCandidateMessage(`카톡 연결 실패: API ${response.status}`);
      return;
    }
    setCandidateMessage(`${candidate.workUnitId}에 카톡 ${candidate.talkId} 근거를 저장했습니다.`);
    await refresh();
  }

  useEffect(() => {
    void refresh();
  }, []);

  const snapshot = useMemo(() => buildWorkUnitSnapshot(units), [units]);
  const employees = useMemo(() => ["전체", ...Array.from(new Set(units.map((unit) => unit.employee)))], [units]);
  const workAreas = useMemo(() => ["전체", ...Array.from(new Set(units.map((unit) => unit.workArea)))], [units]);

  const filteredUnits = useMemo(
    () =>
      units.filter((unit) => {
        const employeeOk = employeeFilter === "전체" || unit.employee === employeeFilter;
        const areaOk = areaFilter === "전체" || unit.workArea === areaFilter;
        const validationOk = validationFilter === "전체" || unit.validationStatus === validationFilter;
        return employeeOk && areaOk && validationOk;
      }),
    [areaFilter, employeeFilter, units, validationFilter],
  );

  const relationGroups = useMemo(
    () => ({
      대화후작업: filteredUnits.filter((unit) => unit.talkRelation === "대화후작업"),
      작업후대화: filteredUnits.filter((unit) => unit.talkRelation === "작업후대화"),
      동시진행: filteredUnits.filter((unit) => unit.talkRelation === "동시진행"),
    }),
    [filteredUnits],
  );
  const employeeWorkflows = useMemo(() => buildEmployeeWorkflows(filteredUnits), [filteredUnits]);
  const companyWorkflow = useMemo(() => buildCompanyWorkflow(filteredUnits), [filteredUnits]);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-4xl">
            <p className="text-sm font-semibold text-brand">직원 작업 단위 교차검증</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              계정별 업무영역, 클릭 시간, 카카오톡 대화, PC 작업 데이터를 같이 봅니다.
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              핵심은 ERP가 아니라 직원별 실제 작업 흐름입니다. `nenova.exe` 작업 단위, 카톡/워크 대화, PC 화면/클릭 데이터를 먼저 묶고
              그 다음 대화가 작업을 만들었는지, 작업 후 대화가 이어졌는지, 동시에 진행됐는지 확인합니다.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <div className="font-semibold text-slate-900">검증 기준</div>
            <div className="mt-2 leading-6">
              1. nenova.exe 작업 시간
              <br />
              2. 카톡/워크 대화 시간
              <br />
              3. PC 앱/화면/클릭 근거
            </div>
            <div className="mt-3 border-t border-slate-200 pt-3">
              <div className="text-xs text-slate-500">API 수신 {apiCount}건</div>
              <div className="mt-1 text-xs text-slate-500">카톡 연결 후보 {talkCandidates.length}건</div>
              {syncError && <div className="mt-1 text-xs text-amber-700">{syncError}</div>}
              <button
                type="button"
                onClick={() => void refresh()}
                className="mt-2 rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700"
              >
                API 동기화
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[
          { label: "작업 단위", value: snapshot.counts.totalUnits, detail: "수집/시드 전체" },
          { label: "활성 계정", value: snapshot.counts.activeEmployees, detail: "직원 계정 기준" },
          { label: "대화 연결", value: snapshot.counts.talkLinked, detail: "톡/워크 매칭" },
          { label: "3차 일치", value: snapshot.counts.tripleValidated, detail: "대화+PC+ERP" },
          { label: "총 작업 시간", value: `${snapshot.time.totalHours}h`, detail: `${snapshot.time.totalMinutes}분` },
          { label: "자동화 후보", value: snapshot.counts.automationCandidates, detail: "반복 작업 후보" },
        ].map((item) => (
          <article key={item.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium text-slate-500">{item.label}</div>
            <div className="mt-1 text-xl font-semibold text-slate-950">{item.value}</div>
            <div className="mt-2 text-xs leading-5 text-slate-500">{item.detail}</div>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900">직원별 실제 업무 흐름</h3>
            <p className="mt-1 text-sm text-slate-500">직원 한 명씩 어떤 소스에서 어떤 업무를 했는지, 대화와 PC 근거가 붙었는지 확인합니다.</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{employeeWorkflows.length}명</span>
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {employeeWorkflows.map((row) => (
            <article key={row.employee} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-slate-900">{row.employee}</h4>
                  <div className="mt-1 font-mono text-xs text-slate-400">{row.accountId}</div>
                  <div className="mt-2 text-sm text-slate-600">
                    {row.team} · {row.primaryArea}
                  </div>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${row.workflowRisk === "흐름 안정" ? "bg-green-50 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                  {row.workflowRisk}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
                <div className="rounded-md bg-white p-2">
                  <div className="font-semibold text-slate-900">{row.count}</div>
                  <div className="mt-1 text-slate-500">작업</div>
                </div>
                <div className="rounded-md bg-white p-2">
                  <div className="font-semibold text-slate-900">{row.minutes}분</div>
                  <div className="mt-1 text-slate-500">시간</div>
                </div>
                <div className="rounded-md bg-white p-2">
                  <div className="font-semibold text-slate-900">{row.talkLinked}</div>
                  <div className="mt-1 text-slate-500">대화</div>
                </div>
                <div className="rounded-md bg-white p-2">
                  <div className="font-semibold text-slate-900">{row.pcBacked}</div>
                  <div className="mt-1 text-slate-500">PC근거</div>
                </div>
              </div>
              <div className="mt-4">
                <div className="text-xs font-semibold text-slate-500">소스 비중</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {row.sourceSummary.map((source) => (
                    <span key={source.source} className="rounded-full bg-white px-2.5 py-1 text-xs text-slate-600">
                      {sourceLabel(source.source)} {source.count}건/{source.minutes}분
                    </span>
                  ))}
                </div>
              </div>
              <div className="mt-4">
                <div className="text-xs font-semibold text-slate-500">최근 흐름</div>
                <div className="mt-2 space-y-2">
                  {row.timeline.map((unit) => (
                    <div key={unit.id} className="rounded-md bg-white px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate font-medium text-slate-900">{unit.title}</span>
                        <span className="shrink-0 text-xs text-slate-400">{timeLabel(unit.startedAt)}</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {sourceLabel(unit.source)} · {unit.category} · {unit.talkRelation}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <article className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-semibold text-slate-900">회사 전체 워크플로우 예측</h3>
          <p className="mt-1 text-sm text-slate-500">시간순 작업단위에서 업무 카테고리 전환을 뽑아 회사 전체 흐름을 봅니다.</p>
          <div className="mt-4 space-y-3">
            {companyWorkflow.transitions.map((transition) => (
              <div key={`${transition.from}-${transition.to}`} className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm">
                <span className="font-medium text-slate-800">
                  {transition.from} → {transition.to}
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs text-slate-600">{transition.count}회</span>
              </div>
            ))}
            {companyWorkflow.transitions.length === 0 && <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-400">전환을 계산할 작업 단위가 부족합니다.</div>}
          </div>
        </article>

        <article className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-semibold text-slate-900">시간대별 업무량</h3>
          <p className="mt-1 text-sm text-slate-500">분/시간 단위로 어느 시간대에 누가 몰리는지 봅니다.</p>
          <div className="mt-4 space-y-3">
            {companyWorkflow.hourly.map((hour) => (
              <div key={hour.hour}>
                <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                  <span>{hour.hour}시</span>
                  <span>
                    {hour.units}건 · {hour.minutes}분 · {hour.employees}명
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-slate-900" style={{ width: `${Math.min(100, hour.minutes * 2)}%` }} />
                </div>
              </div>
            ))}
            {companyWorkflow.hourly.length === 0 && <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-400">시간대 데이터가 없습니다.</div>}
          </div>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-semibold text-slate-900">데이터 소스 커버리지</h3>
          <p className="mt-1 text-sm text-slate-500">nenova.exe, 카톡/워크, PC 작업 데이터가 얼마나 들어왔는지 확인합니다.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {companyWorkflow.sourceCoverage.map((item) => (
              <span key={item.source} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                {sourceLabel(item.source)} {item.count}건/{item.minutes}분
              </span>
            ))}
          </div>
        </article>

        <article className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-semibold text-slate-900">확인 필요한 흐름</h3>
          <p className="mt-1 text-sm text-slate-500">대화 미연결, 검증대기, 충돌 항목을 먼저 확인합니다.</p>
          <div className="mt-4 space-y-2">
            {companyWorkflow.bottlenecks.map((unit) => (
              <div key={unit.id} className="rounded-md bg-slate-50 px-3 py-2">
                <div className="text-sm font-medium text-slate-900">{unit.title}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {unit.employee} · {sourceLabel(unit.source)} · {unit.validationStatus} · {unit.talkRelation}
                </div>
              </div>
            ))}
            {companyWorkflow.bottlenecks.length === 0 && <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-400">우선 확인할 병목이 없습니다.</div>}
          </div>
        </article>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-900">카톡 연결 후보</h3>
            <p className="mt-1 text-sm text-slate-500">카톡 원본 메시지를 작업단위와 시간/카테고리/대화방 기준으로 연결합니다.</p>
            {candidateMessage && <p className="mt-1 text-sm font-medium text-brand">{candidateMessage}</p>}
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{talkCandidates.length}건</span>
        </div>
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {talkCandidates.slice(0, 6).map((candidate) => (
            <article key={candidate.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-mono text-slate-400">
                    {candidate.workUnitId} ↔ {candidate.talkId}
                  </div>
                  <h4 className="mt-1 font-semibold text-slate-900">{candidate.recommendation}</h4>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${candidate.score >= 70 ? "bg-green-50 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                  {candidate.score}점
                </span>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-md bg-white p-3">
                  <div className="text-xs font-semibold text-slate-500">작업 단위</div>
                  <div className="mt-1 text-sm font-medium text-slate-900">{candidate.workUnit.title || "제목 없음"}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {candidate.workUnit.employee || "-"} · {candidate.workUnit.category || "-"}
                  </div>
                </div>
                <div className="rounded-md bg-white p-3">
                  <div className="text-xs font-semibold text-slate-500">카톡 메시지</div>
                  <div className="mt-1 text-sm font-medium text-slate-900">{candidate.talk.room}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {candidate.talk.sender} · {timeLabel(candidate.talk.sentAt)}
                  </div>
                  <p className="mt-2 text-sm leading-5 text-slate-600">{candidate.talk.text}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs ${RELATION_STYLE[candidate.relation]}`}>{candidate.relation}</span>
                {candidate.reasons.map((reason) => (
                  <span key={reason} className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">
                    {reason}
                  </span>
                ))}
                {candidate.timeDiffMin != null && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">{candidate.timeDiffMin}분 차이</span>
                )}
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => void confirmTalkCandidate(candidate)}
                  className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700"
                >
                  카톡 근거 저장
                </button>
              </div>
            </article>
          ))}
          {talkCandidates.length === 0 && <div className="rounded-md bg-slate-50 p-6 text-center text-sm text-slate-400 xl:col-span-2">작업단위와 연결할 카톡 후보가 없습니다.</div>}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-900">보조 데이터 연결 후보</h3>
            <p className="mt-1 text-sm text-slate-500">업무 파악이 먼저이고, ERP 수신함은 작업 결과를 보강하는 보조 근거로만 연결합니다.</p>
            {candidateMessage && <p className="mt-1 text-sm font-medium text-brand">{candidateMessage}</p>}
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{intakeCandidates.length}건</span>
        </div>
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {intakeCandidates.slice(0, 6).map((candidate) => (
            <article key={candidate.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-mono text-slate-400">
                    {candidate.workUnitId} ↔ {candidate.intakeId}
                  </div>
                  <h4 className="mt-1 font-semibold text-slate-900">{candidate.recommendation}</h4>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${candidate.score >= 85 ? "bg-green-50 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                  {candidate.score}점
                </span>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-md bg-white p-3">
                  <div className="text-xs font-semibold text-slate-500">작업 단위</div>
                  <div className="mt-1 text-sm font-medium text-slate-900">{candidate.workUnit.title || "제목 없음"}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {candidate.workUnit.employee || "-"} · {candidate.workUnit.category || "-"}
                  </div>
                </div>
                <div className="rounded-md bg-white p-3">
                  <div className="text-xs font-semibold text-slate-500">ERP 수신함</div>
                  <div className="mt-1 text-sm font-medium text-slate-900">{candidate.intake.title || "제목 없음"}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {candidate.intake.customer || candidate.intake.owner || "-"}
                    {candidate.intake.amount ? ` · ${formatWon(candidate.intake.amount)}` : ""}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {candidate.reasons.map((reason) => (
                  <span key={reason} className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">
                    {reason}
                  </span>
                ))}
                {candidate.timeDiffMin != null && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">{candidate.timeDiffMin}분 차이</span>
                )}
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => void confirmIntakeCandidate(candidate)}
                  className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700"
                >
                  병합 근거 저장
                </button>
              </div>
            </article>
          ))}
          {intakeCandidates.length === 0 && <div className="rounded-md bg-slate-50 p-6 text-center text-sm text-slate-400 xl:col-span-2">ERP 수신함과 연결할 후보가 없습니다.</div>}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900">계정별 업무영역</h3>
            <p className="mt-1 text-sm text-slate-500">직원별로 어떤 영역을 맡고, 어떤 데이터가 검증됐는지 먼저 확인합니다.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="text-sm text-slate-600">
              직원
              <select
                value={employeeFilter}
                onChange={(e) => setEmployeeFilter(e.target.value)}
                className="ml-2 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand"
              >
                {employees.map((employee) => (
                  <option key={employee} value={employee}>
                    {employee}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-600">
              업무영역
              <select
                value={areaFilter}
                onChange={(e) => setAreaFilter(e.target.value)}
                className="ml-2 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand"
              >
                {workAreas.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-600">
              검증상태
              <select
                value={validationFilter}
                onChange={(e) => setValidationFilter(e.target.value)}
                className="ml-2 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand"
              >
                {["전체", ...VALIDATION_STATUSES].map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-3 font-medium">직원/계정</th>
                <th className="px-4 py-3 font-medium">팀</th>
                <th className="px-4 py-3 font-medium">업무영역</th>
                <th className="px-4 py-3 text-right font-medium">작업</th>
                <th className="px-4 py-3 text-right font-medium">시간</th>
                <th className="px-4 py-3 text-right font-medium">클릭</th>
                <th className="px-4 py-3 text-right font-medium">검증</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.byEmployee.map((row) => (
                <tr key={row.employee} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{row.employee}</div>
                    <div className="font-mono text-xs text-slate-400">{row.accountId}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{row.team}</td>
                  <td className="px-4 py-3 text-slate-600">{row.workAreas.join(" · ")}</td>
                  <td className="px-4 py-3 text-right text-slate-800">{row.count}건</td>
                  <td className="px-4 py-3 text-right text-slate-800">{row.minutes}분</td>
                  <td className="px-4 py-3 text-right text-slate-800">{row.clickCount}회</td>
                  <td className="px-4 py-3 text-right text-slate-800">
                    {row.validated}/{row.count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {[
          { title: "대화가 작업을 만든 경우", relation: "대화후작업" as const, items: relationGroups.대화후작업 },
          { title: "작업 뒤 대화가 이어진 경우", relation: "작업후대화" as const, items: relationGroups.작업후대화 },
          { title: "대화와 작업이 동시에 진행", relation: "동시진행" as const, items: relationGroups.동시진행 },
        ].map((group) => (
          <article key={group.title} className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold text-slate-900">{group.title}</h3>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${RELATION_STYLE[group.relation]}`}>
                {group.items.length}건
              </span>
            </div>
            <div className="mt-4 space-y-3">
              {group.items.slice(0, 3).map((unit) => (
                <div key={unit.id} className="rounded-md bg-slate-50 p-3">
                  <div className="text-sm font-medium text-slate-900">{unit.title}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {unit.employee} · {unit.durationMin}분 · {unit.relatedTalks[0]?.room ?? "대화방 미연결"}
                  </div>
                </div>
              ))}
              {group.items.length === 0 && <div className="text-sm text-slate-400">해당 흐름 없음</div>}
            </div>
          </article>
        ))}
      </section>

      <section className="space-y-4">
        {filteredUnits.map((unit) => {
          const match = identityMatch(unit);
          return (
          <article key={unit.id} className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-mono text-slate-400">
                    {unit.id} · {dateLabel(unit.startedAt)} {timeLabel(unit.startedAt)}-{timeLabel(unit.endedAt)} · {unit.durationMin}분
                  </div>
                  <h3 className="mt-1 text-lg font-semibold text-slate-950">{unit.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{unit.detail}</p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${RELATION_STYLE[unit.talkRelation]}`}>
                    {unit.talkRelation}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${VALIDATION_STYLE[unit.validationStatus]}`}>
                    검증 {unit.validationStatus}
                  </span>
                  <select
                    value={unit.status}
                    onChange={(e) => {
                      const nextStatus = e.target.value as WorkUnitStatus;
                      updateWorkUnitStatus(unit.id, nextStatus);
                      setUnits((prev) => prev.map((item) => (item.id === unit.id ? { ...item, status: nextStatus } : item)));
                    }}
                    className={`rounded-full border-0 px-2 py-1 text-xs font-medium outline-none ${STATUS_STYLE[unit.status]}`}
                  >
                    {WORK_UNIT_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{unit.employee}</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-slate-600">{unit.accountId}</span>
                {match && (
                  <span className="rounded-full bg-green-50 px-2.5 py-1 text-green-700">
                    계정매핑 {match.label} {match.confidence}%
                  </span>
                )}
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{unit.team}</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{unit.workArea}</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{unit.appName}</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">신뢰도 {unit.confidence}%</span>
              </div>
            </div>

            <div className="grid gap-0 lg:grid-cols-3">
              <div className="border-b border-slate-100 p-5 lg:border-b-0 lg:border-r">
                <h4 className="font-semibold text-slate-900">클릭/PC 작업</h4>
                <div className="mt-2 text-sm text-slate-600">
                  {unit.windowTitle} · 클릭 {unit.clickCount}회
                </div>
                <ul className="mt-3 space-y-2 text-sm text-slate-600">
                  {shortList(unit.clickEvidence, "클릭 근거 수집 대기").map((item) => (
                    <li key={item} className="rounded-md bg-slate-50 px-3 py-2">
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  {shortList(unit.pcEvidence, "PC 근거 수집 대기").map((item) => (
                    <span key={item} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                      {item}
                    </span>
                  ))}
                </div>
              </div>

              <div className="border-b border-slate-100 p-5 lg:border-b-0 lg:border-r">
                <h4 className="font-semibold text-slate-900">카카오 대화 매칭</h4>
                <div className="mt-3 space-y-3">
                  {unit.relatedTalks.length === 0 && <div className="text-sm text-slate-400">연결된 대화 없음</div>}
                  {unit.relatedTalks.map((talk) => (
                    <div key={talk.id} className="rounded-md border border-slate-200 p-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span>
                          {talk.source} · {talk.room} · {talk.sender}
                        </span>
                        <span>{timeLabel(talk.sentAt)}</span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-700">{talk.text}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <span className={`rounded-full px-2 py-0.5 ${RELATION_STYLE[talk.relation]}`}>{talk.relation}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{talk.intent}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-5">
                <h4 className="font-semibold text-slate-900">3차 검증/다음 액션</h4>
                <p className="mt-3 rounded-md bg-slate-50 p-3 text-sm leading-6 text-slate-600">{unit.validationMemo}</p>
                <div className="mt-4">
                  <div className="text-xs font-semibold text-slate-500">다음 액션</div>
                  <div className="mt-1 text-sm leading-6 text-slate-800">{unit.nextAction}</div>
                </div>
                <div className="mt-4">
                  <div className="text-xs font-semibold text-slate-500">자동화 판단</div>
                  <div className="mt-1 text-sm text-slate-800">
                    {unit.automationCandidate ? "반복 패턴으로 자동화 후보입니다." : "현재는 수동 확인이 더 적합합니다."}
                  </div>
                </div>
              </div>
            </div>
          </article>
          );
        })}
      </section>
    </div>
  );
}
