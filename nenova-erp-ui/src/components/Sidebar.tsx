"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/nav";

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

      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-brand text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-6 py-4 text-xs text-slate-500">
        v0.1.0 · 내부 전용
      </div>
    </aside>
  );
}
