"use client";

import { useEffect, useState } from "react";
import { getProducts, addProduct, adjustStock, type Product } from "@/lib/store";

export default function InventoryPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [showForm, setShowForm] = useState(false);

  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [stock, setStock] = useState("");
  const [safety, setSafety] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState("");

  function refresh() {
    setProducts(getProducts());
  }

  useEffect(() => {
    refresh();
  }, []);

  function resetForm() {
    setSku("");
    setName("");
    setStock("");
    setSafety("");
    setPrice("");
    setError("");
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!sku.trim() || !name.trim()) {
      setError("SKU와 품목명을 입력하세요.");
      return;
    }
    const res = addProduct({
      sku: sku.trim(),
      name: name.trim(),
      stock: Math.max(0, Number(stock) || 0),
      safetyStock: Math.max(0, Number(safety) || 0),
      unitPrice: Math.max(0, Number(price) || 0),
    });
    if (!res.ok) {
      setError(res.error ?? "등록 실패");
      return;
    }
    resetForm();
    setShowForm(false);
    refresh();
  }

  function handleAdjust(p: Product, delta: number) {
    const input = prompt(`${p.name} ${delta > 0 ? "입고" : "출고"} 수량`, "10");
    if (input == null) return;
    const n = Number(input);
    if (!Number.isFinite(n) || n <= 0) return;
    adjustStock(p.sku, delta > 0 ? n : -n);
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
          {showForm ? "닫기" : "+ 신규 품목"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="mb-4 font-semibold text-slate-800">신규 품목 등록</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU (예: BR-6204)" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="품목명" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
            <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="단가(원)" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
            <input type="number" min={0} value={stock} onChange={(e) => setStock(e.target.value)} placeholder="현재고" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
            <input type="number" min={0} value={safety} onChange={(e) => setSafety(e.target.value)} placeholder="안전재고" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
          </div>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">취소</button>
            <button type="submit" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">저장</button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">품목명</th>
              <th className="px-4 py-3 text-right font-medium">현재고</th>
              <th className="px-4 py-3 text-right font-medium">안전재고</th>
              <th className="px-4 py-3 text-right font-medium">단가</th>
              <th className="px-4 py-3 font-medium">상태</th>
              <th className="px-4 py-3 text-center font-medium">입출고</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const low = p.stock < p.safetyStock;
              return (
                <tr key={p.sku} className="border-t border-slate-100 hover:bg-slate-50/50">
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{p.sku}</td>
                  <td className="px-4 py-3 text-slate-800">{p.name}</td>
                  <td className="px-4 py-3 text-right text-slate-800">{p.stock.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-slate-500">{p.safetyStock.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-slate-600">{p.unitPrice.toLocaleString()}원</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${low ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                      {low ? "부족" : "정상"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-center gap-1">
                      <button onClick={() => handleAdjust(p, 1)} className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">입고</button>
                      <button onClick={() => handleAdjust(p, -1)} className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">출고</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">데이터는 현재 브라우저에 임시 저장됩니다 (추후 입출고 이력·발주 연동 예정).</p>
    </div>
  );
}
