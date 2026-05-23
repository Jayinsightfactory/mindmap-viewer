"use client";

import { useEffect, useState } from "react";
import { getCustomers, addCustomer, type Customer } from "@/lib/store";

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");

  function refresh() {
    setCustomers(getCustomers());
  }

  useEffect(() => {
    refresh();
  }, []);

  function resetForm() {
    setName("");
    setContact("");
    setPhone("");
    setError("");
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("고객사명을 입력하세요.");
      return;
    }
    addCustomer({ name: name.trim(), contact: contact.trim(), phone: phone.trim() });
    resetForm();
    setShowForm(false);
    refresh();
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <button
          onClick={() => {
            resetForm();
            setShowForm((v) => !v);
          }}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {showForm ? "닫기" : "+ 신규 고객"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="mb-4 font-semibold text-slate-800">신규 고객 등록</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="고객사명" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
            <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="담당자 (예: 김철수 과장)" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="연락처" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
          </div>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">취소</button>
            <button type="submit" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">저장</button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {customers.map((c) => (
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
                <dd className="text-slate-700">{c.contact || "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">연락처</dt>
                <dd className="text-slate-700">{c.phone || "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">누적 주문</dt>
                <dd className="font-medium text-slate-800">{c.orders}건</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400">데이터는 현재 브라우저에 임시 저장됩니다 (추후 거래내역·연락 이력 연동 예정).</p>
    </div>
  );
}
