import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type IntakeItem = {
  id: string;
  intent?: string;
  category?: string;
  suggestedEntity?: string;
  title?: string;
  detail?: string;
  customer?: string;
  owner?: string;
  status?: string;
  dueDate?: string;
  amount?: number;
  evidence?: string[];
  createdAt?: string;
};

const DATA_FILE = path.join(process.cwd(), "data", "erp-intake.json");

async function loadItems(): Promise<IntakeItem[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as IntakeItem[]) : [];
  } catch {
    return [];
  }
}

function hasEvidence(item: IntakeItem, key: string) {
  return (item.evidence || []).some((entry) => entry.startsWith(key));
}

function missingFields(item: IntakeItem) {
  const missing: string[] = [];
  const entity = item.suggestedEntity || item.category || "";
  const isQuote = entity.includes("quote") || entity.includes("견적");
  const isTask = entity.includes("task") || entity.includes("할");

  if (isQuote && !item.customer) missing.push("customer");
  if (isQuote && !item.amount) missing.push("amount");
  if ((isQuote || isTask) && !hasEvidence(item, "extracted_dueDate=")) missing.push("dueDate_source");
  if (!hasEvidence(item, "extracted_customer=") && item.customer) missing.push("customer_source");
  if (!hasEvidence(item, "extracted_amount=") && item.amount) missing.push("amount_source");

  return missing;
}

function reviewQuestion(item: IntakeItem, missing: string[]) {
  return [
    "다음 ERP 수신함 초안을 검토해서 customer, amount, dueDate, suggestedEntity를 보정해 주세요.",
    "확실하지 않은 값은 null로 두고 reason을 짧게 적어 주세요.",
    "응답은 JSON 형태 제안으로 작성해 주세요.",
    `missingFields: ${missing.join(", ")}`,
    `item: ${JSON.stringify(item)}`,
  ].join("\n");
}

function buildQueue(items: IntakeItem[]) {
  return items
    .filter((item) => item.status !== "전환완료")
    .map((item) => {
      const missing = missingFields(item);
      return {
        id: item.id,
        priority: missing.includes("amount") || missing.includes("customer") ? "높음" : "보통",
        missingFields: missing,
        question: reviewQuestion(item, missing),
        item,
      };
    })
    .filter((entry) => entry.missingFields.length > 0)
    .sort((a, b) => b.missingFields.length - a.missingFields.length);
}

export async function GET() {
  const items = await loadItems();
  const queue = buildQueue(items);
  return NextResponse.json({
    status: "ready",
    counts: {
      intakeItems: items.length,
      reviewNeeded: queue.length,
      highPriority: queue.filter((item) => item.priority === "높음").length,
    },
    queue,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { id?: string; provider?: "anthropic" | "openai" };
    const items = await loadItems();
    const queue = buildQueue(items);
    const target = queue.find((item) => item.id === body.id) || queue[0];
    if (!target) return NextResponse.json({ ok: false, error: "AI review queue is empty" }, { status: 404 });

    const response = await fetch(new URL("/api/assistant", req.nextUrl.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        provider: body.provider || "anthropic",
        question: target.question,
        erpContext: {
          mode: "erp-intake-ai-review",
          intake: target.item,
          missingFields: target.missingFields,
        },
      }),
    });
    const data = await response.json();

    return NextResponse.json({
      ok: response.ok,
      target,
      assistant: data,
    }, { status: response.ok ? 200 : response.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "AI review failed" }, { status: 500 });
  }
}
