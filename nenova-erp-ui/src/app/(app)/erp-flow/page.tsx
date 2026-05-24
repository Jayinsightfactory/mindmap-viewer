"use client";

import { useEffect, useMemo, useState } from "react";
import { getSession } from "@/lib/auth";
import {
  addTask,
  addMeetingRecord,
  confirmQuoteToProject,
  createQuoteFromMeeting,
  generateDailyReport,
  getCustomers,
  getDailyReports,
  getMeetingRecords,
  getProjects,
  getQuotes,
  getTasks,
  getTaxInvoices,
  updateProject,
  updateQuoteStatus,
  updateTaskStatus,
  updateTaxInvoiceStatus,
  type Customer,
  type DailyReport,
  type MeetingRecord,
  type Project,
  type ProjectStatus,
  type Quote,
  type QuoteStatus,
  type TaxInvoice,
  type TaxInvoiceStatus,
  type WorkTask,
  type WorkTaskStatus,
} from "@/lib/store";

const QUOTE_STATUSES: QuoteStatus[] = ["초안", "발송", "계약확정", "반려"];
const PROJECT_STATUSES: ProjectStatus[] = ["대기", "진행", "완료", "보류"];
const TASK_STATUSES: WorkTaskStatus[] = ["대기", "진행", "완료", "지연"];
const INVOICE_STATUSES: TaxInvoiceStatus[] = ["작성", "발행요청", "발행완료", "입금완료"];

type ErpIntakeItem = {
  id: string;
  source: string;
  intent: string;
  category: string;
  suggestedEntity: "quote" | "task" | "inventory" | "finance" | "project" | "question";
  title: string;
  detail: string;
  customer?: string;
  owner: string;
  accountId?: string;
  team?: string;
  conversationName?: string;
  status: "초안" | "승인대기" | "전환완료" | "보류";
  dueDate?: string;
  createdAt: string;
};

const STATUS_STYLE: Record<string, string> = {
  기록: "bg-slate-100 text-slate-600",
  견적생성: "bg-blue-50 text-brand",
  보류: "bg-amber-100 text-amber-700",
  초안: "bg-slate-100 text-slate-600",
  발송: "bg-blue-50 text-brand",
  계약확정: "bg-green-50 text-green-700",
  반려: "bg-red-50 text-red-700",
  대기: "bg-slate-100 text-slate-600",
  진행: "bg-blue-50 text-brand",
  완료: "bg-green-50 text-green-700",
  지연: "bg-red-50 text-red-700",
  작성: "bg-slate-100 text-slate-600",
  발행요청: "bg-amber-100 text-amber-700",
  발행완료: "bg-blue-50 text-brand",
  입금완료: "bg-green-50 text-green-700",
};

function formatWon(value: number) {
  return `${value.toLocaleString()}원`;
}

function defaultDueDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function ErpFlowPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [invoices, setInvoices] = useState<TaxInvoice[]>([]);
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [intakeItems, setIntakeItems] = useState<ErpIntakeItem[]>([]);
  const [showMeetingForm, setShowMeetingForm] = useState(false);

  const [customer, setCustomer] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [formError, setFormError] = useState("");

  function refresh() {
    setCustomers(getCustomers());
    setMeetings(getMeetingRecords());
    setQuotes(getQuotes());
    setProjects(getProjects());
    setTasks(getTasks());
    setInvoices(getTaxInvoices());
    setReports(getDailyReports());
    void refreshIntake();
  }

  async function refreshIntake() {
    try {
      const response = await fetch("/api/erp/intake", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { items?: ErpIntakeItem[] };
      setIntakeItems(data.items ?? []);
    } catch {
      setIntakeItems([]);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const stats = useMemo(() => {
    const openQuotes = quotes.filter((quote) => quote.status === "초안" || quote.status === "발송").length;
    const activeProjects = projects.filter((project) => project.status === "진행").length;
    const openTasks = tasks.filter((task) => task.status !== "완료").length;
    const invoiceWaiting = invoices.filter((invoice) => invoice.status !== "입금완료").length;
    const contracted = projects.reduce((sum, project) => sum + project.contractAmount, 0);
    const unpaid = invoices.filter((invoice) => invoice.status !== "입금완료").reduce((sum, invoice) => sum + invoice.total, 0);
    return [
      { label: "회의/녹음 기록", value: meetings.length.toLocaleString(), detail: "견적 전환 가능한 기록" },
      { label: "진행 견적", value: openQuotes.toLocaleString(), detail: "초안/발송 상태" },
      { label: "진행 프로젝트", value: activeProjects.toLocaleString(), detail: "계약 확정 후 실행" },
      { label: "미완료 할 일", value: openTasks.toLocaleString(), detail: "담당자 배정 업무" },
      { label: "계약 매출", value: formatWon(contracted), detail: "프로젝트 계약 공급가" },
      { label: "미입금/대기", value: formatWon(unpaid), detail: `${invoiceWaiting}건 세금계산서` },
    ];
  }, [invoices, meetings.length, projects, quotes, tasks]);

  function resetMeetingForm() {
    setCustomer("");
    setTitle("");
    setSummary("");
    setFormError("");
  }

  function handleCreateMeeting(e: React.FormEvent) {
    e.preventDefault();
    if (!customer.trim() || !title.trim()) {
      setFormError("고객사와 회의 제목을 입력하세요.");
      return;
    }
    addMeetingRecord({
      customer: customer.trim(),
      title: title.trim(),
      summary: summary.trim(),
      owner: getSession()?.name ?? "미지정",
    });
    resetMeetingForm();
    setShowMeetingForm(false);
    refresh();
  }

  function handleCreateQuote(meeting: MeetingRecord) {
    const amountText = prompt(`${meeting.customer} 견적 공급가`, "1000000");
    if (amountText == null) return;
    const amount = Number(amountText.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("공급가는 1 이상의 숫자로 입력하세요.");
      return;
    }
    const dueDate = prompt("견적 유효/계약 목표일", defaultDueDate(7)) || defaultDueDate(7);
    createQuoteFromMeeting(meeting.id, amount, dueDate, getSession()?.name ?? meeting.owner);
    refresh();
  }

  function handleConfirmQuote(quote: Quote) {
    if (!confirm(`${quote.customer} 견적을 계약 확정하고 프로젝트/할 일/세금계산서를 생성할까요?`)) return;
    confirmQuoteToProject(quote.id, getSession()?.name ?? quote.owner);
    refresh();
  }

  function handleGenerateReport() {
    generateDailyReport();
    refresh();
  }

  async function updateIntakeStatus(id: string, status: ErpIntakeItem["status"]) {
    await fetch("/api/erp/intake", {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ id, status }),
    });
    await refreshIntake();
  }

  async function handleConvertIntake(item: ErpIntakeItem) {
    const owner = getSession()?.name ?? item.owner ?? "미지정";
    if (item.suggestedEntity === "quote" || item.category === "견적") {
      addMeetingRecord({
        customer: item.customer || item.conversationName || "미지정",
        title: item.title,
        summary: item.detail,
        owner,
      });
    } else {
      addTask({
        title: item.title,
        owner,
        dueDate: item.dueDate || defaultDueDate(1),
        source: `${item.source} 수신`,
      });
    }
    await updateIntakeStatus(item.id, "전환완료");
    refresh();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-brand">ERP 실행 흐름</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              회의록에서 견적, 계약, 프로젝트, 할 일, 세금계산서까지 이어집니다.
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              이 화면은 단순 기획 카드가 아니라 실제 저장되는 업무 흐름입니다. 회의 기록을 만들고 견적을 생성한 뒤 계약 확정하면
              프로젝트, 담당자 할 일, 세금계산서 초안이 자동으로 생깁니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleGenerateReport}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              일일 보고 생성
            </button>
            <button
              onClick={() => {
                resetMeetingForm();
                setShowMeetingForm((value) => !value);
              }}
              className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              {showMeetingForm ? "닫기" : "회의/녹음 등록"}
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {stats.map((stat) => (
          <article key={stat.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium text-slate-500">{stat.label}</div>
            <div className="mt-1 text-xl font-semibold text-slate-950">{stat.value}</div>
            <div className="mt-2 text-xs leading-5 text-slate-500">{stat.detail}</div>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="font-semibold text-slate-900">카카오워크 ERP 수신함</h3>
            <p className="mt-1 text-sm text-slate-500">워크 대화에서 들어온 견적/할 일/재고/정산 요청을 실제 ERP 기록으로 전환합니다.</p>
          </div>
          <button
            type="button"
            onClick={() => void refreshIntake()}
            className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            수신함 동기화
          </button>
        </div>
        <div className="divide-y divide-slate-100">
          {intakeItems.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-400">수신된 ERP 초안이 없습니다.</div>}
          {intakeItems.slice(0, 6).map((item) => (
            <article key={item.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{item.source}</span>
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-brand">{item.category}</span>
                    <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLE[item.status] || "bg-slate-100 text-slate-600"}`}>{item.status}</span>
                    {item.accountId && <span className="font-mono text-slate-400">{item.accountId}</span>}
                  </div>
                  <h4 className="mt-2 font-semibold text-slate-900">{item.title}</h4>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{item.detail}</p>
                  <div className="mt-2 text-xs text-slate-500">
                    {item.owner} · {item.conversationName || item.team || "채널 미지정"} · 목표일 {item.dueDate || "-"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleConvertIntake(item)}
                    disabled={item.status === "전환완료"}
                    className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200"
                  >
                    {item.suggestedEntity === "quote" ? "회의/견적 후보 등록" : "할 일 등록"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateIntakeStatus(item.id, item.status === "보류" ? "초안" : "보류")}
                    className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    {item.status === "보류" ? "초안 복귀" : "보류"}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {showMeetingForm && (
        <form onSubmit={handleCreateMeeting} className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-semibold text-slate-900">회의/녹음 기록 등록</h3>
          <div className="mt-4 grid gap-4 md:grid-cols-[0.7fr_1fr]">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">고객사</label>
              <input
                list="erp-customer-list"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                placeholder="고객사 선택 또는 입력"
              />
              <datalist id="erp-customer-list">
                {customers.map((item) => (
                  <option key={item.id} value={item.name} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">회의 제목</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                placeholder="예: 자동화 도입 상담"
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-sm font-medium text-slate-700">요약/후속 요청</label>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
                className="w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                placeholder="회의 핵심, 견적 요청, 담당자에게 넘길 할 일을 적습니다."
              />
            </div>
          </div>
          {formError && <p className="mt-3 text-sm text-red-600">{formError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowMeetingForm(false)}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              취소
            </button>
            <button type="submit" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              저장
            </button>
          </div>
        </form>
      )}

      <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="font-semibold text-slate-900">회의/녹음 기록</h3>
            <p className="mt-1 text-sm text-slate-500">기록을 견적으로 전환하면 팔로업 할 일이 자동 생성됩니다.</p>
          </div>
          <div className="divide-y divide-slate-100">
            {meetings.map((meeting) => (
              <article key={meeting.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{meeting.title}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {meeting.customer} · {meeting.owner} · {meeting.recordedAt.slice(0, 10)}
                    </div>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[meeting.status]}`}>
                    {meeting.status}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-600">{meeting.summary || "요약 없음"}</p>
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={() => handleCreateQuote(meeting)}
                    disabled={Boolean(meeting.quoteId)}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
                  >
                    {meeting.quoteId ? `견적 연결 ${meeting.quoteId}` : "견적 생성"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="font-semibold text-slate-900">견적/계약</h3>
            <p className="mt-1 text-sm text-slate-500">계약 확정 시 프로젝트, 할 일, 세금계산서가 함께 생성됩니다.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-3 font-medium">견적번호</th>
                  <th className="px-4 py-3 font-medium">고객/제목</th>
                  <th className="px-4 py-3 text-right font-medium">공급가</th>
                  <th className="px-4 py-3 font-medium">상태</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((quote) => (
                  <tr key={quote.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{quote.id}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{quote.customer}</div>
                      <div className="text-xs text-slate-500">{quote.title}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-800">{formatWon(quote.amount)}</td>
                    <td className="px-4 py-3">
                      <select
                        value={quote.status}
                        onChange={(e) => {
                          updateQuoteStatus(quote.id, e.target.value as QuoteStatus);
                          refresh();
                        }}
                        className={`rounded-full border-0 px-2 py-1 text-xs font-medium outline-none ${STATUS_STYLE[quote.status]}`}
                      >
                        {QUOTE_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleConfirmQuote(quote)}
                        disabled={quote.status === "계약확정"}
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200"
                      >
                        계약 확정
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-semibold text-slate-900">프로젝트</h3>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {projects.map((project) => (
              <article key={project.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono text-slate-400">{project.id}</div>
                    <h4 className="mt-1 font-semibold text-slate-900">{project.title}</h4>
                    <p className="mt-1 text-xs text-slate-500">
                      {project.customer} · {project.owner} · {project.dueDate}
                    </p>
                  </div>
                  <select
                    value={project.status}
                    onChange={(e) => {
                      updateProject(project.id, { status: e.target.value as ProjectStatus });
                      refresh();
                    }}
                    className={`rounded-full border-0 px-2 py-1 text-xs font-medium outline-none ${STATUS_STYLE[project.status]}`}
                  >
                    {PROJECT_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mt-4">
                  <div className="mb-2 flex justify-between text-xs text-slate-500">
                    <span>진행률</span>
                    <span>{project.progress}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={project.progress}
                    onChange={(e) => {
                      updateProject(project.id, { progress: Number(e.target.value) });
                      refresh();
                    }}
                    className="w-full"
                  />
                </div>
                <div className="mt-3 text-sm font-semibold text-slate-900">{formatWon(project.contractAmount)}</div>
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="font-semibold text-slate-900">담당자 할 일</h3>
          </div>
          <div className="divide-y divide-slate-100">
            {tasks.map((task) => (
              <div key={task.id} className="flex items-start justify-between gap-3 px-5 py-4">
                <div>
                  <div className="text-sm font-medium text-slate-900">{task.title}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {task.owner} · {task.dueDate} · {task.source}
                  </div>
                </div>
                <select
                  value={task.status}
                  onChange={(e) => {
                    updateTaskStatus(task.id, e.target.value as WorkTaskStatus);
                    refresh();
                  }}
                  className={`shrink-0 rounded-full border-0 px-2 py-1 text-xs font-medium outline-none ${STATUS_STYLE[task.status]}`}
                >
                  {TASK_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_0.8fr]">
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="font-semibold text-slate-900">매출/세금계산서</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-3 font-medium">번호</th>
                  <th className="px-4 py-3 font-medium">고객</th>
                  <th className="px-4 py-3 text-right font-medium">합계</th>
                  <th className="px-4 py-3 font-medium">상태</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{invoice.id}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{invoice.customer}</div>
                      <div className="text-xs text-slate-500">{invoice.memo}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-800">{formatWon(invoice.total)}</td>
                    <td className="px-4 py-3">
                      <select
                        value={invoice.status}
                        onChange={(e) => {
                          updateTaxInvoiceStatus(invoice.id, e.target.value as TaxInvoiceStatus);
                          refresh();
                        }}
                        className={`rounded-full border-0 px-2 py-1 text-xs font-medium outline-none ${STATUS_STYLE[invoice.status]}`}
                      >
                        {INVOICE_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="font-semibold text-slate-900">일일 진행 보고</h3>
          </div>
          <div className="divide-y divide-slate-100">
            {reports.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-400">아직 생성된 보고가 없습니다.</div>}
            {reports.map((report) => (
              <article key={report.id} className="px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold text-slate-900">{report.date}</div>
                  <span className="font-mono text-xs text-slate-400">{report.id}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600">{report.summary}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
