"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getOrders, PRODUCTS, CUSTOMERS, type Order } from "@/lib/store";

const STATUS_STYLE: Record<string, string> = {
  접수: "bg-amber-100 text-amber-700",
  처리중: "bg-blue-100 text-blue-700",
  완료: "bg-green-100 text-green-700",
  취소: "bg-slate-200 text-slate-500",
};

export default function DashboardPage() {
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    setOrders(getOrders());
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const todayCount = orders.filter((o) => o.createdAt.slice(0, 10) === today).length;
  const pending = orders.filter((o) => o.status === "접수" || o.status === "처리중").length;
  const lowStock = PRODUCTS.filter((p) => p.stock < p.safetyStock);

  const cards = [
    { label: "오늘 신규 주문", value: todayCount, suffix: "건", accent: "text-brand" },
    { label: "처리 대기", value: pending, suffix: "건", accent: "text-amber-600" },
    { label: "재고 부족 품목", value: lowStock.length, suffix: "종", accent: "text-red-600" },
    { label: "등록 고객", value: CUSTOMERS.length, suffix: "사", accent: "text-green-600" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="text-sm text-slate-500">{c.label}</div>
            <div className="mt-2">
              <span className={`text-3xl font-semibold ${c.accent}`}>{c.value}</span>
              <span className="ml-1 text-sm text-slate-400">{c.suffix}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white lg:col-span-2">
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

        <div className="rounded-xl border border-slate-200 bg-white">
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
