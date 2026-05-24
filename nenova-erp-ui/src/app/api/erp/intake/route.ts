import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type IntakeStatus = "초안" | "승인대기" | "전환완료" | "보류";
type SuggestedEntity = "quote" | "task" | "inventory" | "finance" | "project" | "question";
type LinkedEntityType = "meeting" | "task" | "quote" | "project" | "invoice";

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

function nextDueDate(days = 1) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
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

  return {
    id,
    source: text(payload.source, "manual"),
    sourceEventId: payload.sourceEventId,
    intent,
    category,
    suggestedEntity,
    title: text(payload.title, `${category} 수신 요청`),
    detail: text(payload.detail, text(payload.text, "내용 없음")),
    customer: payload.customer,
    owner: text(payload.owner, "미지정"),
    accountId: payload.accountId,
    team: payload.team,
    conversationName: payload.conversationName,
    status: previous?.status || "초안",
    dueDate: payload.dueDate || previous?.dueDate || nextDueDate(suggestedEntity === "quote" ? 3 : 1),
    amount: payload.amount,
    evidence: Array.from(new Set([...(previous?.evidence || []), ...(payload.evidence || [])].filter(Boolean))),
    linkedEntityType: previous?.linkedEntityType,
    linkedEntityId: previous?.linkedEntityId,
    convertedAt: previous?.convertedAt,
    conversionNote: previous?.conversionNote,
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
      updatedAt: now,
    };
    await saveItems(items);
    return NextResponse.json({ ok: true, item: items[index] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "ERP intake update failed" }, { status: 500 });
  }
}
