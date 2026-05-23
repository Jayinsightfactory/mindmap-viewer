"use client";

// 브라우저 저장소 기반 ERP 데이터 계층.
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

export type MeetingStatus = "기록" | "견적생성" | "보류";
export type QuoteStatus = "초안" | "발송" | "계약확정" | "반려";
export type ProjectStatus = "대기" | "진행" | "완료" | "보류";
export type WorkTaskStatus = "대기" | "진행" | "완료" | "지연";
export type TaxInvoiceStatus = "작성" | "발행요청" | "발행완료" | "입금완료";

export type MeetingRecord = {
  id: string;
  customer: string;
  title: string;
  summary: string;
  owner: string;
  recordedAt: string;
  status: MeetingStatus;
  quoteId?: string;
};

export type Quote = {
  id: string;
  meetingId?: string;
  customer: string;
  title: string;
  amount: number;
  vat: number;
  total: number;
  status: QuoteStatus;
  owner: string;
  dueDate: string;
  createdAt: string;
  projectId?: string;
};

export type Project = {
  id: string;
  quoteId: string;
  customer: string;
  title: string;
  contractAmount: number;
  status: ProjectStatus;
  owner: string;
  startDate: string;
  dueDate: string;
  progress: number;
};

export type WorkTask = {
  id: string;
  projectId?: string;
  title: string;
  owner: string;
  dueDate: string;
  status: WorkTaskStatus;
  source: string;
  createdAt: string;
};

export type TaxInvoice = {
  id: string;
  projectId?: string;
  quoteId?: string;
  customer: string;
  supplyAmount: number;
  vat: number;
  total: number;
  status: TaxInvoiceStatus;
  memo: string;
  createdAt: string;
  issuedAt?: string;
};

export type DailyReport = {
  id: string;
  date: string;
  summary: string;
  projectCount: number;
  doneTaskCount: number;
  pendingTaskCount: number;
  revenuePending: number;
  createdAt: string;
};

const ORDERS_KEY = "nenova_orders";
const PRODUCTS_KEY = "nenova_products";
const CUSTOMERS_KEY = "nenova_customers";
const MEETINGS_KEY = "nenova_meetings";
const QUOTES_KEY = "nenova_quotes";
const PROJECTS_KEY = "nenova_projects";
const TASKS_KEY = "nenova_tasks";
const INVOICES_KEY = "nenova_tax_invoices";
const REPORTS_KEY = "nenova_daily_reports";

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

const SEED_MEETINGS: MeetingRecord[] = [
  {
    id: "MTG-20260520-001",
    customer: "대한상사",
    title: "정기 납품 단가 조정 미팅",
    summary: "6월 납품 물량 확대 가능성. 베어링과 오링 단가표 재검토 후 견적 요청.",
    owner: "임재용",
    recordedAt: "2026-05-20T09:00:00.000Z",
    status: "견적생성",
    quoteId: "QT-20260520-001",
  },
  {
    id: "MTG-20260521-002",
    customer: "우진산업",
    title: "신규 자동화 설비 상담",
    summary: "재고 부족 알림과 월말 매출 보고 자동화 필요. 파일 샘플 수령 후 견적 예정.",
    owner: "설연주",
    recordedAt: "2026-05-21T06:30:00.000Z",
    status: "기록",
  },
];

const SEED_QUOTES: Quote[] = [
  {
    id: "QT-20260520-001",
    meetingId: "MTG-20260520-001",
    customer: "대한상사",
    title: "6월 정기 납품 단가 견적",
    amount: 3800000,
    vat: 380000,
    total: 4180000,
    status: "발송",
    owner: "임재용",
    dueDate: "2026-05-27",
    createdAt: "2026-05-20T10:00:00.000Z",
  },
];

const SEED_PROJECTS: Project[] = [
  {
    id: "PRJ-20260519-001",
    quoteId: "QT-SEED-001",
    customer: "한빛테크",
    title: "유압 실린더 긴급 납품",
    contractAmount: 672000,
    status: "진행",
    owner: "설연주",
    startDate: "2026-05-19",
    dueDate: "2026-05-25",
    progress: 55,
  },
];

const SEED_TASKS: WorkTask[] = [
  {
    id: "TSK-20260519-001",
    projectId: "PRJ-20260519-001",
    title: "출고 가능 재고 확인",
    owner: "강현우",
    dueDate: "2026-05-24",
    status: "진행",
    source: "프로젝트",
    createdAt: "2026-05-19T03:00:00.000Z",
  },
  {
    id: "TSK-20260520-002",
    title: "대한상사 견적 발송 후 회신 확인",
    owner: "임재용",
    dueDate: "2026-05-23",
    status: "지연",
    source: "견적 팔로업",
    createdAt: "2026-05-20T10:10:00.000Z",
  },
];

const SEED_INVOICES: TaxInvoice[] = [
  {
    id: "TAX-20260519-001",
    projectId: "PRJ-20260519-001",
    customer: "한빛테크",
    supplyAmount: 672000,
    vat: 67200,
    total: 739200,
    status: "발행요청",
    memo: "유압 실린더 긴급 납품 건",
    createdAt: "2026-05-19T07:30:00.000Z",
  },
];

