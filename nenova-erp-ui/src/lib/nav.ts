export type NavItem = {
  href: string;
  label: string;
  icon: string; // 이모지 — 추후 아이콘 컴포넌트로 교체 가능
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "홈",
    items: [
      { href: "/dashboard", label: "대시보드", icon: "HOME" },
    ],
  },
  {
    label: "실무 처리",
    items: [
      { href: "/erp-flow", label: "업무 흐름", icon: "ERP" },
      { href: "/orders", label: "주문", icon: "ORD" },
      { href: "/inventory", label: "입고/송금", icon: "PAY" },
      { href: "/customers", label: "고객", icon: "CUS" },
    ],
  },
  {
    label: "검증·자동화",
    items: [
      { href: "/workflow", label: "작업 원장", icon: "LOG" },
      { href: "/assistant", label: "AI 비서", icon: "AI" },
      { href: "/kakaowork", label: "카카오워크", icon: "KW" },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

export function pageTitle(pathname: string): string {
  const item = NAV_ITEMS.find((n) => pathname.startsWith(n.href));
  return item?.label ?? "NENOVA ERP";
}
