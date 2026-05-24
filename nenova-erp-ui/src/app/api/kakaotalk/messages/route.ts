import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type KakaoTalkPayload = {
  id?: string;
  room?: string;
  sender?: string;
  sentAt?: string;
  text?: string;
  rawText?: string;
  messages?: KakaoTalkPayload[];
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
  receivedAt: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "kakaotalk-messages.json");
const MAX_STORED_MESSAGES = 5000;

function inferIntent(text: string) {
  const target = text.toLowerCase();
  if (target.includes("견적") || target.includes("단가") || target.includes("quote")) return { intent: "quote_request", category: "견적" };
  if (target.includes("계약") || target.includes("승인") || target.includes("contract")) return { intent: "contract_check", category: "계약" };
  if (target.includes("프로젝트") || target.includes("일정") || target.includes("project")) return { intent: "project_update", category: "프로젝트" };
  if (target.includes("할 일") || target.includes("할일") || target.includes("요청") || target.includes("task")) return { intent: "task_request", category: "할일" };
  if (target.includes("입금") || target.includes("세금") || target.includes("정산")) return { intent: "finance_check", category: "정산" };
  if (target.includes("재고") || target.includes("출고")) return { intent: "inventory_check", category: "재고" };
  return { intent: "message", category: "고객응대" };
}

function asDate(value?: string) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function idFromMessage(message: Pick<KakaoTalkMessage, "room" | "sender" | "sentAt" | "text">) {
  const stamp = message.sentAt.replace(/\D/g, "").slice(0, 14);
  const base = `${message.room}-${message.sender}-${message.text}`.replace(/[^a-z0-9가-힣]+/gi, "-").slice(0, 42);
  return `KT-${stamp}-${base}`;
}

async function loadMessages(): Promise<KakaoTalkMessage[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as KakaoTalkMessage[]) : [];
  } catch {
    return [];
  }
}

async function saveMessages(messages: KakaoTalkMessage[]) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(messages.slice(0, MAX_STORED_MESSAGES), null, 2)}\n`, "utf8");
}

function normalize(payload: KakaoTalkPayload, fallbackRoom = "카카오톡") {
  const text = (payload.text || "").trim();
  const sentAt = asDate(payload.sentAt);
  const inferred = inferIntent(text);
  const base = {
    source: "KakaoTalk" as const,
    room: payload.room || fallbackRoom,
    sender: payload.sender || "미지정",
    sentAt,
    text,
    intent: inferred.intent,
    category: inferred.category,
    receivedAt: new Date().toISOString(),
  };
  return { ...base, id: payload.id || idFromMessage(base) };
}

function parseRawText(rawText: string, room = "카카오톡") {
  const messages: KakaoTalkPayload[] = [];
  let currentDate = new Date();
  rawText.split(/\r?\n/).forEach((line) => {
    const dateMatch = line.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
    if (dateMatch) {
      currentDate = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
      return;
    }
    const messageMatch = line.match(/^\[(.+?)\]\s*\[(오전|오후)\s*(\d{1,2}):(\d{2})\]\s*(.+)$/);
    if (!messageMatch) return;
    const hourBase = Number(messageMatch[3]) % 12;
    const hour = messageMatch[2] === "오후" ? hourBase + 12 : hourBase;
    const sentAt = new Date(currentDate);
    sentAt.setHours(hour, Number(messageMatch[4]), 0, 0);
    messages.push({
      room,
      sender: messageMatch[1],
      sentAt: sentAt.toISOString(),
      text: messageMatch[5],
    });
  });
  return messages;
}

export async function GET() {
  const messages = await loadMessages();
  return NextResponse.json({
    status: "ready",
    storage: {
      mode: "file",
      path: "nenova-erp-ui/data/kakaotalk-messages.json",
      maxStoredMessages: MAX_STORED_MESSAGES,
    },
    count: messages.length,
    recent: messages.slice(0, 30),
    messages,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as KakaoTalkPayload | KakaoTalkPayload[];
    const payloads = Array.isArray(body)
      ? body
      : body.rawText
        ? parseRawText(body.rawText, body.room || "카카오톡")
        : Array.isArray(body.messages)
          ? body.messages
          : [body];
    const incoming = payloads.filter((item) => item.text?.trim()).map((item) => normalize(item, (body as KakaoTalkPayload).room || "카카오톡"));
    let messages = await loadMessages();
    incoming.forEach((message) => {
      const index = messages.findIndex((item) => item.id === message.id);
      if (index >= 0) messages[index] = message;
      else messages.unshift(message);
    });
    await saveMessages(messages);
    return NextResponse.json({ ok: true, count: incoming.length, total: messages.length, messages: incoming });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "KakaoTalk import failed" }, { status: 500 });
  }
}
