"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_GROUPS } from "@/lib/nav";

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-slate-900 text-slate-300">
      <div className="flex h-16 items-center gap-2 px-6">
        <span className="grid h-8 w-8 place-items-center rounded-md bg-brand font-bold text-white">
          N
        </span>
        <span className="text-lg font-semibold tracking-tight text-white">
          NENOVA <span className="text-brand">ERP</span>
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-5">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                        active
                          ? "bg-brand text-white"
                          : "text-slate-300 hover:bg-slate-800 hover:text-white"
                      }`}
                    >
                      <span className={`grid h-6 w-9 shrink-0 place-items-center rounded border text-[10px] font-bold leading-none ${
                        active
                          ? "border-white/25 bg-white/15 text-white"
                          : "border-slate-700 bg-slate-800 text-slate-400"
                      }`}>
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="px-6 py-4 text-xs text-slate-500">
        v0.1.0 · 내부 전용
      </div>
    </aside>
  );
}
