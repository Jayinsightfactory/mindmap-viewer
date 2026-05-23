import { NextRequest, NextResponse } from "next/server";
import { KNOWLEDGE_SUMMARY, OPS_ACTIONS, OPS_MODULES, OPS_METRICS } from "@/lib/operating-plan";

type Provider = "anthropic" | "openai";

function buildContext(question: string) {
  return [
    "당신은 Nenova 내부 업무 OS의 AI 비서입니다.",
    "직원 질문에 대해 실행 가능한 답변, 다음 할 일, 확인할 데이터 위치를 한국어로 답합니다.",
    "확정되지 않은 데이터는 추정이라고 표시하고, 실제 실행 전 확인해야 할 항목을 분리합니다.",
    KNOWLEDGE_SUMMARY,
    `운영 지표: ${OPS_METRICS.map((m) => `${m.label} ${m.value}(${m.detail})`).join(" / ")}`,
    `업무 모듈: ${OPS_MODULES.map((m) => `${m.title}[${m.status}] - ${m.summary}`).join(" / ")}`,
    `현재 액션: ${OPS_ACTIONS.map((a) => `${a.title}(${a.owner}, ${a.due})`).join(" / ")}`,
    `직원 질문: ${question}`,
  ].join("\n\n");
}

function demoAnswer(provider: Provider, question: string) {
  return {
    provider,
    model: provider === "anthropic" ? "claude-demo" : "gpt-demo",
    mode: "demo" as const,
    answer: [
      "API 키가 아직 서버 환경변수에 없어서 데모 응답으로 동작합니다.",
      "",
      "업무 판단:",
      `- 질문: ${question}`,
      "- 녹음 기록, 고객, 견적, 프로젝트, 할 일, 매출 데이터를 같은 맥락으로 묶어 답변해야 합니다.",
      "- 첫 화면에서는 메뉴보다 현재 업무 흐름과 다음 액션을 먼저 보여주는 것이 좋습니다.",
      "",
      "다음 실행:",
      "1. 녹음/회의 기록에서 견적 후보와 후속 할 일을 추출합니다.",
      "2. 견적 확정 시 프로젝트 카드와 담당자 할 일을 생성합니다.",
      "3. 답변이 필요한 직원 질문은 Claude/GPT 중 선택한 모델로 라우팅합니다.",
      "4. 실행 전에는 고객명, 금액, 마감일, 담당자 권한을 확인합니다.",
      "",
      "실제 API 연결:",
      "- Claude: ANTHROPIC_API_KEY",
      "- GPT: OPENAI_API_KEY",
    ].join("\n"),
  };
}

function extractOpenAIText(data: any) {
  if (typeof data?.output_text === "string") return data.output_text;
  const parts = data?.output?.flatMap((item: any) => item?.content || []) || [];
  return parts.map((p: any) => p?.text).filter(Boolean).join("\n").trim();
}

async function askOpenAI(prompt: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4.1";
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 900,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "OpenAI API 호출 실패");
  return { model, answer: extractOpenAIText(data) || "응답 텍스트가 비어 있습니다." };
}

async function askAnthropic(prompt: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic API 호출 실패");
  const answer = (data?.content || []).map((part: any) => part?.text).filter(Boolean).join("\n");
  return { model, answer: answer || "응답 텍스트가 비어 있습니다." };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const provider = (body.provider === "openai" ? "openai" : "anthropic") as Provider;
    const question = String(body.question || "").trim();

    if (!question) {
      return NextResponse.json({ error: "질문을 입력하세요." }, { status: 400 });
    }

    const prompt = buildContext(question);
    const live = provider === "openai" ? await askOpenAI(prompt) : await askAnthropic(prompt);

    if (!live) {
      return NextResponse.json(demoAnswer(provider, question));
    }

    return NextResponse.json({
      provider,
      model: live.model,
      mode: "live",
      answer: live.answer,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI 요청 처리 실패" },
      { status: 500 },
    );
  }
}
