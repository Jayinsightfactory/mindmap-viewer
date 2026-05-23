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
const PRODUCTS_KEY = "nenova_products";
const CUSTOMERS_KEY = "nenova_customers";

const SEED_ORDERS: Order[] = [
  { id: "ORD-20260518-001", customer: "대한상사", item: "정밀 베어링 6204", qty: 120, status: "완료", owner: "설연주", memo: "정기 납품", createdAt: "2026-05-18T01:12:00.000Z" },
  { id: "ORD-20260519-002", customer: "한빛테크", item: "유압 실린더 50mm", qty: 8, status: "처리중", owner: "설연주", memo: "납기 5/25", createdAt: "2026-05-19T02:40:00.000Z" },
  { id: "ORD-20260519-003", customer: "성진ENG", item: "스테인리스 볼트 M8", qty: 2000, status: "접수", owner: "강현우", memo: "", createdAt: "2026-05-19T05:05:00.000Z" },
  { id: "ORD-20260520-004", customer: "대한상사", item: "오링 NBR 20호", qty: 500, status: "접수", owner: "설연주", memo: "긴급", createdAt: "2026-05-20T00:30:00.000Z" },
];

const SEED_PRODUCTS: Product[] = [
  { sku: "BR-6204", name: "정밀 베어링 6204", stock: 42, safetyStock: 50, unitPrice: 3200 },
  { sku: "HC-50", name: "유압 실린더 50mm", stock: 15, safetyStock: 5, unitPrice: 84000 },
  { sku: "BT-M8", name: "스테인리스 볼트 M8", stock: 18400, safetyStock: 5000, unitPrice: 90 },
  { sku: "OR-NBR20", name: "오링 NBR 20호", stock: 320, safetyStock: 400, unitPrice: 150 },
  { sku: "VL-2W", name: "솔레노이드 밸브 2way", stock: 7, safetyStock: 10, unitPrice: 21000 },
];

const SEED_CUSTOMERS: Customer[] = [
  { id: "C-001", name: "대한상사", contact: "김철수 과장", phone: "010-1234-5678", orders: 38 },
  { id: "C-002", name: "한빛테크", contact: "이영희 대리", phone: "010-2345-6789", orders: 21 },
  { id: "C-003", name: "성진ENG", contact: "박민수 부장", phone: "010-3456-7890", orders: 12 },
  { id: "C-004", name: "우진산업", contact: "최지은 사원", phone: "010-4567-8901", orders: 5 },
];

function load<T>(key: string, seed: T[]): T[] {
  if (typeof window === "undefined") return seed;
  const raw = localStorage.getItem(key);
  if (!raw) {
    localStorage.setItem(key, JSON.stringify(seed));
    return seed;
  }
  try {
    return JSON.parse(raw) as T[];
  } catch {
    return seed;
  }
}

function save<T>(key: string, value: T[]) {
  localStorage.setItem(key, JSON.stringify(value));
}

/* ── 주문 ─────────────────────────────────────────── */

export function getOrders(): Order[] {
  return load(ORDERS_KEY, SEED_ORDERS).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function nextOrderId(): string {
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const todays = load(ORDERS_KEY, SEED_ORDERS).filter((o) => o.id.includes(ymd));
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
  const orders = load(ORDERS_KEY, SEED_ORDERS);
  orders.push(order);
  save(ORDERS_KEY, orders);

  // 품목명이 일치하는 재고가 있으면 자동 차감 (0 미만 방지)
  const products = load(PRODUCTS_KEY, SEED_PRODUCTS);
  const p = products.find((x) => x.name === order.item);
  if (p) {
    p.stock = Math.max(0, p.stock - order.qty);
    save(PRODUCTS_KEY, products);
  }
  return order;
}

export function updateOrderStatus(id: string, status: OrderStatus) {
  const orders = load(ORDERS_KEY, SEED_ORDERS).map((o) => (o.id === id ? { ...o, status } : o));
  save(ORDERS_KEY, orders);
}

export function deleteOrder(id: string) {
  save(ORDERS_KEY, load(ORDERS_KEY, SEED_ORDERS).filter((o) => o.id !== id));
}

/* ── 재고 ─────────────────────────────────────────── */

export function getProducts(): Product[] {
  return load(PRODUCTS_KEY, SEED_PRODUCTS);
}

export function addProduct(input: Product): { ok: boolean; error?: string } {
  const products = load(PRODUCTS_KEY, SEED_PRODUCTS);
  if (products.some((p) => p.sku === input.sku)) {
    return { ok: false, error: "이미 존재하는 SKU입니다." };
  }
  products.push(input);
  save(PRODUCTS_KEY, products);
  return { ok: true };
}

export function adjustStock(sku: string, delta: number) {
  const products = load(PRODUCTS_KEY, SEED_PRODUCTS).map((p) =>
    p.sku === sku ? { ...p, stock: Math.max(0, p.stock + delta) } : p
  );
  save(PRODUCTS_KEY, products);
}

/* ── 고객 ─────────────────────────────────────────── */

export function getCustomers(): Customer[] {
  return load(CUSTOMERS_KEY, SEED_CUSTOMERS);
}

export function nextCustomerId(): string {
  const customers = load(CUSTOMERS_KEY, SEED_CUSTOMERS);
  const max = customers.reduce((m, c) => {
    const n = Number(c.id.replace(/\D/g, ""));
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `C-${String(max + 1).padStart(3, "0")}`;
}

export function addCustomer(input: Omit<Customer, "id" | "orders"> & { orders?: number }): Customer {
  const customer: Customer = { ...input, id: nextCustomerId(), orders: input.orders ?? 0 };
  const customers = load(CUSTOMERS_KEY, SEED_CUSTOMERS);
  customers.push(customer);
  save(CUSTOMERS_KEY, customers);
  return customer;
}
