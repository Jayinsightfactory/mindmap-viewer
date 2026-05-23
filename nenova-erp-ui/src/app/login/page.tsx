"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const user = login(id.trim(), password);
    if (!user) {
      setError("아이디 또는 비밀번호가 올바르지 않습니다.");
      return;
    }
    router.replace("/dashboard");
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="inline-grid h-12 w-12 place-items-center rounded-xl bg-brand text-xl font-bold text-white">
            N
          </span>
          <h1 className="mt-4 text-2xl font-semibold text-white">
            NENOVA <span className="text-brand">ERP</span>
          </h1>
          <p className="mt-1 text-sm text-slate-400">네노바 내부 업무 시스템</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl bg-white p-6 shadow-xl"
        >
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              아이디
            </label>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="username"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              placeholder="limjy"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              비밀번호
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              placeholder="••••••••"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            className="w-full rounded-md bg-brand py-2.5 font-medium text-white transition-colors hover:bg-blue-700"
          >
            로그인
          </button>

          <p className="pt-2 text-center text-xs text-slate-400">
            데모 계정: limjy / seol / kang / park · 비밀번호 orbit2024
          </p>
        </form>
      </div>
    </div>
  );
}
