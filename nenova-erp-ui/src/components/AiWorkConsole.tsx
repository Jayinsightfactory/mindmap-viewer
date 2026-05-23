"use client";

import { useState } from "react";
import { PROMPT_TEMPLATES } from "@/lib/operating-plan";
import { getErpSnapshot } from "@/lib/store";

type Provider = "anthropic" | "openai";

type AssistantResponse = {
  provider: Provider;
  model: string;
  mode: "live" | "demo";
  answer: string;
};

export default function AiWorkConsole({ compact = false }: { compact?: boolean }) {
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [question, setQuestion] = useState(PROMPT_TEMPLATES[0]);
  const [response, setResponse] = useState<AssistantResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function askAssistant(input = question) {
    const trimmed = input.trim();
    if (!trimmed) return;
    setQuestion(trimmed);
    setLoading(true);
    setError("");
    setResponse(null);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, question: trimmed, erpContext: getErpSnapshot() }),
      });
      const data = (await res.json()) as AssistantResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || "AI 응답을 가져오지 못했습니다.");
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 응답을 가져오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-900">AI 업무 비서</h2>
            <p className="mt-1 text-sm text-slate-500">
              Claude API와 GPT API를 업무 데이터 질문 창으로 연결합니다.
            </p>
          </div>
          <div className="flex rounded-md border border-slate-200 p-1 text-sm">
            {[
              ["anthropic", "Claude"],
              ["openai", "GPT"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setProvider(id as Provider)}
                className={`rounded px-3 py-1.5 font-medium ${
                  provider === id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
        {!compact && (
          <div className="grid gap-2 sm:grid-cols-2">
            {PROMPT_TEMPLATES.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => askAssistant(prompt)}
                className="rounded-md border border-slate-200 px-3 py-2 text-left text-sm text-slate-600 hover:border-brand hover:text-brand"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={compact ? 3 : 4}
            className="min-h-24 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            placeholder="업무 데이터에 대해 질문하세요."
          />
          <button
            type="button"
            onClick={() => askAssistant()}
            disabled={loading}
            className="w-24 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? "분석중" : "질문"}
          </button>
        </div>

        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {response && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
              <span className="rounded bg-white px-2 py-0.5 font-medium text-slate-700">
                {response.provider === "anthropic" ? "Claude" : "GPT"}
              </span>
              <span>{response.model}</span>
              <span>{response.mode === "live" ? "API 연결" : "데모 응답"}</span>
            </div>
            <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-slate-700">{response.answer}</pre>
          </div>
        )}
      </div>
    </section>
  );
}
