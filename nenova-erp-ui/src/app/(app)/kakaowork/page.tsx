import Link from "next/link";
import {
  KAKAOWORK_CONTRACTS,
  KAKAOWORK_DATA_MAPS,
  KAKAOWORK_ENV_VARS,
  KAKAOWORK_FLOWS,
  KAKAOWORK_METRICS,
  KAKAOWORK_SECURITY_CHECKS,
  KAKAOWORK_TEST_PAYLOAD,
} from "@/lib/kakaowork-plan";

const STATUS_STYLE = {
  운영: "bg-green-50 text-green-700",
  구축: "bg-blue-50 text-brand",
  설계: "bg-slate-100 text-slate-600",
};

export default function KakaoWorkPage() {
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="rounded-full bg-yellow-50 px-2.5 py-1 text-yellow-700">KakaoWork</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">업무 게이트</span>
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-brand">AI 비서 연결</span>
            </div>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
              카카오워크 대화가 곧 주문, 견적, 프로젝트, 할 일이 되게 만듭니다.
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              회사 업무는 카카오워크에서 시작하고, nenovaweb은 대화 원문과 실행 결과를 잃지 않는 시스템 기록으로 남깁니다.
              Bot 알림, 직원 답장, 승인 액션, AI 질문을 같은 이벤트 파이프라인으로 묶는 기초 설계입니다.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-950 p-5 text-white">
            <div className="text-sm font-semibold">기본 파이프라인</div>
            <div className="mt-4 grid gap-3">
              {["카카오워크 메시지 수신", "직원/채널 권한 매핑", "AI 의도 분류", "업무 생성 또는 상태 갱신", "담당자/관리자 알림"].map(
                (item, index) => (
                  <div key={item} className="flex items-center gap-3">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-semibold">
                      {index + 1}
                    </span>
                    <span className="text-sm text-slate-200">{item}</span>
                  </div>
                ),
              )}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link
                href="/assistant"
                className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-slate-100"
              >
                AI 비서 연결 보기
              </Link>
              <Link
                href="/dashboard"
                className="rounded-md border border-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
              >
                운영 허브
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {KAKAOWORK_METRICS.map((metric) => (
          <article key={metric.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium text-slate-500">{metric.label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-950">{metric.value}</div>
            <div className="mt-2 text-xs leading-5 text-slate-500">{metric.detail}</div>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">업무 흐름 설계</h3>
            <p className="mt-1 text-sm text-slate-500">수신부터 보고까지 같은 이벤트 ID로 추적합니다.</p>
          </div>
          <span className="rounded-md bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">
            work_event 중심
          </span>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          {KAKAOWORK_FLOWS.map((flow) => (
            <article key={flow.step} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-slate-400">{flow.step}</div>
                  <h4 className="mt-1 font-semibold text-slate-900">{flow.title}</h4>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[flow.status]}`}>
                  {flow.status}
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600">{flow.summary}</p>
              <div className="mt-4 grid gap-2 text-xs leading-5 text-slate-500">
                <div>
                  <span className="font-semibold text-slate-700">입력:</span> {flow.input}
                </div>
                <div>
                  <span className="font-semibold text-slate-700">결과:</span> {flow.output}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="font-semibold text-slate-900">서버 API 초안</h3>
            <p className="mt-1 text-sm text-slate-500">토큰은 서버 라우트에서만 사용하고, 브라우저에는 상태와 결과만 반환합니다.</p>
          </div>
          <div className="divide-y divide-slate-100">
            {KAKAOWORK_CONTRACTS.map((contract) => (
              <article key={contract.path + contract.name} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white">
                    {contract.method}
                  </span>
                  <code className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">{contract.path}</code>
                </div>
                <h4 className="mt-3 text-sm font-semibold text-slate-900">{contract.name}</h4>
                <p className="mt-1 text-sm leading-6 text-slate-600">{contract.purpose}</p>
                <div className="mt-3 grid gap-3 text-xs text-slate-500 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 font-semibold text-slate-700">요청</div>
                    {contract.request.join(" · ")}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-slate-700">응답</div>
                    {contract.result.join(" · ")}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h3 className="font-semibold text-slate-900">환경변수</h3>
            <div className="mt-4 space-y-3">
              {KAKAOWORK_ENV_VARS.map((env) => (
                <div key={env.key} className="rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs font-semibold text-slate-800">{env.key}</code>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        env.required ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {env.required ? "필수" : "선택"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{env.purpose}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h3 className="font-semibold text-slate-900">드라이런 payload</h3>
            <pre className="mt-3 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-5 text-slate-100">
              {JSON.stringify(KAKAOWORK_TEST_PAYLOAD, null, 2)}
            </pre>
          </section>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-semibold text-slate-900">데이터 매핑</h3>
          <div className="mt-4 grid gap-3">
            {KAKAOWORK_DATA_MAPS.map((item) => (
              <article key={item.source} className="rounded-md border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                  <span>{item.source}</span>
                  <span className="text-slate-300">→</span>
                  <span>{item.nenovaEntity}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600">{item.rule}</p>
                <div className="mt-2 text-xs text-slate-500">{item.fields.join(" · ")}</div>
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-semibold text-slate-900">보안 체크</h3>
          <div className="mt-4 space-y-3">
            {KAKAOWORK_SECURITY_CHECKS.map((check, index) => (
              <div key={check} className="flex gap-3 rounded-md bg-slate-50 p-3 text-sm leading-6 text-slate-600">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                  {index + 1}
                </span>
                <span>{check}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="font-semibold text-slate-900">공식 API 기준</h3>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <a
            href="https://docs.kakaoi.ai/kakao_work/webapireference/commonguide/"
            className="rounded-md border border-slate-200 px-3 py-2 text-slate-600 hover:bg-slate-50"
          >
            API 공통 가이드
          </a>
          <a
            href="https://docs.kakaoi.ai/kakao_work/webapireference/messages/"
            className="rounded-md border border-slate-200 px-3 py-2 text-slate-600 hover:bg-slate-50"
          >
            Messages
          </a>
          <a
            href="https://docs.kakaoi.ai/kakao_work/webapireference/conversations/"
            className="rounded-md border border-slate-200 px-3 py-2 text-slate-600 hover:bg-slate-50"
          >
            Conversations
          </a>
          <a
            href="https://docs.kakaoi.ai/kakao_work/webapireference/users/"
            className="rounded-md border border-slate-200 px-3 py-2 text-slate-600 hover:bg-slate-50"
          >
            Users
          </a>
        </div>
      </section>
    </div>
  );
}
