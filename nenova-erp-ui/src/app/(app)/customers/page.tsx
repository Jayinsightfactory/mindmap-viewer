"use client";

import { CUSTOMERS } from "@/lib/store";

export default function CustomersPage() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CUSTOMERS.map((c) => (
          <div key={c.id} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-brand/10 font-semibold text-brand">
                {c.name.slice(0, 1)}
              </span>
              <div>
                <div className="font-medium text-slate-800">{c.name}</div>
                <div className="text-xs text-slate-400">{c.id}</div>
              </div>
            </div>
            <dl className="mt-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-400">담당자</dt>
                <dd className="text-slate-700">{c.contact}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">연락처</dt>
                <dd className="text-slate-700">{c.phone}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">누적 주문</dt>
                <dd className="font-medium text-slate-800">{c.orders}건</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400">현재 목업 데이터입니다. 추후 거래내역·연락 이력 연동 예정.</p>
    </div>
  );
}
