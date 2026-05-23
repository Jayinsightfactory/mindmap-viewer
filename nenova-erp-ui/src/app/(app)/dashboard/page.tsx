"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AiWorkConsole from "@/components/AiWorkConsole";
import { OPS_ACTIONS, OPS_METRICS, OPS_MODULES } from "@/lib/operating-plan";
import { getOrders, getProducts, getCustomers, getErpSnapshot, type Order, type Product } from "@/lib/store";

const STATUS_STYLE: Record<string, string> = {
  접수: "bg-amber-100 text-amber-700",
  처리중: "bg-blue-100 text-blue-700",
  완료: "bg-green-100 text-green-700",
  취소: "bg-slate-200 text-slate-500",
};

export default function DashboardPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customerCount, setCustomerCount] = useState(0);
  const [erpSnapshot, setErpSnapshot] = useState<ReturnType<typeof getErpSnapshot> | null>(null);

  useEffect(() => {
    setOrders(getOrders());
    setProducts(getProducts());
    setCustomerCount(getCustomers().length);
    setErpSnapshot(getErpSnapshot());
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const todayCount = orders.filter((o) => o.createdAt.slice(0, 10) === today).length;
  const pending = orders.filter((o) => o.status === "접수" || o.status === "처리중").length;
  const lowStock = products.filter((p) => p.stock < p.safetyStock);

  const cards = [
    { label: "오늘 신규 주문", value: todayCount, suffix: "건", accent: "text-brand" },
    { label: "처리 대기", value: pending, suffix: "건", accent: "text-amber-600" },
    { label: "재고 부족 품목", value: lowStock.length, suffix: "종", accent: "text-red-600" },
    { label: "등록 고객", value: customerCount, suffix: "사", accent: "text-green-600" },
  ];

  const erpCards = erpSnapshot
    ? [
        { label: "회의/녹음 기록", value: erpSnapshot.counts.meetings, detail: "견적 전환 가능한 업무 원문" },
        { label: "진행 견적", value: erpSnapshot.counts.quoteDrafts, detail: "초안/발송 후 계약 대기" },
        { label: "계약 확정", value: erpSnapshot.counts.confirmedQuotes, detail: "프로젝트로 전환된 견적" },
        { label: "진행 프로젝트", value: erpSnapshot.counts.activeProjects, detail: "담당자 할 일과 연결" },
        { label: "미완료 할 일", value: erpSnapshot.counts.pendingTasks, detail: "대기/진행/지연 상태" },
        { label: "미입금 매출", value: `${erpSnapshot.revenue.unpaid.toLocaleString()}원`, detail: "세금계산서 대기 포함" },
      ]
    : [];

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-brand">NENOVAWEB</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">운영 허브</span>
              <span className="rounded-full bg-green-50 px-2.5 py-1 text-green-700">AI 비서 연결 준비</span>
            </div>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
              메뉴가 아니라, 오늘 회사가 어떻게 돌아가는지 먼저 보여줍니다.
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              녹음 기록, 견적, 계약, 프로젝트, 할 일, 일정, 매출, 세금계산서, 파일, 직원 질문을 한 화면에서 이어 봅니다.
              직원은 이 화면에서 바로 Claude 또는 GPT에 업무 질문을 던지고 다음 액션을 만들 수 있습니다.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(erpCards.length ? erpCards : OPS_METRICS).slice(0, 6).map((metric) => (
                <div key={metric.label} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-medium text-slate-500">{metric.label}</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{metric.value}</div>
                  <div className="mt-2 text-xs leading-5 text-slate-500">{metric.detail}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-950 p-5 text-white">
            <div className="text-sm font-semibold">오늘의 운영 흐름</div>
            <div className="mt-4 space-y-3">
              {[
                "녹음/회의 기록 자동 적재",
                "견적 후보와 후속 할 일 추출",
                "계약 확정 시 프로젝트 생성",
                "담당자 배정과 마감 알림",
                "18시 진행 보고 자동 요약",
              ].map((step, index) => (
                <div key={step} className="flex items-center gap-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-semibold">
                    {index + 1}
                  </span>
                  <span className="text-sm text-slate-200">{step}</span>
                </div>
              ))}
            </div>
            <Link
              href="/erp-flow"
              className="mt-5 inline-flex rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-slate-100"
            >
              ERP 흐름 실행하기
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {OPS_MODULES.slice(0, 6).map((module) => (
          <article key={module.id} className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold text-slate-900">{module.title}</h3>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  module.status === "운영"
                    ? "bg-green-50 text-green-700"
                    : module.status === "구축"
                      ? "bg-blue-50 text-brand"
                      : "bg-slate-100 text-slate-600"
                }`}
              >
                {module.status}
              </span>
            </div>
            <p className="mt-3 min-h-16 text-sm leading-6 text-slate-600">{module.summary}</p>
            <div className="mt-4 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">결과:</span> {module.outputs.slice(0, 3).join(" · ")}
            </div>
          </article>
        ))}
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="font-semibold text-slate-900">자동 생성해야 할 업무</h2>
            <p className="mt-1 text-sm text-slate-500">녹음, 견적, 프로젝트, 일정에서 계속 생기는 다음 액션입니다.</p>
          </div>
          <div className="divide-y divide-slate-100">
            {OPS_ACTIONS.map((action) => (
              <div key={action.title} className="flex items-start justify-between gap-4 px-5 py-4">
                <div>
                  <div className="text-sm font-medium text-slate-900">{action.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{action.source}</div>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <div className="font-semibold text-slate-700">{action.owner}</div>
                  <div>{action.due}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <AiWorkConsole compact />
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="text-sm text-slate-500">{c.label}</div>
            <div className="mt-2">
              <span className={`text-3xl font-semibold ${c.accent}`}>{c.value}</span>
              <span className="ml-1 text-sm text-slate-400">{c.suffix}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="font-semibold text-slate-800">최근 주문</h2>
            <Link href="/orders" className="text-sm font-medium text-brand hover:underline">
              전체 보기 →
            </Link>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium">주문번호</th>
                <th className="px-5 py-2 font-medium">고객</th>
                <th className="px-5 py-2 font-medium">품목</th>
                <th className="px-5 py-2 text-right font-medium">수량</th>
                <th className="px-5 py-2 font-medium">상태</th>
              </tr>
            </thead>
            <tbody>
              {orders.slice(0, 5).map((o) => (
                <tr key={o.id} className="border-t border-slate-50">
                  <td className="px-5 py-3 font-mono text-xs text-slate-600">{o.id}</td>
                  <td className="px-5 py-3 text-slate-800">{o.customer}</td>
                  <td className="px-5 py-3 text-slate-600">{o.item}</td>
                  <td className="px-5 py-3 text-right text-slate-800">{o.qty.toLocaleString()}</td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[o.status]}`}>
                      {o.status}
                    </span>
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
                    주문이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="font-semibold text-slate-800">재고 부족 알림</h2>
          </div>
          <ul className="divide-y divide-slate-50">
            {lowStock.map((p) => (
              <li key={p.sku} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm text-slate-800">{p.name}</div>
                  <div className="text-xs text-slate-400">{p.sku}</div>
                </div>
                <div className="text-right">
                  <span className="font-semibold text-red-600">{p.stock}</span>
                  <span className="text-xs text-slate-400"> / {p.safetyStock}</span>
                </div>
              </li>
            ))}
            {lowStock.length === 0 && (
              <li className="px-5 py-8 text-center text-slate-400">부족 품목 없음</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
