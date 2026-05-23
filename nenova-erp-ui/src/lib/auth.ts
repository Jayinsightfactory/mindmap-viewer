"use client";

export type SessionUser = {
  id: string;
  name: string;
  role: "owner" | "staff";
  team: string;
};

const KEY = "nenova_session";

// 목업 계정 — 추후 Orbit 인증 API 또는 자체 DB 연동으로 교체
const ACCOUNTS: Array<SessionUser & { password: string }> = [
  { id: "limjy", password: "orbit2024", name: "임재용", role: "owner", team: "영업지원" },
  { id: "seol", password: "orbit2024", name: "설연주", role: "staff", team: "영업지원" },
  { id: "kang", password: "orbit2024", name: "강현우", role: "staff", team: "영업지원" },
  { id: "park", password: "orbit2024", name: "박성수", role: "staff", team: "영업팀" },
];

export function login(id: string, password: string): SessionUser | null {
  const found = ACCOUNTS.find((a) => a.id === id && a.password === password);
  if (!found) return null;
  const { password: _pw, ...user } = found;
  localStorage.setItem(KEY, JSON.stringify(user));
  return user;
}

export function logout() {
  localStorage.removeItem(KEY);
}

export function getSession(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}
