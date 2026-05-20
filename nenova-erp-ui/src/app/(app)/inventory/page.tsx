"use client";

import { PRODUCTS } from "@/lib/store";

export default function InventoryPage() {
  return (
    <div className="space-y-5">
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
            </tr>
          </thead>
          <tbody>
            {PRODUCTS.map((p) => {
              const low = p.stock < p.safetyStock;
              return (
                <tr key={p.sku} className="border-t border-slate-100 hover:bg-slate-50/50">
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{p.sku}</td>
                  <td className="px-4 py-3 text-slate-800">{p.name}</td>
                  <td className="px-4 py-3 text-right text-slate-800">{p.stock.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-slate-500">{p.safetyStock.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-slate-600">{p.unitPrice.toLocaleString()}원</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        low ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                      }`}
                    >
                      {low ? "부족" : "정상"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">현재 목업 데이터입니다. 추후 입출고 기록·발주 연동 예정.</p>
    </div>
  );
}
