export type EmployeeDirectoryEntry = {
  id: string;
  employee: string;
  accountId: string;
  team: string;
  role: "owner" | "staff";
  defaultWorkArea: string;
  workAreas: string[];
  emails: string[];
  kakaoworkUserIds: string[];
  orbitUserIds: string[];
  pcHostnames: string[];
  aliases: string[];
};

export type EmployeeIdentityInput = {
  employee?: string;
  employeeName?: string;
  employeeId?: string;
  accountId?: string;
  userName?: string;
  userId?: string;
  userEmail?: string;
  email?: string;
  kakaoworkUserId?: string;
  hostname?: string;
};

export type ResolvedEmployeeIdentity = EmployeeDirectoryEntry & {
  confidence: number;
  matchedBy: string;
};

export const EMPLOYEE_DIRECTORY: EmployeeDirectoryEntry[] = [
  {
    id: "limjy",
    employee: "임재용",
    accountId: "nenova:ops:lim-jaeyong",
    team: "영업지원",
    role: "owner",
    defaultWorkArea: "운영/계약/AI검토",
    workAreas: ["운영/계약", "AI검토/보고", "매출/정산"],
    emails: ["dlaww584@gmail.com", "limjy@nenova.local"],
    kakaoworkUserIds: [],
    orbitUserIds: ["MMONWUCHC96FB6029B", "MNH03H73690BB2CD82"],
    pcHostnames: ["이재만"],
    aliases: ["임재용", "이재만", "Lim Jaeyong", "limjy"],
  },
  {
    id: "seol",
    employee: "설연주",
    accountId: "nenova:sales-support:sul-yeonju",
    team: "영업지원",
    role: "staff",
    defaultWorkArea: "견적/거래처 단가",
    workAreas: ["견적/거래처 단가", "정산/입금 대조", "고객응대"],
    emails: ["seol@nenova.local", "worker@example.com"],
    kakaoworkUserIds: ["kw-user-001"],
    orbitUserIds: ["MNIAFICB3DC88DCB34"],
    pcHostnames: ["NEONVA", "NENOVA2025"],
    aliases: ["설연주", "네노바연주", "Sul Yeonju", "sul-yeonju", "seol"],
  },
  {
    id: "kang",
    employee: "강현우",
    accountId: "nenova:sales-support:kang-hyunwoo",
    team: "영업지원",
    role: "staff",
    defaultWorkArea: "재고/출고 확인",
    workAreas: ["재고/출고 확인", "매출마감", "출고 일정"],
    emails: ["kang@nenova.local"],
    kakaoworkUserIds: [],
    orbitUserIds: ["MNMRX6SR07F5FF7C0C"],
    pcHostnames: ["DESKTOP-T09911T"],
    aliases: ["강현우", "Kang Hyunwoo", "kang-hyunwoo", "kang"],
  },
  {
    id: "park",
    employee: "박성수",
    accountId: "nenova:sales:park-sungsu",
    team: "영업팀",
    role: "staff",
    defaultWorkArea: "고객응대/상담",
    workAreas: ["고객응대/상담", "프로젝트 상담", "카카오 후속"],
    emails: ["park@nenova.local"],
    kakaoworkUserIds: [],
    orbitUserIds: [],
    pcHostnames: ["DESKTOP-HGNEA1S"],
    aliases: ["박성수", "Park Sungsu", "park-sungsu", "park"],
  },
];

function norm(value?: string | number | null) {
  return String(value ?? "").trim().toLowerCase();
}

function includes(list: string[], value?: string | number | null) {
  const key = norm(value);
  return Boolean(key) && list.some((item) => norm(item) === key);
}

function score(entry: EmployeeDirectoryEntry, input: EmployeeIdentityInput): { confidence: number; matchedBy: string } | null {
  if (includes([entry.accountId], input.accountId)) return { confidence: 100, matchedBy: "accountId" };
  if (includes([entry.id], input.employeeId)) return { confidence: 96, matchedBy: "employeeId" };
  if (includes(entry.emails, input.userEmail || input.email)) return { confidence: 95, matchedBy: "email" };
  if (includes(entry.kakaoworkUserIds, input.kakaoworkUserId || input.userId)) return { confidence: 94, matchedBy: "kakaoworkUserId" };
  if (includes(entry.orbitUserIds, input.userId || input.employeeId)) return { confidence: 92, matchedBy: "orbitUserId" };
  if (includes(entry.pcHostnames, input.hostname)) return { confidence: 90, matchedBy: "hostname" };
  if (includes([entry.employee, ...entry.aliases], input.employee || input.employeeName || input.userName)) return { confidence: 86, matchedBy: "name" };
  return null;
}

export function resolveEmployeeIdentity(input: EmployeeIdentityInput): ResolvedEmployeeIdentity | null {
  const matches = EMPLOYEE_DIRECTORY
    .map((entry) => {
      const result = score(entry, input);
      return result ? { ...entry, ...result } : null;
    })
    .filter(Boolean) as ResolvedEmployeeIdentity[];

  return matches.sort((a, b) => b.confidence - a.confidence)[0] || null;
}
