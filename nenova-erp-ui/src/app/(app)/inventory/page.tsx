"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addProduct,
  adjustStock,
  getProductChangeHistory,
  getProducts,
  updateProductCommercial,
  type Product,
  type ProductChangeKind,
  type ProductChangeRecord,
  type ProductTransferStatus,
} from "@/lib/store";

const TRANSFER_STATUSES: ProductTransferStatus[] = ["미요청", "송금대기", "송금완료"];

const TRANSFER_STYLE: Record<ProductTransferStatus, string> = {
  미요청: "bg-slate-100 text-slate-600",
  송금대기: "bg-amber-100 text-amber-700",
  송금완료: "bg-green-100 text-green-700",
};

const CHANGE_STYLE: Record<ProductChangeKind, string> = {
  입고: "bg-blue-100 text-blue-700",
  출고: "bg-slate-100 text-slate-600",
  단가변경: "bg-violet-100 text-violet-700",
  송금상태: "bg-emerald-100 text-emerald-700",
  품목등록: "bg-cyan-100 text-cyan-700",
};

function formatDateTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export default function InventoryPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [changes, setChanges] = useState<ProductChangeRecord[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingSku, setEditingSku] = useState("");

  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [stock, setStock] = useState("");
  const [safety, setSafety] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState("");

  const [editPrice, setEditPrice] = useState("");
  const [editTransferStatus, setEditTransferStatus] = useState<ProductTransferStatus>("미요청");
  const [editMemo, setEditMemo] = useState("");
  const [editError, setEditError] = useState("");

  function refresh() {
    setProducts(getProducts());
    setChanges(getProductChangeHistory());
  }

  useEffect(() => {
    refresh();
  }, []);

  const changesBySku = useMemo(() => {
    return changes.reduce<Record<string, ProductChangeRecord[]>>((acc, change) => {
      acc[change.sku] = acc[change.sku] ? [...acc[change.sku], change] : [change];
      return acc;
    }, {});
  }, [changes]);

  const productsWithChanges = useMemo(() => {
    return products
      .map((product) => ({ product, history: changesBySku[product.sku] ?? [] }))
      .filter((item) => item.history.length > 0)
      .sort((a, b) => b.history[0].changedAt.localeCompare(a.history[0].changedAt));
  }, [products, changesBySku]);

  const editingProduct = products.find((p) => p.sku === editingSku) ?? null;

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
      transferStatus: "미요청",
      transferMemo: "",
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
    adjustStock(p.sku, delta > 0 ? n : -n, "nenovaweb", delta > 0 ? "입고 수량 직접 반영" : "출고 수량 직접 반영");
    refresh();
  }

  function openCommercialEditor(product: Product) {
    setEditingSku(product.sku);
    setEditPrice(String(product.unitPrice));
    setEditTransferStatus(product.transferStatus ?? "미요청");
    setEditMemo(product.transferMemo ?? "");
    setEditError("");
  }

  function handleCommercialSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editingProduct) return;
    const nextPrice = Number(editPrice);
    if (!Number.isFinite(nextPrice) || nextPrice < 0) {
      setEditError("입고단가는 0 이상의 숫자여야 합니다.");
      return;
    }
    const res = updateProductCommercial(editingProduct.sku, {
      unitPrice: nextPrice,
      transferStatus: editTransferStatus,
      transferMemo: editMemo,
      actor: "nenovaweb",
    });
    if (!res.ok) {
      setEditError(res.error ?? "저장 실패");
      return;
    }
    setEditingSku("");
    refresh();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">입고단가 · 송금 관리</p>
          <h2 className="mt-1 text-xl font-semibold text-slate-900">품목별 입출고와 단가 변경을 한 화면에서 확인</h2>
        </div>
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
            <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="입고단가(원)" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
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

      {editingProduct && (
        <form onSubmit={handleCommercialSave} className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold text-slate-800">입고단가 · 송금 변경</h2>
              <p className="mt-1 text-sm text-slate-500">{editingProduct.name} · {editingProduct.sku}</p>
            </div>
            <button type="button" onClick={() => setEditingSku("")} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">닫기</button>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[180px_180px_minmax(0,1fr)]">
            <label className="block text-sm font-medium text-slate-700">
              입고단가
              <input type="number" min={0} value={editPrice} onChange={(e) => setEditPrice(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              송금상태
              <select value={editTransferStatus} onChange={(e) => setEditTransferStatus(e.target.value as ProductTransferStatus)} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand">
                {TRANSFER_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              메모
              <input value={editMemo} onChange={(e) => setEditMemo(e.target.value)} placeholder="변경 사유, 공급사 확인 내용" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand" />
            </label>
          </div>
          {editError && <p className="mt-3 text-sm text-red-600">{editError}</p>}
          <div className="mt-4 flex justify-end">
            <button type="submit" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">변경 저장</button>
          </div>
        </form>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">품목명</th>
                  <th className="px-4 py-3 text-right font-medium">현재고</th>
                  <th className="px-4 py-3 text-right font-medium">안전재고</th>
                  <th className="px-4 py-3 text-right font-medium">입고단가</th>
                  <th className="px-4 py-3 font-medium">송금</th>
                  <th className="px-4 py-3 font-medium">상태</th>
                  <th className="px-4 py-3 text-center font-medium">작업</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const low = p.stock < p.safetyStock;
                  const rowChanges = changesBySku[p.sku] ?? [];
                  return (
                    <tr key={p.sku} className="border-t border-slate-100 hover:bg-slate-50/50">
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{p.sku}</td>
                      <td className="px-4 py-3 text-slate-800">
                        <div className="font-medium">{p.name}</div>
                        {rowChanges.length > 0 && (
                          <div className="mt-1 text-xs text-slate-400">변경 {rowChanges.length}건 · 최근 {formatDateTime(rowChanges[0].changedAt)}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-800">{p.stock.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-slate-500">{p.safetyStock.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{p.unitPrice.toLocaleString()}원</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TRANSFER_STYLE[p.transferStatus ?? "미요청"]}`}>
                          {p.transferStatus ?? "미요청"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${low ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                          {low ? "부족" : "정상"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-center gap-1">
                          <button onClick={() => handleAdjust(p, 1)} className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">입고</button>
                          <button onClick={() => handleAdjust(p, -1)} className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">출고</button>
                          <button onClick={() => openCommercialEditor(p)} className="rounded border border-brand/40 px-2 py-1 text-xs font-medium text-brand hover:bg-blue-50">단가/송금</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold text-slate-800">변경내역 있는 품목</h2>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{productsWithChanges.length}개</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">입고, 출고, 단가, 송금상태가 바뀐 품목만 따로 모아 봅니다.</p>
          </div>
          <div className="max-h-[620px] space-y-3 overflow-y-auto p-4">
            {productsWithChanges.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">아직 변경내역이 있는 품목이 없습니다.</div>
            ) : (
              productsWithChanges.map(({ product, history }) => (
                <div key={product.sku} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-800">{product.name}</div>
                      <div className="mt-0.5 font-mono text-xs text-slate-400">{product.sku}</div>
                    </div>
                    <button onClick={() => openCommercialEditor(product)} className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">수정</button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {history.slice(0, 3).map((change) => (
                      <div key={change.id} className="rounded-md bg-slate-50 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHANGE_STYLE[change.kind]}`}>{change.kind}</span>
                          <span className="text-[11px] text-slate-400">{formatDateTime(change.changedAt)}</span>
                        </div>
                        <div className="mt-1 text-sm text-slate-700">
                          <span className="text-slate-400">{change.before}</span>
                          <span className="px-1 text-slate-400">→</span>
                          <span className="font-medium">{change.after}</span>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{change.memo || "메모 없음"} · {change.actor}</div>
                      </div>
                    ))}
                    {history.length > 3 && <div className="text-xs text-slate-400">외 {history.length - 3}건 더 있음</div>}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      <p className="text-xs text-slate-400">데이터는 현재 브라우저에 임시 저장됩니다. 변경내역은 입고·출고·단가·송금상태 변경 시 자동으로 누적됩니다.</p>
    </div>
  );
}
