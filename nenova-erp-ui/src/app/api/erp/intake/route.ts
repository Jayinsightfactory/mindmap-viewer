import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type IntakeStatus = "초안" | "승인대기" | "승인완료" | "전환완료" | "보류";
type SuggestedEntity = "quote" | "task" | "inventory" | "finance" | "project" | "question";
type LinkedEntityType = "meeting" | "task" | "quote" | "project" | "invoice";
type IntakeActionLog = {
  source: string;
  action: string;
  actor?: string;
  accountId?: string;
  note?: string;
  actedAt: string;
};

type IntakePayload = {
  id?: string;
  source?: string;
  sourceEventId?: string;
  intent?: string;
  category?: string;
  title?: string;
  detail?: string;
  text?: string;
  customer?: string;
  owner?: string;
  accountId?: string;
  team?: string;
  conversationName?: string;
  evidence?: string[];
  suggestedEntity?: SuggestedEntity;
  dueDate?: string;
  amount?: number;
};

type IntakeItem = {
  id: string;
  source: string;
  sourceEventId?: string;
  intent: string;
  category: string;
  suggestedEntity: SuggestedEntity;
  title: string;
  detail: string;
  customer?: string;
  owner: string;
  accountId?: string;
  team?: string;
  conversationName?: string;
  status: IntakeStatus;
  dueDate?: string;
  amount?: number;
  evidence: string[];
  linkedEntityType?: LinkedEntityType;
  linkedEntityId?: string;
  convertedAt?: string;
  conversionNote?: string;
  requestedConversionAt?: string;
  lastAction?: IntakeActionLog;
  createdAt: string;
  updatedAt: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "erp-intake.json");
const MAX_STORED_ITEMS = 2000;

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function inferEntity(intent: string, category: string): SuggestedEntity {
  const target = `${intent} ${category}`.toLowerCase();
  if (target.includes("quote") || target.includes("견적")) return "quote";
  if (target.includes("task") || target.includes("todo") || target.includes("할일") || target.includes("할 일")) return "task";
  if (target.includes("inventory") || target.includes("재고") || target.includes("출고")) return "inventory";
  if (target.includes("finance") || target.includes("invoice") || target.includes("정산") || target.includes("세금") || target.includes("입금")) return "finance";
  if (target.includes("project") || target.includes("프로젝트")) return "project";
  return "question";
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function nextDueDate(days = 1) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateOnly(date);
}

function parseAmount(input: string) {
  const compact = input.replace(/,/g, "");
  const unitMatch = compact.match(/(\d+(?:\.\d+)?)\s*(억|천만|백만|십만|만)\s*원?/);
  if (unitMatch) {
    const value = Number(unitMatch[1]);
    const multipliers: Record<string, number> = {
      억: 100000000,
      천만: 10000000,
      백만: 1000000,
      십만: 100000,
      만: 10000,
    };
    return Math.round(value * multipliers[unitMatch[2]]);
  }

  const wonMatch = compact.match(/(\d{4,})\s*원/);
  if (wonMatch) return Number(wonMatch[1]);

  const keywordMatch = compact.match(/(?:금액|공급가|견적가|견적|예산|비용)\D{0,12}(\d+(?:\.\d+)?)\s*(억|천만|백만|십만|만|원)?/);
  if (!keywordMatch) return undefined;
  const value = Number(keywordMatch[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = keywordMatch[2];
  if (unit === "억") return Math.round(value * 100000000);
  if (unit === "천만") return Math.round(value * 10000000);
  if (unit === "백만") return Math.round(value * 1000000);
  if (unit === "십만") return Math.round(value * 100000);
  if (unit === "만") return Math.round(value * 10000);
  return value >= 10000 ? Math.round(value) : undefined;
}

function parseDueDate(input: string) {
  const now = new Date();
  const explicit = input.match(/(20\d{2})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (explicit) {
    return dateOnly(new Date(Number(explicit[1]), Number(explicit[2]) - 1, Number(explicit[3])));
  }

  const monthDay = input.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (monthDay) {
    const date = new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]));
    if (date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) date.setFullYear(date.getFullYear() + 1);
    return dateOnly(date);
  }

  const relativeDays: Array<[RegExp, number]> = [
    [/오늘|금일/, 0],
    [/내일|익일/, 1],
    [/모레/, 2],
    [/이번\s*주\s*말|이번주말/, 6],
    [/다음\s*주\s*말|다음주말/, 13],
  ];
  for (const [pattern, days] of relativeDays) {
    if (pattern.test(input)) return nextDueDate(days);
  }

  const dday = input.match(/D\s*[+＋]\s*(\d{1,3})/i);
  if (dday) return nextDueDate(Number(dday[1]));

  const weekdays: Record<string, number> = {
    일: 0,
    월: 1,
    화: 2,
    수: 3,
    목: 4,
    금: 5,
    토: 6,
  };
  const weekday = input.match(/(이번\s*주|이번주|다음\s*주|다음주)?\s*([월화수목금토일])요일/);
  if (weekday) {
    const current = now.getDay();
    const target = weekdays[weekday[2]];
    const nextWeek = Boolean(weekday[1]?.includes("다음"));
    let days = target - current;
    if (days < 0 || nextWeek) days += 7;
    return nextDueDate(days);
  }

  return undefined;
}

