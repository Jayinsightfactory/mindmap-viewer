"use client";

// 목업 데이터 계층 — localStorage 기반.
// 추후 Orbit 서버 API 또는 nenova-erp 자체 DB 연동으로 교체.

export type OrderStatus = "접수" | "처리중" | "완료" | "취소";

export type Order = {
  id: string; // 주문번호
  customer: string;
  item: string;
  qty: number;
  status: OrderStatus;
  owner: string; // 담당자
  memo: string;
  createdAt: string; // ISO
};

export type Product = {
  sku: string;
  name: string;
  stock: number;
  safetyStock: number;
  unitPrice: number;
};

export type Customer = {
  id: string;
  name: string;
  contact: string;
  phone: string;
  orders: number;
};

const ORDERS_KEY = "nenova_orders";

const SEED_ORDERS: Order[] = [
  { id: "ORD-20260518-001", customer: "대한상사", item: "정밀 베어링 6204", qty: 120, status: "완료", owner: "설연주", memo: "정기 납품", createdAt: "2026-05-18T01:12:00.000Z" },
  { id: "ORD-20260519-002", customer: "한빛테크", item: "유압 실린더 50mm", qty: 8, status: "처리중", owner: "설연주", memo: "납기 5/25", createdAt: "2026-05-19T02:40:00.000Z" },
  { id: "ORD-20260519-003", customer: "성진ENG", item: "스테인리스 볼트 M8", qty: 2000, status: "접수", owner: "강현우", memo: "", createdAt: "2026-05-19T05:05:00.000Z" },
  { id: "ORD-20260520-004", customer: "대한상사", item: "오링 NBR 20호", qty: 500, status: "접수", owner: "설연주", memo: "긴급", createdAt: "2026-05-20T00:30:00.000Z" },
];

export const PRODUCTS: Product[] = [
  { sku: "BR-6204", name: "정밀 베어링 6204", stock: 42, safetyStock: 50, unitPrice: 3200 },
  { sku: "HC-50", name: "유압 실린더 50mm", stock: 15, safetyStock: 5, unitPrice: 84000 },
  { sku: "BT-M8", name: "스테인리스 볼트 M8", stock: 18400, safetyStock: 5000, unitPrice: 90 },
  { sku: "OR-NBR20", name: "오링 NBR 20호", stock: 320, safetyStock: 400, unitPrice: 150 },
  { sku: "VL-2W", name: "솔레노이드 밸브 2way", stock: 7, safetyStock: 10, unitPrice: 21000 },
];

export const CUSTOMERS: Customer[] = [
  { id: "C-001", name: "대한상사", contact: "김철수 과장", phone: "010-1234-5678", orders: 38 },
  { id: "C-002", name: "한빛테크", contact: "이영희 대리", phone: "010-2345-6789", orders: 21 },
  { id: "C-003", name: "성진ENG", contact: "박민수 부장", phone: "010-3456-7890", orders: 12 },
  { id: "C-004", name: "우진산업", contact: "최지은 사원", phone: "010-4567-8901", orders: 5 },
];

function read(): Order[] {
  if (typeof window === "undefined") return SEED_ORDERS;
  const raw = localStorage.getItem(ORDERS_KEY);
  if (!raw) {
    localStorage.setItem(ORDERS_KEY, JSON.stringify(SEED_ORDERS));
    return SEED_ORDERS;
  }
  try {
    return JSON.parse(raw) as Order[];
  } catch {
    return SEED_ORDERS;
  }
}

function write(orders: Order[]) {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

export function getOrders(): Order[] {
  return read().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function nextOrderId(): string {
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const todays = read().filter((o) => o.id.includes(ymd));
  const seq = String(todays.length + 1).padStart(3, "0");
  return `ORD-${ymd}-${seq}`;
}

export function addOrder(input: Omit<Order, "id" | "createdAt" | "status"> & { status?: OrderStatus }): Order {
  const order: Order = {
    ...input,
    id: nextOrderId(),
    status: input.status ?? "접수",
    createdAt: new Date().toISOString(),
  };
  const orders = read();
  orders.push(order);
  write(orders);
  return order;
}

export function updateOrderStatus(id: string, status: OrderStatus) {
  const orders = read().map((o) => (o.id === id ? { ...o, status } : o));
  write(orders);
}

export function deleteOrder(id: string) {
  write(read().filter((o) => o.id !== id));
}
