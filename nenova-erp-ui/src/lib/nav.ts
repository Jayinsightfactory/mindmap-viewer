export type NavItem = {
  href: string;
  label: string;
  icon: string; // 이모지 — 추후 아이콘 컴포넌트로 교체 가능
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "대시보드", icon: "▦" },
  { href: "/orders", label: "신규 주문", icon: "▤" },
  { href: "/inventory", label: "재고 관리", icon: "▣" },
  { href: "/customers", label: "고객 관리", icon: "◍" },
];

export function pageTitle(pathname: string): string {
  const item = NAV_ITEMS.find((n) => pathname.startsWith(n.href));
  return item?.label ?? "NENOVA ERP";
}
