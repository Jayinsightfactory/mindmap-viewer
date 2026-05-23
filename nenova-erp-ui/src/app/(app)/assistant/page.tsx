import AiWorkConsole from "@/components/AiWorkConsole";
import { OPS_MODULES, PROMPT_TEMPLATES } from "@/lib/operating-plan";

export default function AssistantPage() {
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-brand">업무 데이터 질의</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Claude/GPT로 회사 데이터를 묻고 실행 초안을 만듭니다</h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            녹음 기록, 고객, 견적, 프로젝트, 할 일, 매출 데이터를 같은 맥락으로 묶어 직원이 바로 질문할 수 있는 구조입니다.
            API 키가 설정되면 서버 라우트가 Claude 또는 OpenAI GPT로 요청을 보냅니다.
          </p>
        </div>
      </section>

      <AiWorkConsole />

      <section className="grid gap-4 lg:grid-cols-2">
        {OPS_MODULES.map((module) => (
          <article key={module.id} className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900">{module.title}</div>
                <p className="mt-2 text-sm leading-6 text-slate-600">{module.summary}</p>
              </div>
              <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                {module.status}
              </span>
            </div>
            <div className="mt-4 grid gap-3 text-xs text-slate-500 sm:grid-cols-2">
              <div>
                <div className="mb-1 font-semibold text-slate-700">입력 데이터</div>
                {module.inputs.join(" · ")}
              </div>
              <div>
                <div className="mb-1 font-semibold text-slate-700">생성 결과</div>
                {module.outputs.join(" · ")}
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="font-semibold text-slate-900">직원이 바로 쓸 질문 템플릿</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {PROMPT_TEMPLATES.map((prompt) => (
            <div key={prompt} className="rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-600">
              {prompt}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
