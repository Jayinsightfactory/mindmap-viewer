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
  transferStatus?: ProductTransferStatus;
  transferMemo?: string;
  updatedAt?: string;
};

export type ProductTransferStatus = "미요청" | "송금대기" | "송금완료";
export type ProductChangeKind = "입고" | "출고" | "단가변경" | "송금상태" | "품목등록";

export type ProductChangeRecord = {
  id: string;
  sku: string;
  productName: string;
  kind: ProductChangeKind;
  before: string;
  after: string;
  memo: string;
  actor: string;
  changedAt: string;
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
export type WorkUnitSource = "nenova.exe" | "KakaoTalk" | "KakaoWork" | "GoogleSheet" | "nenovaweb" | "Mindmap" | "PC";
export type WorkUnitStatus = "수집" | "확인필요" | "진행중" | "완료" | "자동화후보";
export type WorkUnitCategory = "고객응대" | "견적" | "계약" | "프로젝트" | "할일" | "정산" | "재고" | "보고" | "AI검토" | "기타";
export type TalkWorkRelation = "대화후작업" | "작업후대화" | "동시진행" | "미연결";
export type CrossValidationStatus = "일치" | "부분일치" | "충돌" | "검증대기";

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

export type TalkEvent = {
  id: string;
  source: "KakaoTalk" | "KakaoWork";
  room: string;
  sender: string;
  sentAt: string;
  text: string;
  intent: string;
  relation: TalkWorkRelation;
};

export type WorkUnit = {
  id: string;
  employee: string;
  accountId: string;
  team: string;
  workArea: string;
  source: WorkUnitSource;
  category: WorkUnitCategory;
  title: string;
  detail: string;
  appName: string;
  windowTitle: string;
  clickCount: number;
  clickEvidence: string[];
  customer?: string;
  projectId?: string;
  taskId?: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  status: WorkUnitStatus;
  confidence: number;
  evidence: string[];
  pcEvidence: string[];
  relatedTalks: TalkEvent[];
  talkRelation: TalkWorkRelation;
  validationStatus: CrossValidationStatus;
  validationMemo: string;
  nextAction: string;
  automationCandidate: boolean;
};

const ORDERS_KEY = "nenova_orders";
const PRODUCTS_KEY = "nenova_products";
const PRODUCT_CHANGES_KEY = "nenova_product_changes";
const CUSTOMERS_KEY = "nenova_customers";
const MEETINGS_KEY = "nenova_meetings";
const QUOTES_KEY = "nenova_quotes";
const PROJECTS_KEY = "nenova_projects";
const TASKS_KEY = "nenova_tasks";
const INVOICES_KEY = "nenova_tax_invoices";
const REPORTS_KEY = "nenova_daily_reports";
const WORK_UNITS_KEY = "nenova_work_units";

const SEED_ORDERS: Order[] = [
  { id: "ORD-20260518-001", customer: "대한상사", item: "정밀 베어링 6204", qty: 120, status: "완료", owner: "설연주", memo: "정기 납품", createdAt: "2026-05-18T01:12:00.000Z" },
  { id: "ORD-20260519-002", customer: "한빛테크", item: "유압 실린더 50mm", qty: 8, status: "처리중", owner: "설연주", memo: "납기 5/25", createdAt: "2026-05-19T02:40:00.000Z" },
  { id: "ORD-20260519-003", customer: "성진ENG", item: "스테인리스 볼트 M8", qty: 2000, status: "접수", owner: "강현우", memo: "", createdAt: "2026-05-19T05:05:00.000Z" },
  { id: "ORD-20260520-004", customer: "대한상사", item: "오링 NBR 20호", qty: 500, status: "접수", owner: "설연주", memo: "긴급", createdAt: "2026-05-20T00:30:00.000Z" },
];

const SEED_PRODUCTS: Product[] = [
  { sku: "BR-6204", name: "정밀 베어링 6204", stock: 42, safetyStock: 50, unitPrice: 3200, transferStatus: "송금완료", transferMemo: "5월 정기 입고분" },
  { sku: "HC-50", name: "유압 실린더 50mm", stock: 15, safetyStock: 5, unitPrice: 84000, transferStatus: "송금대기", transferMemo: "공급사 확인 후 송금" },
  { sku: "BT-M8", name: "스테인리스 볼트 M8", stock: 18400, safetyStock: 5000, unitPrice: 90, transferStatus: "미요청", transferMemo: "" },
  { sku: "OR-NBR20", name: "오링 NBR 20호", stock: 320, safetyStock: 400, unitPrice: 150, transferStatus: "송금완료", transferMemo: "입고 완료" },
  { sku: "VL-2W", name: "솔레노이드 밸브 2way", stock: 7, safetyStock: 10, unitPrice: 21000, transferStatus: "송금대기", transferMemo: "잔금 대기" },
];

const SEED_PRODUCT_CHANGES: ProductChangeRecord[] = [
  {
    id: "PCH-20260522-001",
    sku: "BR-6204",
    productName: "정밀 베어링 6204",
    kind: "단가변경",
    before: "3,000원",
    after: "3,200원",
    memo: "6월 공급 단가 인상 반영",
    actor: "설연주",
    changedAt: "2026-05-22T02:20:00.000Z",
  },
  {
    id: "PCH-20260522-002",
    sku: "HC-50",
    productName: "유압 실린더 50mm",
    kind: "송금상태",
    before: "미요청",
    after: "송금대기",
    memo: "입고 확인 후 송금 요청 대기",
    actor: "강현우",
    changedAt: "2026-05-22T04:15:00.000Z",
  },
  {
    id: "PCH-20260523-001",
    sku: "OR-NBR20",
    productName: "오링 NBR 20호",
    kind: "입고",
    before: "180개",
    after: "320개",
    memo: "대한상사 긴급 납품 대비 입고",
    actor: "설연주",
    changedAt: "2026-05-23T01:35:00.000Z",
  },
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

const SEED_WORK_UNITS: WorkUnit[] = [
  {
    id: "WU-20260524-001",
    employee: "설연주",
    accountId: "nenova:sales-support:sul-yeonju",
    team: "영업지원",
    workArea: "견적/거래처 단가",
    source: "nenova.exe",
    category: "견적",
    title: "대한상사 견적 단가표 입력",
    detail: "nenova.exe 견적관리 화면에서 베어링/오링 단가와 수량을 입력하고 발송 전 금액을 검토했습니다.",
    appName: "nenova.exe",
    windowTitle: "견적관리 - 거래처 단가",
    clickCount: 34,
    clickEvidence: ["09:10 거래처 검색", "09:14 품목 행 추가", "09:24 공급가 입력", "09:31 견적 저장"],
    customer: "대한상사",
    taskId: "TSK-20260520-002",
    startedAt: "2026-05-24T00:10:00.000Z",
    endedAt: "2026-05-24T00:32:00.000Z",
    durationMin: 22,
    status: "진행중",
    confidence: 88,
    evidence: ["active_app=nenova.exe", "window_title=견적관리", "task=견적 팔로업"],
    pcEvidence: ["screen=견적관리", "keyboard=단가/수량 입력", "mouse=품목 행 반복 클릭", "app_focus=nenova.exe 22분"],
    relatedTalks: [
      {
        id: "KT-20260524-001",
        source: "KakaoTalk",
        room: "대한상사",
        sender: "김철수 과장",
        sentAt: "2026-05-24T00:07:00.000Z",
        text: "6월 베어링/오링 단가표 오늘 받을 수 있을까요?",
        intent: "quote_request",
        relation: "대화후작업",
      },
      {
        id: "KT-20260524-002",
        source: "KakaoTalk",
        room: "대한상사",
        sender: "설연주",
        sentAt: "2026-05-24T00:35:00.000Z",
        text: "견적 확인해서 발송 준비하겠습니다.",
        intent: "follow_up",
        relation: "작업후대화",
      },
    ],
    talkRelation: "대화후작업",
    validationStatus: "일치",
    validationMemo: "카카오톡 견적 요청 3분 뒤 nenova.exe 견적관리 작업이 시작되고, 작업 종료 후 회신 대화가 이어졌습니다.",
    nextAction: "견적 발송 여부를 확인하고 3일 후 팔로업 할 일을 자동 생성합니다.",
    automationCandidate: true,
  },
  {
    id: "WU-20260524-002",
    employee: "강현우",
    accountId: "nenova:sales-support:kang-hyunwoo",
    team: "영업지원",
    workArea: "재고/출고 확인",
    source: "nenova.exe",
    category: "재고",
    title: "한빛테크 출고 가능 재고 확인",
    detail: "프로젝트 납기 전 유압 실린더 재고와 출고 가능 수량을 확인했습니다.",
    appName: "nenova.exe",
    windowTitle: "재고조회 - 유압 실린더",
    clickCount: 18,
    clickEvidence: ["10:05 품목 검색", "10:09 창고별 재고 탭", "10:15 출고 가능 수량 확인"],
    customer: "한빛테크",
    projectId: "PRJ-20260519-001",
    taskId: "TSK-20260519-001",
    startedAt: "2026-05-24T01:05:00.000Z",
    endedAt: "2026-05-24T01:18:00.000Z",
    durationMin: 13,
    status: "완료",
    confidence: 91,
    evidence: ["project=PRJ-20260519-001", "window_title=재고조회", "mouse_clicks=18"],
    pcEvidence: ["screen=재고조회", "app_focus=nenova.exe 13분", "mouse=창고 탭 이동", "erp_task=출고 가능 재고 확인"],
    relatedTalks: [
      {
        id: "KT-20260524-003",
        source: "KakaoTalk",
        room: "한빛테크",
        sender: "이영희 대리",
        sentAt: "2026-05-24T01:01:00.000Z",
        text: "유압 실린더 이번 주 출고 가능한 수량 확인 부탁드립니다.",
        intent: "inventory_check",
        relation: "대화후작업",
      },
    ],
    talkRelation: "대화후작업",
    validationStatus: "일치",
    validationMemo: "고객 카톡 요청, ERP 프로젝트, PC 재고조회 화면이 같은 고객/품목으로 맞습니다.",
    nextAction: "출고 일정과 세금계산서 발행요청 상태를 같이 확인합니다.",
    automationCandidate: false,
  },
  {
    id: "WU-20260524-003",
    employee: "박성수",
    accountId: "nenova:sales:park-sungsu",
    team: "영업팀",
    workArea: "고객응대/상담",
    source: "KakaoTalk",
    category: "고객응대",
    title: "우진산업 자동화 상담 회신",
    detail: "카카오워크 프로젝트 대화에서 자동화 상담 후속 자료 요청과 미팅 일정 후보를 정리했습니다.",
    appName: "KakaoTalk",
    windowTitle: "우진산업 프로젝트 채널",
    clickCount: 9,
    clickEvidence: ["10:40 우진산업 채팅방 전환", "10:46 파일 요청 메시지 작성", "10:53 일정 후보 확인"],
    customer: "우진산업",
    startedAt: "2026-05-24T01:40:00.000Z",
    endedAt: "2026-05-24T01:55:00.000Z",
    durationMin: 15,
    status: "확인필요",
    confidence: 76,
    evidence: ["source=KakaoTalk", "intent=follow_up", "customer=우진산업"],
    pcEvidence: ["app_focus=KakaoTalk 15분", "screen=프로젝트 채팅", "keyboard=자료 요청/일정 후보"],
    relatedTalks: [
      {
        id: "KT-20260524-004",
        source: "KakaoTalk",
        room: "우진산업",
        sender: "최지은 사원",
        sentAt: "2026-05-24T01:41:00.000Z",
        text: "자동화 상담 자료는 어떤 양식으로 보내면 될까요?",
        intent: "material_request",
        relation: "동시진행",
      },
      {
        id: "KT-20260524-005",
        source: "KakaoTalk",
        room: "우진산업",
        sender: "박성수",
        sentAt: "2026-05-24T01:54:00.000Z",
        text: "샘플 파일과 현재 처리 절차를 보내주시면 견적 범위를 잡겠습니다.",
        intent: "follow_up",
        relation: "작업후대화",
      },
    ],
    talkRelation: "동시진행",
    validationStatus: "부분일치",
    validationMemo: "대화와 PC 작업은 일치하지만 아직 nenovaweb 회의/견적 항목으로 전환되지 않아 확인이 필요합니다.",
    nextAction: "회의/녹음 기록으로 전환하거나 견적 후보로 분류합니다.",
    automationCandidate: true,
  },
  {
    id: "WU-20260524-004",
    employee: "임재용",
    accountId: "nenova:ops:lim-jaeyong",
    team: "운영",
    workArea: "계약/프로젝트 전환",
    source: "nenovaweb",
    category: "계약",
    title: "견적 계약 확정 검토",
    detail: "계약 확정 전 공급가, VAT, 프로젝트 생성 조건, 담당자 배정을 점검했습니다.",
    appName: "Chrome",
    windowTitle: "NENOVAWEB - ERP 흐름",
    clickCount: 12,
    clickEvidence: ["11:00 ERP 흐름 진입", "11:04 견적 상태 확인", "11:12 계약 확정 조건 검토"],
    customer: "대한상사",
    startedAt: "2026-05-24T02:00:00.000Z",
    endedAt: "2026-05-24T02:17:00.000Z",
    durationMin: 17,
    status: "수집",
    confidence: 82,
    evidence: ["page=/erp-flow", "quote_status=발송", "assistant_context=ERP snapshot"],
    pcEvidence: ["screen=NENOVAWEB ERP 흐름", "browser=/erp-flow", "mouse=계약 확정 버튼 주변", "erp_snapshot=견적 발송"],
    relatedTalks: [
      {
        id: "KW-20260524-001",
        source: "KakaoWork",
        room: "운영-계약",
        sender: "임재용",
        sentAt: "2026-05-24T02:18:00.000Z",
        text: "대한상사 견적은 계약 전 공급가와 납기만 다시 확인하겠습니다.",
        intent: "approval_check",
        relation: "작업후대화",
      },
    ],
    talkRelation: "작업후대화",
    validationStatus: "부분일치",
    validationMemo: "ERP 화면 작업 뒤 워크 대화가 이어졌지만 고객사의 외부 카카오톡 회신은 아직 연결되지 않았습니다.",
    nextAction: "계약 확정 시 프로젝트/할 일/세금계산서를 자동 생성합니다.",
    automationCandidate: false,
  },
  {
    id: "WU-20260524-005",
    employee: "설연주",
    accountId: "nenova:sales-support:sul-yeonju",
    team: "영업지원",
    workArea: "정산/입금 대조",
    source: "GoogleSheet",
    category: "정산",
    title: "입금 내역과 세금계산서 대조",
    detail: "구글시트 입금 기록과 nenovaweb 세금계산서 상태를 맞춰 미입금 건을 분리했습니다.",
    appName: "Google Sheets",
    windowTitle: "Nenova 입금관리",
    clickCount: 27,
    clickEvidence: ["11:25 입금관리 시트 필터", "11:36 세금계산서 상태 대조", "11:45 미입금 행 표시"],
    startedAt: "2026-05-24T02:25:00.000Z",
    endedAt: "2026-05-24T02:47:00.000Z",
    durationMin: 22,
    status: "자동화후보",
    confidence: 84,
    evidence: ["sheet=입금관리", "invoice_status=발행요청", "repeat_pattern=월말정산"],
    pcEvidence: ["screen=Google Sheets", "browser=입금관리", "mouse=필터/상태 셀 클릭", "erp_invoice=발행요청"],
    relatedTalks: [
      {
        id: "KW-20260524-002",
        source: "KakaoWork",
        room: "정산",
        sender: "회계",
        sentAt: "2026-05-24T02:22:00.000Z",
        text: "이번 주 미입금 건 확인해서 세금계산서 상태 업데이트 부탁드립니다.",
        intent: "finance_check",
        relation: "대화후작업",
      },
    ],
    talkRelation: "대화후작업",
    validationStatus: "일치",
    validationMemo: "정산 워크 요청, 시트 작업, nenovaweb 세금계산서 상태가 같은 흐름으로 연결됩니다.",
    nextAction: "입금 알림과 세금계산서 상태를 자동 대조하는 규칙을 만듭니다.",
    automationCandidate: true,
  },
  {
    id: "WU-20260524-006",
    employee: "임재용",
    accountId: "nenova:ops:lim-jaeyong",
    team: "운영",
    workArea: "AI검토/보고",
    source: "Mindmap",
    category: "AI검토",
    title: "미팅록 요약과 후속 할 일 추출",
    detail: "녹음 기록 요약에서 견적 후보, 고객 요청, 담당자 할 일을 분리했습니다.",
    appName: "Claude",
    windowTitle: "AI 업무 콘솔",
    clickCount: 6,
    clickEvidence: ["12:05 AI 콘솔 질문", "12:12 요약 결과 확인", "12:18 할 일 후보 복사"],
    startedAt: "2026-05-24T03:05:00.000Z",
    endedAt: "2026-05-24T03:19:00.000Z",
    durationMin: 14,
    status: "수집",
    confidence: 79,
    evidence: ["source=screen.analyzed", "activity=AI검토", "meeting_to_task"],
    pcEvidence: ["screen=AI 업무 콘솔", "model=Claude", "activity=미팅록 요약", "output=task_candidates"],
    relatedTalks: [
      {
        id: "KW-20260524-003",
        source: "KakaoWork",
        room: "운영",
        sender: "임재용",
        sentAt: "2026-05-24T03:21:00.000Z",
        text: "회의록에서 나온 할 일 후보를 ERP 흐름에 연결해둘게요.",
        intent: "task_sync",
        relation: "작업후대화",
      },
    ],
    talkRelation: "작업후대화",
    validationStatus: "부분일치",
    validationMemo: "PC/AI 작업과 워크 보고는 맞지만 실제 ERP task 생성까지는 추가 확인이 필요합니다.",
    nextAction: "AI가 생성한 할 일을 ERP 흐름의 실제 task와 연결합니다.",
    automationCandidate: true,
  },
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

function withProductDefaults(product: Product): Product {
  const seed = SEED_PRODUCTS.find((p) => p.sku === product.sku);
  return {
    ...product,
    transferStatus: product.transferStatus ?? seed?.transferStatus ?? "미요청",
    transferMemo: product.transferMemo ?? seed?.transferMemo ?? "",
  };
}

function nextProductChangeId(existing: ProductChangeRecord[]) {
  const today = ymd();
  const count = existing.filter((item) => item.id.includes(today)).length + 1;
  return `PCH-${today}-${String(count).padStart(3, "0")}`;
}

function appendProductChanges(records: Omit<ProductChangeRecord, "id" | "changedAt">[]) {
  if (typeof window === "undefined" || records.length === 0) return;
  const existing = load(PRODUCT_CHANGES_KEY, SEED_PRODUCT_CHANGES);
  const stamped = records.map((record, index) => ({
    ...record,
    id: `PCH-${ymd()}-${String(existing.filter((item) => item.id.includes(ymd())).length + index + 1).padStart(3, "0")}`,
    changedAt: new Date().toISOString(),
  }));
  save(PRODUCT_CHANGES_KEY, [...existing, ...stamped]);
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

function durationMinutes(startedAt: string, endedAt: string, fallback = 1) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fallback;
  return Math.max(1, Math.round((end - start) / 60000));
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
  return load(PRODUCTS_KEY, SEED_PRODUCTS).map(withProductDefaults);
}

export function addProduct(input: Product): { ok: boolean; error?: string } {
  const products = load(PRODUCTS_KEY, SEED_PRODUCTS);
  if (products.some((p) => p.sku === input.sku)) {
    return { ok: false, error: "이미 존재하는 SKU입니다." };
  }
  const product = withProductDefaults({
    ...input,
    updatedAt: new Date().toISOString(),
  });
  products.push(product);
  save(PRODUCTS_KEY, products);
  appendProductChanges([
    {
      sku: product.sku,
      productName: product.name,
      kind: "품목등록",
      before: "-",
      after: `${product.stock.toLocaleString()}개 / ${product.unitPrice.toLocaleString()}원`,
      memo: product.transferMemo || "신규 품목 등록",
      actor: "nenovaweb",
    },
  ]);
  return { ok: true };
}

export function adjustStock(sku: string, delta: number, actor = "nenovaweb", memo = "") {
  let change: Omit<ProductChangeRecord, "id" | "changedAt"> | null = null;
  const products = load(PRODUCTS_KEY, SEED_PRODUCTS).map((p) => {
    if (p.sku !== sku) return p;
    const beforeStock = p.stock;
    const afterStock = Math.max(0, p.stock + delta);
    if (beforeStock !== afterStock) {
      change = {
        sku: p.sku,
        productName: p.name,
        kind: delta > 0 ? "입고" : "출고",
        before: `${beforeStock.toLocaleString()}개`,
        after: `${afterStock.toLocaleString()}개`,
        memo: memo || (delta > 0 ? "입고 수량 반영" : "출고 수량 반영"),
        actor,
      };
    }
    return { ...withProductDefaults(p), stock: afterStock, updatedAt: new Date().toISOString() };
  });
  save(PRODUCTS_KEY, products);
  if (change) appendProductChanges([change]);
}

export function updateProductCommercial(
  sku: string,
  input: { unitPrice: number; transferStatus: ProductTransferStatus; transferMemo?: string; actor?: string }
): { ok: boolean; error?: string; changes: number } {
  const products = load(PRODUCTS_KEY, SEED_PRODUCTS).map(withProductDefaults);
  const idx = products.findIndex((p) => p.sku === sku);
  if (idx < 0) return { ok: false, error: "품목을 찾을 수 없습니다.", changes: 0 };

  const current = products[idx];
  const nextPrice = Math.max(0, Math.round(input.unitPrice || 0));
  const nextTransferStatus = input.transferStatus;
  const nextMemo = input.transferMemo?.trim() ?? "";
  const actor = input.actor || "nenovaweb";
  const changes: Omit<ProductChangeRecord, "id" | "changedAt">[] = [];

  if (current.unitPrice !== nextPrice) {
    changes.push({
      sku: current.sku,
      productName: current.name,
      kind: "단가변경",
      before: `${current.unitPrice.toLocaleString()}원`,
      after: `${nextPrice.toLocaleString()}원`,
      memo: nextMemo || "입고 단가 변경",
      actor,
    });
  }

  if ((current.transferStatus ?? "미요청") !== nextTransferStatus) {
    changes.push({
      sku: current.sku,
      productName: current.name,
      kind: "송금상태",
      before: current.transferStatus ?? "미요청",
      after: nextTransferStatus,
      memo: nextMemo || "송금 상태 변경",
      actor,
    });
  }

  products[idx] = {
    ...current,
    unitPrice: nextPrice,
    transferStatus: nextTransferStatus,
    transferMemo: nextMemo,
    updatedAt: new Date().toISOString(),
  };
  save(PRODUCTS_KEY, products);
  appendProductChanges(changes);
  return { ok: true, changes: changes.length };
}

export function getProductChangeHistory(): ProductChangeRecord[] {
  return load(PRODUCT_CHANGES_KEY, SEED_PRODUCT_CHANGES).sort((a, b) => b.changedAt.localeCompare(a.changedAt));
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

/* ── 직원 작업 단위 / nenova.exe ─────────────────── */

function normalizeWorkUnit(unit: WorkUnit): WorkUnit {
  return {
    ...unit,
    accountId: unit.accountId ?? `${unit.team}:${unit.employee}`,
    workArea: unit.workArea ?? `${unit.category}/${unit.team}`,
    clickCount: unit.clickCount ?? 0,
    clickEvidence: unit.clickEvidence ?? [],
    pcEvidence: unit.pcEvidence ?? unit.evidence ?? [],
    relatedTalks: unit.relatedTalks ?? [],
    talkRelation: unit.talkRelation ?? "미연결",
    validationStatus: unit.validationStatus ?? "검증대기",
    validationMemo: unit.validationMemo ?? "카카오톡/PC/ERP 3차 교차검증 대기 중입니다.",
  };
}

export function getWorkUnits(): WorkUnit[] {
  return load(WORK_UNITS_KEY, SEED_WORK_UNITS)
    .map(normalizeWorkUnit)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function addWorkUnit(
  input: Omit<
    WorkUnit,
    | "id"
    | "accountId"
    | "workArea"
    | "clickCount"
    | "clickEvidence"
    | "durationMin"
    | "status"
    | "confidence"
    | "evidence"
    | "pcEvidence"
    | "relatedTalks"
    | "talkRelation"
    | "validationStatus"
    | "validationMemo"
    | "automationCandidate"
  > & {
    accountId?: string;
    workArea?: string;
    clickCount?: number;
    clickEvidence?: string[];
    durationMin?: number;
    status?: WorkUnitStatus;
    confidence?: number;
    evidence?: string[];
    pcEvidence?: string[];
    relatedTalks?: TalkEvent[];
    talkRelation?: TalkWorkRelation;
    validationStatus?: CrossValidationStatus;
    validationMemo?: string;
    automationCandidate?: boolean;
  },
): WorkUnit {
  const workUnit: WorkUnit = {
    ...input,
    id: nextId("WU", WORK_UNITS_KEY, SEED_WORK_UNITS),
    accountId: input.accountId ?? `${input.team}:${input.employee}`,
    workArea: input.workArea ?? `${input.category}/${input.team}`,
    clickCount: input.clickCount ?? 0,
    clickEvidence: input.clickEvidence ?? [],
    durationMin: input.durationMin ?? durationMinutes(input.startedAt, input.endedAt),
    status: input.status ?? "수집",
    confidence: Math.min(100, Math.max(0, input.confidence ?? 70)),
    evidence: input.evidence?.length ? input.evidence : [`source=${input.source}`, `app=${input.appName}`],
    pcEvidence: input.pcEvidence?.length ? input.pcEvidence : [`app=${input.appName}`, `window=${input.windowTitle}`],
    relatedTalks: input.relatedTalks ?? [],
    talkRelation: input.talkRelation ?? "미연결",
    validationStatus: input.validationStatus ?? "검증대기",
    validationMemo: input.validationMemo ?? "카카오톡/PC/ERP 3차 교차검증 대기 중입니다.",
    automationCandidate: input.automationCandidate ?? false,
  };
  const workUnits = load(WORK_UNITS_KEY, SEED_WORK_UNITS);
  workUnits.push(workUnit);
  save(WORK_UNITS_KEY, workUnits);
  return workUnit;
}

export function updateWorkUnitStatus(id: string, status: WorkUnitStatus) {
  const workUnits = load(WORK_UNITS_KEY, SEED_WORK_UNITS).map((unit) => (unit.id === id ? { ...unit, status } : unit));
  save(WORK_UNITS_KEY, workUnits);
}

export function getWorkUnitSnapshot() {
  const workUnits = getWorkUnits();
  const today = dateOnly();
  const todayUnits = workUnits.filter((unit) => unit.startedAt.slice(0, 10) === today);
  const targetUnits = todayUnits.length ? todayUnits : workUnits;
  const totalMinutes = targetUnits.reduce((sum, unit) => sum + unit.durationMin, 0);
  const employeeMap = targetUnits.reduce<
    Record<
      string,
      {
        accountId: string;
        team: string;
        minutes: number;
        count: number;
        latest: string;
        workAreas: Set<string>;
        clickCount: number;
        talkLinked: number;
        validated: number;
      }
    >
  >((acc, unit) => {
    const current = acc[unit.employee] ?? {
      accountId: unit.accountId,
      team: unit.team,
      minutes: 0,
      count: 0,
      latest: "",
      workAreas: new Set<string>(),
      clickCount: 0,
      talkLinked: 0,
      validated: 0,
    };
    current.minutes += unit.durationMin;
    current.count += 1;
    current.clickCount += unit.clickCount;
    current.workAreas.add(unit.workArea);
    if (unit.relatedTalks.length > 0 || unit.talkRelation !== "미연결") current.talkLinked += 1;
    if (unit.validationStatus === "일치") current.validated += 1;
    current.latest = current.latest && current.latest > unit.startedAt ? current.latest : unit.startedAt;
    acc[unit.employee] = current;
    return acc;
  }, {});

  return {
    counts: {
      todayUnits: todayUnits.length,
      totalUnits: workUnits.length,
      activeEmployees: Object.keys(employeeMap).length,
      reviewNeeded: workUnits.filter((unit) => unit.status === "확인필요").length,
      automationCandidates: workUnits.filter((unit) => unit.automationCandidate || unit.status === "자동화후보").length,
      talkLinked: workUnits.filter((unit) => unit.relatedTalks.length > 0 || unit.talkRelation !== "미연결").length,
      tripleValidated: workUnits.filter((unit) => unit.validationStatus === "일치").length,
      partialValidated: workUnits.filter((unit) => unit.validationStatus === "부분일치").length,
      validationConflicts: workUnits.filter((unit) => unit.validationStatus === "충돌").length,
    },
    time: {
      totalMinutes,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    },
    byEmployee: Object.entries(employeeMap)
      .map(([employee, item]) => ({
        employee,
        accountId: item.accountId,
        team: item.team,
        workAreas: Array.from(item.workAreas),
        minutes: item.minutes,
        count: item.count,
        latest: item.latest,
        clickCount: item.clickCount,
        talkLinked: item.talkLinked,
        validated: item.validated,
      }))
      .sort((a, b) => b.minutes - a.minutes),
    relationCounts: {
      talkBeforeWork: workUnits.filter((unit) => unit.talkRelation === "대화후작업").length,
      workBeforeTalk: workUnits.filter((unit) => unit.talkRelation === "작업후대화").length,
      simultaneous: workUnits.filter((unit) => unit.talkRelation === "동시진행").length,
      unlinked: workUnits.filter((unit) => unit.talkRelation === "미연결").length,
    },
    recentUnits: workUnits.slice(0, 6).map((unit) => ({
      id: unit.id,
      employee: unit.employee,
      accountId: unit.accountId,
      workArea: unit.workArea,
      title: unit.title,
      source: unit.source,
      durationMin: unit.durationMin,
      clickCount: unit.clickCount,
      talkRelation: unit.talkRelation,
      validationStatus: unit.validationStatus,
      status: unit.status,
      confidence: unit.confidence,
    })),
  };
}

export function getErpSnapshot() {
  const meetings = getMeetingRecords();
  const quotes = getQuotes();
  const projects = getProjects();
  const tasks = getTasks();
  const invoices = getTaxInvoices();
  const reports = getDailyReports();
  const workUnitSnapshot = getWorkUnitSnapshot();
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
    workUnits: workUnitSnapshot,
    recentReport: reports[0]?.summary ?? "",
  };
}