function parseCustomer(input: string) {
  const direct = input.match(/(?:고객사|고객|거래처|업체)\s*[:：=]?\s*([가-힣A-Za-z0-9&().\-\s]{2,40})/);
  if (direct) return direct[1].replace(/\s+(견적|계약|프로젝트|문의|요청).*$/i, "").trim();

  const koreanCompany = input.match(/([가-힣A-Za-z0-9&().\-\s]{2,40})(?:에서|의)\s*(?:견적|계약|프로젝트|문의|요청)/);
  if (koreanCompany) return koreanCompany[1].trim();

  const englishFor = input.match(/\bfor\s+([A-Za-z0-9&().\-\s]{2,40})/i);
  if (englishFor) return englishFor[1].replace(/\s+(quote|request|task|project).*$/i, "").trim();

  return undefined;
}

function extractDraftFields(payload: IntakePayload) {
  const source = [payload.title, payload.detail, payload.text].filter(Boolean).join(" ");
  const customerSource = [payload.detail, payload.text].filter(Boolean).join(" ") || text(payload.title);
  const amount = parseAmount(source);
  const dueDate = parseDueDate(source);
  const customer = parseCustomer(customerSource);
  return { amount, dueDate, customer };
}

async function loadItems(): Promise<IntakeItem[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as IntakeItem[]) : [];
  } catch {
    return [];
  }
}

async function saveItems(items: IntakeItem[]) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(items.slice(0, MAX_STORED_ITEMS), null, 2)}\n`, "utf8");
}

function normalize(payload: IntakePayload, existing: IntakeItem[]): IntakeItem {
  const now = new Date().toISOString();
  const intent = text(payload.intent, "message");
  const category = text(payload.category, "고객응대");
  const suggestedEntity = payload.suggestedEntity || inferEntity(intent, category);
  const id = payload.id || `ERP-IN-${(payload.sourceEventId || now).replace(/[^a-z0-9가-힣]+/gi, "-").replace(/^-|-$/g, "")}`;
  const previous = existing.find((item) => item.id === id);
  const extracted = extractDraftFields(payload);
  const amount = payload.amount ?? previous?.amount ?? extracted.amount;
  const customer = payload.customer || previous?.customer || extracted.customer;
  const dueDate = payload.dueDate || previous?.dueDate || extracted.dueDate || nextDueDate(suggestedEntity === "quote" ? 3 : 1);
  const extractionEvidence = [
    extracted.customer ? `extracted_customer=${extracted.customer}` : "",
    extracted.amount ? `extracted_amount=${extracted.amount}` : "",
    extracted.dueDate ? `extracted_dueDate=${extracted.dueDate}` : "",
  ].filter(Boolean);

  return {
    id,
    source: text(payload.source, "manual"),
    sourceEventId: payload.sourceEventId,
    intent,
    category,
    suggestedEntity,
    title: text(payload.title, `${category} 수신 요청`),
    detail: text(payload.detail, text(payload.text, "내용 없음")),
    customer,
    owner: text(payload.owner, "미지정"),
    accountId: payload.accountId,
    team: payload.team,
    conversationName: payload.conversationName,
    status: previous?.status || "초안",
    dueDate,
    amount,
    evidence: Array.from(new Set([...(previous?.evidence || []), ...(payload.evidence || []), ...extractionEvidence].filter(Boolean))),
    linkedEntityType: previous?.linkedEntityType,
    linkedEntityId: previous?.linkedEntityId,
    convertedAt: previous?.convertedAt,
    conversionNote: previous?.conversionNote,
    requestedConversionAt: previous?.requestedConversionAt,
    lastAction: previous?.lastAction,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
}

export async function GET() {
  const items = await loadItems();
  return NextResponse.json({
    status: "ready",
    storage: {
      mode: "file",
      path: "nenova-erp-ui/data/erp-intake.json",
      maxStoredItems: MAX_STORED_ITEMS,
    },
    count: items.length,
    openCount: items.filter((item) => item.status !== "전환완료").length,
    items,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as IntakePayload | { items?: IntakePayload[] };
    const payloads = Array.isArray((body as { items?: IntakePayload[] }).items)
      ? (body as { items: IntakePayload[] }).items
      : [body as IntakePayload];
    let items = await loadItems();
    const saved: IntakeItem[] = [];

    for (const payload of payloads) {
      const item = normalize(payload, items);
      const index = items.findIndex((current) => current.id === item.id);
      if (index >= 0) items[index] = item;
      else items.unshift(item);
      saved.push(item);
    }

    await saveItems(items);
    return NextResponse.json({ ok: true, count: saved.length, items: saved, total: items.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "ERP intake failed" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      id?: string;
      status?: IntakeStatus;
      linkedEntityType?: LinkedEntityType;
      linkedEntityId?: string;
      conversionNote?: string;
      requestedConversionAt?: string;
      lastAction?: IntakeActionLog;
    };
    if (!body.id || !body.status) return NextResponse.json({ ok: false, error: "id and status required" }, { status: 400 });
    const items = await loadItems();
    const index = items.findIndex((item) => item.id === body.id);
    if (index < 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const now = new Date().toISOString();
    items[index] = {
      ...items[index],
      status: body.status,
      linkedEntityType: body.linkedEntityType || items[index].linkedEntityType,
      linkedEntityId: body.linkedEntityId || items[index].linkedEntityId,
      convertedAt: body.status === "전환완료" ? items[index].convertedAt || now : items[index].convertedAt,
      conversionNote: body.conversionNote || items[index].conversionNote,
      requestedConversionAt: body.requestedConversionAt || items[index].requestedConversionAt,
      lastAction: body.lastAction || items[index].lastAction,
      updatedAt: now,
    };
    await saveItems(items);
    return NextResponse.json({ ok: true, item: items[index] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "ERP intake update failed" }, { status: 500 });
  }
}