const SEED_REPORTS: DailyReport[] = [];

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

function ymd(date = new Date()) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function dateOnly(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function nextId<T extends { id: string }>(prefix: string, key: string, seed: T[]) {
  const today = ymd();
  const count = load(key, seed).filter((item) => item.id.includes(today)).length + 1;
  return `${prefix}-${today}-${String(count).padStart(3, "0")}`;
}

function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateOnly(date);
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

/* ── 회의/녹음 기록 ───────────────────────────────── */

export function getMeetingRecords(): MeetingRecord[] {
  return load(MEETINGS_KEY, SEED_MEETINGS).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function addMeetingRecord(input: Omit<MeetingRecord, "id" | "recordedAt" | "status">): MeetingRecord {
  const meeting: MeetingRecord = {
    ...input,
    id: nextId("MTG", MEETINGS_KEY, SEED_MEETINGS),
    recordedAt: new Date().toISOString(),
    status: "기록",
  };
  const meetings = load(MEETINGS_KEY, SEED_MEETINGS);
  meetings.push(meeting);
  save(MEETINGS_KEY, meetings);
  return meeting;
}

/* ── 견적/계약 ────────────────────────────────────── */

export function getQuotes(): Quote[] {
  return load(QUOTES_KEY, SEED_QUOTES).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addQuote(input: Omit<Quote, "id" | "vat" | "total" | "status" | "createdAt"> & { status?: QuoteStatus }): Quote {
  const amount = Math.max(0, Math.round(input.amount));
  const quote: Quote = {
    ...input,
    id: nextId("QT", QUOTES_KEY, SEED_QUOTES),
    amount,
    vat: Math.round(amount * 0.1),
    total: Math.round(amount * 1.1),
    status: input.status ?? "초안",
    createdAt: new Date().toISOString(),
  };
  const quotes = load(QUOTES_KEY, SEED_QUOTES);
  quotes.push(quote);
  save(QUOTES_KEY, quotes);
  return quote;
}

export function createQuoteFromMeeting(meetingId: string, amount: number, dueDate: string, owner: string): Quote | null {
  const meetings = load(MEETINGS_KEY, SEED_MEETINGS);
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) return null;

  const quote = addQuote({
    meetingId,
    customer: meeting.customer,
    title: `${meeting.title} 견적`,
    amount,
    owner,
    dueDate,
  });

  meeting.status = "견적생성";
  meeting.quoteId = quote.id;
  save(MEETINGS_KEY, meetings);
  addTask({
    title: `${quote.customer} 견적 발송 후 회신 확인`,
    owner,
    dueDate: addDays(3),
    source: "견적 팔로업",
  });
  return quote;
}

export function updateQuoteStatus(id: string, status: QuoteStatus) {
  const quotes = load(QUOTES_KEY, SEED_QUOTES).map((q) => (q.id === id ? { ...q, status } : q));
  save(QUOTES_KEY, quotes);
}

export function confirmQuoteToProject(quoteId: string, owner: string): Project | null {
  const quotes = load(QUOTES_KEY, SEED_QUOTES);
  const quote = quotes.find((q) => q.id === quoteId);
  if (!quote) return null;

  if (quote.projectId) {
    return load(PROJECTS_KEY, SEED_PROJECTS).find((p) => p.id === quote.projectId) ?? null;
  }

  const project: Project = {
    id: nextId("PRJ", PROJECTS_KEY, SEED_PROJECTS),
    quoteId: quote.id,
    customer: quote.customer,
    title: quote.title.replace(/\s*견적$/, ""),
    contractAmount: quote.amount,
    status: "진행",
    owner,
    startDate: dateOnly(),
    dueDate: quote.dueDate || addDays(14),
    progress: 10,
  };

  const projects = load(PROJECTS_KEY, SEED_PROJECTS);
  projects.push(project);
  save(PROJECTS_KEY, projects);

  quote.status = "계약확정";
  quote.projectId = project.id;
  save(QUOTES_KEY, quotes);

  addTask({ projectId: project.id, title: "계약 내용 확인 및 킥오프 준비", owner, dueDate: addDays(1), source: "계약확정" });
  addTask({ projectId: project.id, title: "담당자별 실행 일정 배정", owner, dueDate: addDays(2), source: "프로젝트" });
  addTaxInvoice({
    projectId: project.id,
    quoteId: quote.id,
    customer: quote.customer,
    supplyAmount: quote.amount,
    memo: `${project.title} 계약 건`,
  });

  return project;
}

/* ── 프로젝트/할 일 ───────────────────────────────── */

export function getProjects(): Project[] {
  return load(PROJECTS_KEY, SEED_PROJECTS).sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export function updateProject(id: string, patch: Partial<Pick<Project, "status" | "progress" | "owner" | "dueDate">>) {
  const projects = load(PROJECTS_KEY, SEED_PROJECTS).map((p) =>
    p.id === id ? { ...p, ...patch, progress: Math.min(100, Math.max(0, patch.progress ?? p.progress)) } : p
  );
  save(PROJECTS_KEY, projects);
}

export function getTasks(): WorkTask[] {
  return load(TASKS_KEY, SEED_TASKS).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function addTask(input: Omit<WorkTask, "id" | "status" | "createdAt"> & { status?: WorkTaskStatus }): WorkTask {
  const task: WorkTask = {
    ...input,
    id: nextId("TSK", TASKS_KEY, SEED_TASKS),
    status: input.status ?? "대기",
    createdAt: new Date().toISOString(),
  };
  const tasks = load(TASKS_KEY, SEED_TASKS);
  tasks.push(task);
  save(TASKS_KEY, tasks);
  return task;
}

export function updateTaskStatus(id: string, status: WorkTaskStatus) {
  const tasks = load(TASKS_KEY, SEED_TASKS).map((task) => (task.id === id ? { ...task, status } : task));
  save(TASKS_KEY, tasks);
}

/* ── 매출/세금계산서 ──────────────────────────────── */

export function getTaxInvoices(): TaxInvoice[] {
  return load(INVOICES_KEY, SEED_INVOICES).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addTaxInvoice(input: Omit<TaxInvoice, "id" | "vat" | "total" | "status" | "createdAt"> & { status?: TaxInvoiceStatus }): TaxInvoice {
  const supplyAmount = Math.max(0, Math.round(input.supplyAmount));
  const invoice: TaxInvoice = {
    ...input,
    id: nextId("TAX", INVOICES_KEY, SEED_INVOICES),
    supplyAmount,
    vat: Math.round(supplyAmount * 0.1),
    total: Math.round(supplyAmount * 1.1),
    status: input.status ?? "작성",
    createdAt: new Date().toISOString(),
  };
  const invoices = load(INVOICES_KEY, SEED_INVOICES);
  invoices.push(invoice);
  save(INVOICES_KEY, invoices);
  return invoice;
}

export function updateTaxInvoiceStatus(id: string, status: TaxInvoiceStatus) {
  const invoices = load(INVOICES_KEY, SEED_INVOICES).map((invoice) =>
    invoice.id === id
      ? {
          ...invoice,
          status,
          issuedAt: status === "발행완료" || status === "입금완료" ? invoice.issuedAt ?? new Date().toISOString() : invoice.issuedAt,
        }
      : invoice
  );
  save(INVOICES_KEY, invoices);
}

/* ── 일정 보고 ───────────────────────────────────── */

export function getDailyReports(): DailyReport[] {
  return load(REPORTS_KEY, SEED_REPORTS).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function generateDailyReport(): DailyReport {
  const projects = getProjects();
  const tasks = getTasks();
  const invoices = getTaxInvoices();
  const doneTaskCount = tasks.filter((task) => task.status === "완료").length;
  const pendingTaskCount = tasks.filter((task) => task.status !== "완료").length;
  const revenuePending = invoices
    .filter((invoice) => invoice.status !== "입금완료")
    .reduce((sum, invoice) => sum + invoice.total, 0);
  const activeProjects = projects.filter((project) => project.status === "진행").length;

  const report: DailyReport = {
    id: nextId("RPT", REPORTS_KEY, SEED_REPORTS),
    date: dateOnly(),
    projectCount: activeProjects,
    doneTaskCount,
    pendingTaskCount,
    revenuePending,
    summary: `진행 프로젝트 ${activeProjects}건, 완료 할 일 ${doneTaskCount}건, 미완료 할 일 ${pendingTaskCount}건, 미입금/미발행 매출 ${revenuePending.toLocaleString()}원입니다.`,
    createdAt: new Date().toISOString(),
  };

  const reports = load(REPORTS_KEY, SEED_REPORTS);
  reports.push(report);
  save(REPORTS_KEY, reports);
  return report;
}

export function getErpSnapshot() {
  const meetings = getMeetingRecords();
  const quotes = getQuotes();
  const projects = getProjects();
  const tasks = getTasks();
  const invoices = getTaxInvoices();
  const reports = getDailyReports();
  return {
    counts: {
      meetings: meetings.length,
      quoteDrafts: quotes.filter((quote) => quote.status === "초안" || quote.status === "발송").length,
      confirmedQuotes: quotes.filter((quote) => quote.status === "계약확정").length,
      activeProjects: projects.filter((project) => project.status === "진행").length,
      pendingTasks: tasks.filter((task) => task.status !== "완료").length,
      invoiceWaiting: invoices.filter((invoice) => invoice.status !== "입금완료").length,
    },
    revenue: {
      contracted: projects.reduce((sum, project) => sum + project.contractAmount, 0),
      invoiceTotal: invoices.reduce((sum, invoice) => sum + invoice.total, 0),
      unpaid: invoices.filter((invoice) => invoice.status !== "입금완료").reduce((sum, invoice) => sum + invoice.total, 0),
    },
    recentMeetings: meetings.slice(0, 3).map((meeting) => `${meeting.customer}: ${meeting.title}(${meeting.status})`),
    nextTasks: tasks.filter((task) => task.status !== "완료").slice(0, 5).map((task) => `${task.title} / ${task.owner} / ${task.dueDate} / ${task.status}`),
    recentReport: reports[0]?.summary ?? "",
  };
}
