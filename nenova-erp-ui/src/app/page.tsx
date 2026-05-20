"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSession } from "@/lib/auth";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getSession() ? "/dashboard" : "/login");
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center text-slate-400">
      불러오는 중…
    </div>
  );
}
