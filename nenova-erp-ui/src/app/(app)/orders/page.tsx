"use client";

import { useEffect, useMemo, useState } from "react";
import { getSession } from "@/lib/auth";
import {
  getOrders,
  addOrder,
  updateOrderStatus,
  deleteOrder,
  nextOrderId,
  PRODUCTS,
  CUSTOMERS,
  type Order,
  type OrderStatus,
} from "@/lib/store";

const STATUSES: OrderStatus[] = ["접수", "처리중", "완료", "취소"];
const STATUS_STYLE: Record<OrderStatus, string> = {
  접수: "bg-amber-100 text-amber-700",
  처리중: "bg-blue-100 text-blue-700",
  완료: "bg-green-100 text-green-700",
  취소: "bg-slate-200 text-slate-500",
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"전체" | OrderStatus>("전체");
  const [showForm, setShowForm] = useState(false);

  const [customer, setCustomer] = useState("");
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("");
  const [memo, setMemo] = useState("");
  const [formError, setFormError] = useState("");

  function refresh() {
    setOrders(getOrders());
  }

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      const matchesQuery =
        !query ||
        o.id.toLowerCase().includes(query.toLowerCase()) ||
        o.customer.toLowerCase().includes(query.toLowerCase()) ||
        o.item.toLowerCase().includes(query.toLowerCase());
      const matchesFilter = filter === "전체" || o.status === filter;
      return matchesQuery && matchesFilter;
    });
  }, [orders, query, filter]);

  function resetForm() {
    setCustomer("");
    setItem("");
    setQty("");
    setMemo("");
    setFormError("");
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(qty);
    if (!customer.trim() || !item.trim()) {
      setFormError("고객명과 품목을 입력하세요.");
      return;
    }
    if (!Number.isFinite(n) || n <= 0) {
      setFormError("수량은 1 이상의 숫자여야 합니다.");
      return;
    }
    addOrder({
      customer: customer.trim(),
      item: item.trim(),
      qty: n,
      memo: memo.trim(),
      owner: getSession()?.name ?? "미지정",
    });
    resetForm();
    setShowForm(false);
    refresh();
  }

  function handleStatus(id: string, status: OrderStatus) {
    updateOrderStatus(id, status);
    refresh();
  }

  function handleDelete(id: string) {
    if (confirm(`주문 ${id} 을(를) 삭제할까요?`)) {
      deleteOrder(id);
      refresh();
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="주문번호 · 고객 · 품목 검색"
            className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as "전체" | OrderStatus)}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand"
          >
            <option value="전체">전체 상태</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => {
            resetForm();
            setShowForm((v) => !v);
          }}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {showForm ? "닫기" : "+ 신규 주문"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-xl border border-slate-200 bg-white p-5"
        >
          <div className="mb-4 flex items-center gap-2">
            <h2 className="font-semibold text-slate-800">신규 주문 등록</h2>
            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-500">
              {nextOrderId()}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">고객명</label>
              <input
                list="customer-list"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                placeholder="고객사 선택 또는 입력"
              />
              <datalist id="customer-list">
                {CUSTOMERS.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">품목</label>
              <input
                list="product-list"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                placeholder="품목 선택 또는 입력"
              />
              <datalist id="product-list">
                {PRODUCTS.map((p) => (
                  <option key={p.sku} value={p.name} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">수량</label>
              <input
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                placeholder="0"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">메모</label>
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                placeholder="납기 · 특이사항"
              />
            </div>
          </div>
          {formError && <p className="mt-3 text-sm text-red-600">{formError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              취소
            </button>
            <button
              type="submit"
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              저장
            </button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">주문번호</th>
              <th className="px-4 py-3 font-medium">고객</th>
              <th className="px-4 py-3 font-medium">품목</th>
              <th className="px-4 py-3 text-right font-medium">수량</th>
              <th className="px-4 py-3 font-medium">담당</th>
              <th className="px-4 py-3 font-medium">메모</th>
              <th className="px-4 py-3 font-medium">상태</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((o) => (
              <tr key={o.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{o.id}</td>
                <td className="px-4 py-3 text-slate-800">{o.customer}</td>
                <td className="px-4 py-3 text-slate-600">{o.item}</td>
                <td className="px-4 py-3 text-right text-slate-800">{o.qty.toLocaleString()}</td>
                <td className="px-4 py-3 text-slate-600">{o.owner}</td>
                <td className="px-4 py-3 text-slate-400">{o.memo || "—"}</td>
                <td className="px-4 py-3">
                  <select
                    value={o.status}
                    onChange={(e) => handleStatus(o.id, e.target.value as OrderStatus)}
                    className={`rounded-full border-0 px-2 py-1 text-xs font-medium outline-none ${STATUS_STYLE[o.status]}`}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => handleDelete(o.id)}
                    className="text-xs font-medium text-slate-400 hover:text-red-600"
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  조건에 맞는 주문이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        총 {filtered.length}건 · 데이터는 현재 브라우저에 임시 저장됩니다 (추후 서버 연동).
      </p>
    </div>
  );
}
